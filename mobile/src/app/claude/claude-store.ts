import { InjectionToken, type Signal } from '@angular/core';
import type { ClaudeMsg } from './claude-demo';

/** One row of the sessions sheet. */
export interface ClaudeSessionRow {
  id: string;
  title: string;
  when: string;
  turns: number;
  tokens: number;
}

/** Claude-host picker — present only on the native backend. */
export interface ClaudeHostPick {
  current: Signal<string | null>;
  set(id: string | null): void;
}

/** Model picker — present only on the native backend. `null` = CLI default.
 *  Applies from the next session launch (the running CLI keeps its model). */
export interface ClaudeModelPick {
  current: Signal<string | null>;
  set(model: string | null): void;
}

/**
 * What the Claude screen consumes. Two implementations: the scripted
 * ClaudeDemo (mock backend, browser) and ClaudeLive (native backend —
 * real CLI over SSH via PearApi.claude).
 */
export interface ClaudeStore {
  readonly messages: Signal<ClaudeMsg[]>;
  readonly tokens: Signal<number>;
  readonly busy: Signal<boolean>;
  readonly autoApprove: Signal<boolean>;
  readonly sessionId: Signal<string | null>;
  readonly sessions: Signal<ClaudeSessionRow[]>;
  readonly hostPick?: ClaudeHostPick;
  readonly modelPick?: ClaudeModelPick;

  send(text: string): void;
  compact(): void;
  newSession(): void;
  load(sessionId: string): void;
  refreshSessions(): void;
  toggleAutoApprove(): void;
  answerQuestion(id: string, choice: number): void;
  resolvePermission(id: string, decision: 'once' | 'always' | 'denied'): void;
}

export const CLAUDE_STORE = new InjectionToken<ClaudeStore>('CLAUDE_STORE');
