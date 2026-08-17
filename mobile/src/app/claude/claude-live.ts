import { Injectable, inject, signal } from '@angular/core';
import type { ClaudeChatEvent, ClaudeQuestion, PearApi } from '@pear/core';
import { PEAR_BACKEND } from '../backend';
import type { MobileClaudeConfig } from '../native/backend';
import type { ClaudeMsg } from './claude-demo';
import type { ClaudeSessionRow, ClaudeStore } from './claude-store';

const MODEL_KEY = 'pear.claude.model';

function relTime(ms: number): string {
  const mins = Math.round((Date.now() - ms) / 60_000);
  if (mins < 2) return 'now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/**
 * The real Claude store: renders core's ClaudeChatEvent stream (the CLI on
 * the Claude host, over SSH) into the screen's message model. The mapping
 * mirrors what desktop's chat store does; the M1 demo intentionally used
 * the same shapes, so the screen is unchanged.
 */
@Injectable({ providedIn: 'root' })
export class ClaudeLive implements ClaudeStore {
  private readonly backend = inject(PEAR_BACKEND) as PearApi & MobileClaudeConfig;

  readonly messages = signal<ClaudeMsg[]>([]);
  readonly tokens = signal(0);
  readonly busy = signal(false);
  readonly autoApprove = signal(false);
  readonly sessionId = signal<string | null>(null);
  readonly sessions = signal<ClaudeSessionRow[]>([]);
  readonly hostPick = {
    current: signal<string | null>(null),
    set: (id: string | null): void => {
      this.hostPick.current.set(id);
      void this.backend.setClaudeHost(id);
    },
  };
  readonly modelPick = {
    current: signal<string | null>(localStorage.getItem(MODEL_KEY)),
    set: (model: string | null): void => {
      this.modelPick.current.set(model);
      if (model) localStorage.setItem(MODEL_KEY, model);
      else localStorage.removeItem(MODEL_KEY);
      this.backend.claude.chatSetModel(model);
    },
  };

  /** blockId/requestId → message id, plus tool start times and questions. */
  private blockMsg = new Map<string, string>();
  private toolStarted = new Map<string, number>();
  private questions = new Map<string, ClaudeQuestion[]>();
  private seq = 0;

  constructor() {
    this.backend.claude.onEvent((e) => this.apply(e));
    void this.backend.getClaudeHost().then((id) => this.hostPick.current.set(id));
    // Re-apply the persisted model choice (the backend default is the CLI's).
    const model = this.modelPick.current();
    if (model) this.backend.claude.chatSetModel(model);
    this.refreshSessions();
  }

  private mid(): string {
    return `cl${++this.seq}`;
  }

  private push(msg: ClaudeMsg): void {
    this.messages.update((prev) => [...prev, msg]);
  }

  private patch(id: string, fn: (m: ClaudeMsg) => ClaudeMsg): void {
    this.messages.update((prev) => prev.map((m) => (m.id === id ? fn(m) : m)));
  }

  private apply(e: ClaudeChatEvent): void {
    switch (e.type) {
      case 'init':
        this.sessionId.set(e.sessionId);
        this.refreshSessions();
        break;
      case 'user':
        this.push({ id: this.mid(), role: 'user', text: e.text });
        this.busy.set(true);
        break;
      case 'text-delta': {
        const existing = this.blockMsg.get(e.blockId);
        if (existing) {
          this.patch(existing, (m) =>
            m.role === 'assistant' ? { ...m, text: m.text + e.text } : m,
          );
        } else {
          const id = this.mid();
          this.blockMsg.set(e.blockId, id);
          this.push({ id, role: 'assistant', text: e.text });
        }
        break;
      }
      case 'think-delta': {
        const existing = this.blockMsg.get(e.blockId);
        if (existing) {
          this.patch(existing, (m) => (m.role === 'think' ? { ...m, text: m.text + e.text } : m));
        } else {
          const id = this.mid();
          this.blockMsg.set(e.blockId, id);
          this.push({ id, role: 'think', secs: 0, text: e.text });
        }
        break;
      }
      case 'think-done': {
        const id = this.blockMsg.get(e.blockId);
        if (id) this.patch(id, (m) => (m.role === 'think' ? { ...m, secs: e.secs } : m));
        break;
      }
      case 'tool-start': {
        const id = this.mid();
        this.blockMsg.set(e.blockId, id);
        this.toolStarted.set(e.blockId, Date.now());
        this.push({ id, role: 'tool', cmd: e.display, status: 'running' });
        break;
      }
      case 'tool-end': {
        const id = this.blockMsg.get(e.blockId);
        const started = this.toolStarted.get(e.blockId);
        const ms = started ? Date.now() - started : undefined;
        if (id) {
          this.patch(id, (m) =>
            m.role === 'tool'
              ? {
                  ...m,
                  status: e.status === 'error' ? 'error' : 'done',
                  ms,
                  out: e.output || undefined,
                }
              : m,
          );
        }
        break;
      }
      case 'permission':
        this.push({
          id: e.requestId,
          role: 'permission',
          status: 'pending',
          cmd: e.display,
          why: e.diff ? `edits ${e.diff.path}` : '',
        });
        break;
      case 'permission-resolved':
        this.patch(e.requestId, (m) =>
          m.role === 'permission'
            ? {
                ...m,
                status: e.status === 'deny' ? 'denied' : e.status === 'always' ? 'always' : 'once',
              }
            : m,
        );
        break;
      case 'question': {
        this.questions.set(e.requestId, e.questions);
        const first = e.questions[0];
        this.push({
          id: e.requestId,
          role: 'question',
          prompt: first?.question ?? 'Claude asks:',
          options: (first?.options ?? []).map((o) => o.label),
          answer: null,
        });
        break;
      }
      case 'question-answered': {
        const questions = this.questions.get(e.requestId);
        const first = questions?.[0];
        const picked = first ? (e.choices[first.question] ?? null) : null;
        this.patch(e.requestId, (m) =>
          m.role === 'question'
            ? { ...m, answer: picked === null ? m.answer : m.options.indexOf(picked) }
            : m,
        );
        break;
      }
      case 'divider':
        this.push({ id: this.mid(), role: 'divider', text: e.text });
        break;
      case 'usage':
        this.tokens.set(e.contextTokens);
        break;
      case 'turn-done':
        this.busy.set(false);
        this.refreshSessions();
        break;
      case 'error':
        this.push({ id: this.mid(), role: 'assistant', text: `⚠️ ${e.message}` });
        this.busy.set(false);
        break;
    }
  }

  private replay(events: ClaudeChatEvent[]): void {
    this.messages.set([]);
    this.blockMsg.clear();
    this.toolStarted.clear();
    const wasBusy = this.busy();
    for (const e of events) this.apply(e);
    this.busy.set(wasBusy);
  }

  send(text: string): void {
    if (!text || this.busy()) return;
    this.busy.set(true);
    this.backend.claude.chatSend(text).catch((err: unknown) => {
      this.push({
        id: this.mid(),
        role: 'assistant',
        text: `⚠️ ${err instanceof Error ? err.message : String(err)}`,
      });
      this.busy.set(false);
    });
  }

  compact(): void {
    this.send('/compact');
  }

  newSession(): void {
    void this.backend.claude.chatNew();
    this.messages.set([]);
    this.blockMsg.clear();
    this.sessionId.set(null);
    this.tokens.set(0);
    this.busy.set(false);
  }

  load(sessionId: string): void {
    void this.backend.claude.chatResume(sessionId).then(
      (events) => {
        this.sessionId.set(sessionId);
        this.busy.set(false);
        this.replay(events);
      },
      (err: unknown) => {
        this.push({
          id: this.mid(),
          role: 'assistant',
          text: `⚠️ ${err instanceof Error ? err.message : String(err)}`,
        });
      },
    );
  }

  refreshSessions(): void {
    void this.backend.claude.chatSessions().then((metas) => {
      this.sessions.set(
        metas.map((m) => ({
          id: m.id,
          title: m.title,
          when: relTime(m.lastUsedAt),
          turns: m.turns,
          tokens: m.tokens,
        })),
      );
    });
  }

  toggleAutoApprove(): void {
    const next = !this.autoApprove();
    this.autoApprove.set(next);
    this.backend.claude.chatSetAutoApprove(next);
  }

  answerQuestion(id: string, choice: number): void {
    const questions = this.questions.get(id) ?? [];
    const choices: Record<string, string> = {};
    for (const q of questions) {
      choices[q.question] = q.options[choice]?.label ?? q.options[0]?.label ?? '';
    }
    this.backend.claude.chatAnswer(id, { kind: 'answers', choices });
    this.patch(id, (m) => (m.role === 'question' ? { ...m, answer: choice } : m));
  }

  resolvePermission(id: string, decision: 'once' | 'always' | 'denied'): void {
    const kind = decision === 'once' ? 'allow' : decision === 'always' ? 'always' : 'deny';
    this.backend.claude.chatAnswer(id, { kind });
  }
}
