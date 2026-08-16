import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  coalesceChatEvents,
  type ClaudeChatEvent,
  type ClaudeSessionMeta,
} from '../../claude/events';
import { ClaudeChatSession } from './chat-session';
import { PermissionBridge, type PermissionAnswer } from './permission-bridge';
import type { ClaudeExecutor } from './executor';

export interface ChatIndexStorage {
  read(): string | null;
  write(data: string): void;
}

export interface ChatRuntimeOpts {
  /** Provisioned workspace dir (cwd for the CLI; transcripts live under it). */
  dir: string;
  /** Session index storage (JsonFileStorage → claude-sessions.json). */
  storage: ChatIndexStorage;
  /** Push one event to the renderer. */
  emit: (e: ClaudeChatEvent) => void;
  /** For diff previews on write_file permission cards. */
  executor?: ClaudeExecutor;
}

const TITLE_MAX = 64;

/**
 * Chat-mode state in the main process: one active CLI conversation at a time,
 * the permission bridge feeding it, a metadata index for the history
 * dropdown, and per-session transcripts (our own rendered-event format — the
 * CLI's jsonl is internal and never read).
 */
export class ClaudeChatRuntime {
  readonly bridge: PermissionBridge;
  private active: ClaudeChatSession | null = null;
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

  private transcriptPath(sessionId: string): string {
    return join(this.opts.dir, 'transcripts', `${sessionId}.json`);
  }

  private saveTranscript(): void {
    const id = this.sessionId();
    if (!id) return;
    try {
      mkdirSync(join(this.opts.dir, 'transcripts'), { recursive: true });
      writeFileSync(this.transcriptPath(id), JSON.stringify(coalesceChatEvents(this.log)));
    } catch (err) {
      console.warn('[claude] transcript save failed:', err);
    }
  }

  // ---- IPC surface ---------------------------------------------------------

  send(text: string): void {
    if (!this.active) {
      this.active = new ClaudeChatSession({ dir: this.opts.dir, model: this.model }, (e) =>
        this.record(e),
      );
      this.log = [];
      this.pendingTitle = null;
    }
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
      events = JSON.parse(readFileSync(this.transcriptPath(sessionId), 'utf8'));
    } catch {
      events = [];
    }
    this.log = events;
    this.pendingTitle = null;
    this.active = new ClaudeChatSession(
      { dir: this.opts.dir, resume: sessionId, model: this.model },
      (e) => this.record(e),
    );
    return events;
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
