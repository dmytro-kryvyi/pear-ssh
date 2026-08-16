import { Injectable, computed, inject, signal } from '@angular/core';
import type {
  ClaudeChatEvent,
  ClaudeFileDiff,
  ClaudeQuestion,
  ClaudeSessionMeta,
} from '@pear/core';
import { Pear } from '../pear';
import { Settings } from '../settings';

export type ChatBlock =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'text'; id: string; text: string }
  | { kind: 'think'; id: string; text: string; secs: number | null }
  | {
      kind: 'tool';
      id: string;
      tool: string;
      display: string;
      status: 'running' | 'done' | 'error';
      output: string;
    }
  | {
      kind: 'permission';
      id: string;
      requestId: string;
      tool: string;
      display: string;
      diff?: ClaudeFileDiff;
      status: 'pending' | 'allow' | 'always' | 'deny';
    }
  | {
      kind: 'question';
      id: string;
      requestId: string;
      questions: ClaudeQuestion[];
      choices: Record<string, string> | null;
    }
  | { kind: 'divider'; id: string; text: string }
  | { kind: 'error'; id: string; text: string };

/** Context window by model id (claude-api reference, 2026-06): the current
 *  generation (Fable 5, Opus 4.6+, Sonnet 4.6/5) is 1M; Haiku 4.5 and older
 *  Sonnet/Opus snapshots are 200K. A literal "[1m]" marker always wins. */
export function contextWindowFor(model: string): number {
  const m = model.toLowerCase();
  if (m.includes('[1m]')) return 1_000_000;
  if (m.includes('haiku')) return 200_000;
  if (/sonnet-4-5|sonnet-4-0|opus-4-5|opus-4-1|opus-4-0|3-5|3-7/.test(m)) return 200_000;
  return 1_000_000;
}

/** Chat-mode state: folds claude:event pushes into a renderable block list. */
@Injectable({ providedIn: 'root' })
export class ClaudeChatStore {
  private readonly pear = inject(Pear);
  private readonly settings = inject(Settings);

  readonly blocks = signal<ChatBlock[]>([]);
  readonly busy = signal(false);
  readonly contextTokens = signal(0);
  readonly autoApprove = signal(false);
  readonly sessions = signal<ClaudeSessionMeta[]>([]);
  readonly activeSessionId = signal<string | null>(null);
  /** What the CLI reported (init event) or the user picked — for the meter row. */
  readonly model = signal('');
  readonly ctxMax = computed(() => contextWindowFor(this.model()));

  private nextId = 0;
  private started = false;

  /** Idempotent; the dock calls it when chat mode first renders. */
  start(): void {
    if (this.started || !this.pear.available) return;
    this.started = true;
    this.pear.api.claude.onEvent((event) => this.apply(event));
    const savedModel = this.settings.claudeModel();
    if (savedModel) {
      this.model.set(savedModel);
      this.pear.api.claude.chatSetModel(savedModel);
    }
    void this.loadSessions();
  }

  private id(): string {
    return 'c' + ++this.nextId;
  }

  private patch(mutate: (blocks: ChatBlock[]) => void): void {
    const next = this.blocks().slice();
    mutate(next);
    this.blocks.set(next);
  }

  private byBlockId = new Map<string, ChatBlock>();

  private apply(event: ClaudeChatEvent): void {
    switch (event.type) {
      case 'init':
        this.activeSessionId.set(event.sessionId);
        if (event.model) this.model.set(event.model);
        void this.loadSessions();
        return;
      case 'user':
        this.push({ kind: 'user', id: this.id(), text: event.text });
        this.busy.set(true);
        return;
      case 'text-delta': {
        const existing = this.byBlockId.get(event.blockId);
        if (existing?.kind === 'text') {
          existing.text += event.text;
          this.blocks.set(this.blocks().slice());
        } else {
          const block: ChatBlock = { kind: 'text', id: this.id(), text: event.text };
          this.byBlockId.set(event.blockId, block);
          this.push(block);
        }
        return;
      }
      case 'think-delta': {
        const existing = this.byBlockId.get(event.blockId);
        if (existing?.kind === 'think') {
          existing.text += event.text;
          this.blocks.set(this.blocks().slice());
        } else {
          const block: ChatBlock = { kind: 'think', id: this.id(), text: event.text, secs: null };
          this.byBlockId.set(event.blockId, block);
          this.push(block);
        }
        return;
      }
      case 'think-done': {
        const block = this.byBlockId.get(event.blockId);
        if (block?.kind === 'think') {
          block.secs = event.secs;
          this.blocks.set(this.blocks().slice());
        }
        return;
      }
      case 'tool-start': {
        const block: ChatBlock = {
          kind: 'tool',
          id: this.id(),
          tool: event.tool,
          display: event.display,
          status: 'running',
          output: '',
        };
        this.byBlockId.set(event.blockId, block);
        this.push(block);
        return;
      }
      case 'tool-end': {
        const block = this.byBlockId.get(event.blockId);
        if (block?.kind === 'tool') {
          block.status = event.status;
          block.output = event.output;
          this.blocks.set(this.blocks().slice());
        }
        return;
      }
      case 'permission':
        this.push({
          kind: 'permission',
          id: this.id(),
          requestId: event.requestId,
          tool: event.tool,
          display: event.display,
          ...(event.diff ? { diff: event.diff } : {}),
          status: 'pending',
        });
        return;
      case 'permission-resolved':
        this.patch((blocks) => {
          for (const b of blocks) {
            if (b.kind === 'permission' && b.requestId === event.requestId) {
              b.status = event.status;
            }
          }
        });
        return;
      case 'question':
        this.push({
          kind: 'question',
          id: this.id(),
          requestId: event.requestId,
          questions: event.questions,
          choices: null,
        });
        return;
      case 'question-answered':
        this.patch((blocks) => {
          for (const b of blocks) {
            if (b.kind === 'question' && b.requestId === event.requestId) {
              b.choices = event.choices;
            }
          }
        });
        return;
      case 'divider':
        this.push({ kind: 'divider', id: this.id(), text: event.text });
        return;
      case 'usage':
        this.contextTokens.set(event.contextTokens);
        return;
      case 'turn-done':
        this.busy.set(false);
        return;
      case 'error':
        this.push({ kind: 'error', id: this.id(), text: event.message });
        this.busy.set(false);
        return;
    }
  }

  private push(block: ChatBlock): void {
    this.patch((blocks) => blocks.push(block));
  }

  // ---- actions -------------------------------------------------------------

  async send(text: string): Promise<void> {
    // Slash commands are the interactive CLI's UX — map the useful ones onto
    // chat-mode equivalents instead of letting them die silently in -p mode.
    if (text.startsWith('/')) {
      this.handleSlash(text);
      return;
    }
    this.busy.set(true);
    try {
      await this.pear.api.claude.chatSend(text);
    } catch (err) {
      this.push({ kind: 'error', id: this.id(), text: cleanIpcError(err) });
      this.busy.set(false);
    }
  }

  private handleSlash(text: string): void {
    const [cmd, ...rest] = text.slice(1).split(/\s+/);
    const arg = rest.join(' ').trim();
    switch (cmd) {
      case 'clear':
        void this.newSession();
        return;
      case 'model':
        if (arg) this.setModel(arg);
        else {
          this.push({
            kind: 'error',
            id: this.id(),
            text: 'Pick a model from the menu in the context bar, or use /model <name> (e.g. /model sonnet).',
          });
        }
        return;
      default:
        this.push({
          kind: 'error',
          id: this.id(),
          text: `/${cmd} isn't available in chat mode — switch the dock to Terminal in Settings → Claude Code for the full CLI.`,
        });
    }
  }

  setModel(model: string | null): void {
    const value = model?.trim() || '';
    this.settings.claudeModel.set(value);
    this.model.set(value || '');
    this.pear.api.claude.chatSetModel(value || null);
  }

  interrupt(): void {
    this.pear.api.claude.chatInterrupt();
  }

  answerPermission(requestId: string, kind: 'allow' | 'always' | 'deny'): void {
    this.pear.api.claude.chatAnswer(requestId, { kind });
  }

  answerQuestion(requestId: string, choices: Record<string, string>): void {
    this.pear.api.claude.chatAnswer(requestId, { kind: 'answers', choices });
    this.patch((blocks) => {
      for (const b of blocks) {
        if (b.kind === 'question' && b.requestId === requestId) b.choices = choices;
      }
    });
  }

  setAutoApprove(on: boolean): void {
    this.autoApprove.set(on);
    this.pear.api.claude.chatSetAutoApprove(on);
  }

  async newSession(): Promise<void> {
    await this.pear.api.claude.chatNew();
    this.reset();
  }

  async resume(sessionId: string): Promise<void> {
    const events = await this.pear.api.claude.chatResume(sessionId);
    this.reset();
    this.activeSessionId.set(sessionId);
    for (const event of events) this.apply(event);
    this.busy.set(false);
  }

  async loadSessions(): Promise<void> {
    try {
      this.sessions.set(await this.pear.api.claude.chatSessions());
    } catch {
      this.sessions.set([]);
    }
  }

  private reset(): void {
    this.blocks.set([]);
    this.byBlockId.clear();
    this.busy.set(false);
    this.contextTokens.set(0);
    this.activeSessionId.set(null);
  }
}

function cleanIpcError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}
