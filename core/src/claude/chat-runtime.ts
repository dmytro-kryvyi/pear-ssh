import {
  coalesceChatEvents,
  type ClaudeChatEvent,
  type ClaudeChatState,
  type ClaudeSessionMeta,
} from './events';
import { PermissionBridge, type PermissionAnswer } from './permission-bridge';
import type { ClaudeExecutor } from './executor';

export interface ChatIndexStorage {
  read(): string | null;
  write(data: string): void;
}

/** Persisted per-session transcripts (our rendered-event format). */
export interface ChatTranscriptStore {
  read(sessionId: string): string | null;
  write(sessionId: string, data: string): void;
}

/** One live CLI conversation, however it is transported (local child process
 *  on desktop, SSH exec channel on Android). */
export interface ChatSessionHandle {
  /** CLI session id once known (from the init event); primes --resume. */
  readonly sessionId: string | null;
  send(text: string): void;
  setModel(model: string | null): void;
  interrupt(): void;
  dispose(): void;
}

export type ChatSessionFactory = (
  opts: { resume?: string; model?: string | null },
  onEvent: (e: ClaudeChatEvent) => void,
) => ChatSessionHandle;

export interface ChatRuntimeOpts {
  /** Session index storage (claude-sessions.json). */
  storage: ChatIndexStorage;
  transcripts: ChatTranscriptStore;
  createSession: ChatSessionFactory;
  /** Push one event to the UI. */
  emit: (e: ClaudeChatEvent) => void;
  /** For diff previews on write_file permission cards. */
  executor?: ClaudeExecutor;
}

const TITLE_MAX = 64;

// Platform-pure module: no DOM/Node ambient types, but every runtime has this.
declare const console: { warn: (...args: unknown[]) => void };

/**
 * Chat-mode state, platform-pure: one active CLI conversation at a time, the
 * permission bridge feeding it, a metadata index for the history dropdown,
 * and per-session transcripts. How the CLI runs (child process vs SSH) and
 * where files live are both injected — desktop wraps this with node fs and
 * child_process, Android with Preferences and the PearSsh exec channel.
 */
export class ClaudeChatRuntime {
  readonly bridge: PermissionBridge;
  private active: ChatSessionHandle | null = null;
  private log: ClaudeChatEvent[] = [];
  private index: ClaudeSessionMeta[] = [];
  private pendingTitle: string | null = null;
  private model: string | null = null;

  constructor(private readonly opts: ChatRuntimeOpts) {
    this.bridge = new PermissionBridge((e) => this.record(e), opts.executor);
    try {
      this.index = JSON.parse(this.opts.storage.read() ?? '[]');
    } catch {
      this.index = [];
    }
  }

  /** Every event — from the CLI stream or the bridge — funnels through here. */
  private record(event: ClaudeChatEvent): void {
    this.log.push(event);
    this.updateIndex(event);
    if (event.type === 'turn-done') this.saveTranscript();
    this.opts.emit(event);
  }

  private sessionId(): string | null {
    return this.active?.sessionId ?? null;
  }

  private updateIndex(event: ClaudeChatEvent): void {
    if (event.type === 'user') {
      this.pendingTitle ??= event.text.replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX);
      const meta = this.index.find((m) => m.id === this.sessionId());
      if (meta) {
        meta.turns += 1;
        meta.lastUsedAt = Date.now();
        this.saveIndex();
      }
      return;
    }
    if (event.type === 'init') {
      let meta = this.index.find((m) => m.id === event.sessionId);
      if (!meta) {
        meta = {
          id: event.sessionId,
          title: this.pendingTitle ?? 'New session',
          createdAt: Date.now(),
          lastUsedAt: Date.now(),
          turns: 1,
          tokens: 0,
        };
        this.index.unshift(meta);
      } else {
        meta.lastUsedAt = Date.now();
      }
      this.saveIndex();
      return;
    }
    if (event.type === 'usage') {
      const meta = this.index.find((m) => m.id === this.sessionId());
      if (meta) {
        meta.tokens = event.contextTokens;
        this.saveIndex();
      }
    }
  }

  private saveIndex(): void {
    this.opts.storage.write(JSON.stringify(this.index, null, 2));
  }

  private saveTranscript(): void {
    const id = this.sessionId();
    if (!id) return;
    try {
      this.opts.transcripts.write(id, JSON.stringify(coalesceChatEvents(this.log)));
    } catch (err) {
      console.warn('[claude] transcript save failed:', err);
    }
  }

  // ---- API surface ---------------------------------------------------------

  send(text: string): void {
    if (!this.active) {
      this.active = this.opts.createSession({ model: this.model }, (e) => this.record(e));
      this.log = [];
      this.pendingTitle = null;
    }
    this.record({ type: 'user', text });
    this.active.send(text);
  }

  /** Applies to the next spawn; a running turn is stopped so the change
   *  lands on the next message (the CLI session resumes seamlessly). */
  setModel(model: string | null): void {
    if (model === this.model) return;
    this.model = model;
    this.active?.setModel(model);
    this.active?.interrupt();
    if (this.log.length) {
      this.record({ type: 'divider', text: `model → ${model ?? 'default'}` });
    }
  }

  interrupt(): void {
    this.bridge.denyAll();
    this.active?.interrupt();
  }

  /** Forget the active conversation (the next send starts a fresh session). */
  newSession(): void {
    this.bridge.denyAll();
    this.active?.dispose();
    this.active = null;
    this.log = [];
    this.pendingTitle = null;
  }

  sessions(): ClaudeSessionMeta[] {
    return [...this.index].sort((a, b) => b.lastUsedAt - a.lastUsedAt);
  }

  /** Loads a past session's transcript for re-render and primes --resume. */
  resume(sessionId: string): ClaudeChatEvent[] {
    this.bridge.denyAll();
    this.active?.dispose();
    let events: ClaudeChatEvent[] = [];
    try {
      events = JSON.parse(this.opts.transcripts.read(sessionId) ?? '[]');
    } catch {
      events = [];
    }
    this.log = events;
    this.pendingTitle = null;
    this.active = this.opts.createSession({ resume: sessionId, model: this.model }, (e) =>
      this.record(e),
    );
    return events;
  }

  /**
   * Read-only view for a client that just connected. Deliberately not
   * `resume()`: that one denies pending cards and restarts the CLI — fatal to
   * a turn that kept running while an iPad was asleep.
   */
  snapshot(): ClaudeChatState {
    let busy = false;
    for (const e of this.log) {
      if (e.type === 'user') busy = true;
      else if (e.type === 'turn-done') busy = false;
    }
    return {
      sessionId: this.sessionId(),
      events: coalesceChatEvents(this.log),
      busy: busy && this.active !== null,
      model: this.model,
      autoApprove: this.bridge.autoApproveOn,
    };
  }

  answer(requestId: string, answer: PermissionAnswer): void {
    this.bridge.answer(requestId, answer);
  }

  setAutoApprove(on: boolean): void {
    this.bridge.setAutoApprove(on);
  }

  dispose(): void {
    this.bridge.denyAll();
    this.saveTranscript();
    this.active?.dispose();
    this.active = null;
  }
}
