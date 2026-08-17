import type {
  ClaudeChatEvent,
  ClaudeFileDiff,
  ClaudePermissionAnswer,
  ClaudeQuestion,
} from './events';
import { toolDisplay } from './parser';
import { applyEdit } from './edit';
import type { ClaudeExecutor } from './executor';
import { uuid } from '../uuid';

export type PermissionAnswer = ClaudePermissionAnswer;

interface Pending {
  resolve: (a: PermissionAnswer) => void;
  tool: string;
}

/**
 * Bridges the CLI's --permission-prompt-tool calls to the chat UI: each call
 * becomes a permission/question event, and the returned promise settles when
 * the user clicks a card button (or the session ends → deny). The return
 * value is the behavior JSON the CLI expects from the prompt tool.
 */
export class PermissionBridge {
  private pending = new Map<string, Pending>();
  private alwaysAllowed = new Set<string>();
  private autoApprove = false;

  constructor(
    private readonly emit: (e: ClaudeChatEvent) => void,
    /** For diff previews on pear write_file cards. */
    private readonly executor?: ClaudeExecutor,
  ) {}

  setAutoApprove(on: boolean): void {
    this.autoApprove = on;
  }

  get autoApproveOn(): boolean {
    return this.autoApprove;
  }

  /** Handles one prompt-tool invocation; resolves to the JSON reply text. */
  async request(toolName: string, input: unknown): Promise<string> {
    if (toolName === 'AskUserQuestion') return this.askQuestions(input);

    if (this.autoApprove || this.alwaysAllowed.has(toolName)) {
      return JSON.stringify({ behavior: 'allow', updatedInput: input ?? {} });
    }

    const requestId = uuid();
    const diff = await this.diffFor(toolName, input);
    this.emit({
      type: 'permission',
      requestId,
      tool: toolName,
      display: toolDisplay(toolName, input),
      ...(diff ? { diff } : {}),
    });
    const answer = await new Promise<PermissionAnswer>((resolve) => {
      this.pending.set(requestId, { resolve, tool: toolName });
    });
    this.pending.delete(requestId);

    if (answer.kind === 'always') this.alwaysAllowed.add(toolName);
    const allowed = answer.kind === 'allow' || answer.kind === 'always';
    this.emit({
      type: 'permission-resolved',
      requestId,
      status: answer.kind === 'always' ? 'always' : allowed ? 'allow' : 'deny',
    });
    return allowed
      ? JSON.stringify({ behavior: 'allow', updatedInput: input ?? {} })
      : JSON.stringify({ behavior: 'deny', message: 'The user denied this action.' });
  }

  private async askQuestions(input: unknown): Promise<string> {
    const questions = ((input ?? {}) as { questions?: ClaudeQuestion[] }).questions ?? [];
    const requestId = uuid();
    this.emit({ type: 'question', requestId, questions });
    const answer = await new Promise<PermissionAnswer>((resolve) => {
      this.pending.set(requestId, { resolve, tool: 'AskUserQuestion' });
    });
    this.pending.delete(requestId);
    if (answer.kind !== 'answers') {
      return JSON.stringify({ behavior: 'deny', message: 'The user dismissed the question.' });
    }
    this.emit({ type: 'question-answered', requestId, choices: answer.choices });
    return JSON.stringify({
      behavior: 'allow',
      updatedInput: { questions, answers: answer.choices },
    });
  }

  /** Old-vs-new preview for pear file mutations; absent for everything else. */
  private async diffFor(toolName: string, input: unknown): Promise<ClaudeFileDiff | undefined> {
    if (!this.executor) return undefined;
    if (toolName === 'mcp__pear__write_file') {
      const i = (input ?? {}) as { host?: string; path?: string; content?: string };
      if (!i.host || !i.path || typeof i.content !== 'string') return undefined;
      let oldText = '';
      try {
        oldText = await this.executor.readFile(i.host, i.path, 256 * 1024);
      } catch {
        oldText = ''; // new file (or unreadable — the card just shows all-new)
      }
      return { path: i.path, oldText, newText: i.content };
    }
    if (toolName === 'mcp__pear__edit_file') {
      const i = (input ?? {}) as {
        host?: string;
        path?: string;
        old_string?: string;
        new_string?: string;
        replace_all?: boolean;
      };
      if (!i.host || !i.path || typeof i.old_string !== 'string' || typeof i.new_string !== 'string')
        return undefined;
      try {
        const oldText = await this.executor.readFile(i.host, i.path, 256 * 1024);
        const newText = applyEdit(oldText, i.old_string, i.new_string, i.replace_all).content;
        return { path: i.path, oldText, newText };
      } catch {
        // Unreadable or no-match: card without a diff — the tool itself will
        // report the precise error after approval.
        return undefined;
      }
    }
    return undefined;
  }

  /** UI answered a pending card. Unknown ids are ignored (stale card). */
  answer(requestId: string, answer: PermissionAnswer): void {
    this.pending.get(requestId)?.resolve(answer);
  }

  /** Session ended/interrupted: everything pending is denied, never allowed. */
  denyAll(): void {
    for (const [, p] of this.pending) p.resolve({ kind: 'deny' });
    this.pending.clear();
  }
}
