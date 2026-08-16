// Chat-mode event protocol for the Claude dock. Pure types: they cross the
// core <-> desktop <-> ui boundary (and are persisted as session transcripts),
// so keep them JSON-serializable and stable.

export interface ClaudeQuestionOption {
  label: string;
  description?: string;
}

export interface ClaudeQuestion {
  question: string;
  header?: string;
  options: ClaudeQuestionOption[];
  multiSelect?: boolean;
}

export interface ClaudeFileDiff {
  path: string;
  oldText: string;
  newText: string;
}

/** One rendered/renderable step of a chat session. Delta events append into
 *  the block identified by blockId; everything else starts a block. */
export type ClaudeChatEvent =
  | { type: 'init'; sessionId: string; model: string }
  | { type: 'user'; text: string }
  | { type: 'text-delta'; blockId: string; text: string }
  | { type: 'think-delta'; blockId: string; text: string }
  | { type: 'think-done'; blockId: string; secs: number }
  | { type: 'tool-start'; blockId: string; tool: string; display: string }
  | { type: 'tool-end'; blockId: string; status: 'done' | 'error'; output: string }
  | {
      type: 'permission';
      requestId: string;
      tool: string;
      display: string;
      diff?: ClaudeFileDiff;
    }
  | { type: 'permission-resolved'; requestId: string; status: 'allow' | 'always' | 'deny' }
  | { type: 'question'; requestId: string; questions: ClaudeQuestion[] }
  | { type: 'question-answered'; requestId: string; choices: Record<string, string> }
  | { type: 'divider'; text: string }
  | { type: 'usage'; contextTokens: number; costUsd: number }
  | { type: 'turn-done' }
  | { type: 'error'; message: string };

/** What the user currently has focused in the app — pushed from the renderer
 *  so the MCP tools can tell Claude which host "this one" / "here" means. */
export interface ClaudeFocus {
  hostId: string;
  /** Directory shown in the focused pane (or the file's containing dir). */
  path?: string;
}

/** An action the reveal_in_app tool asks the renderer to perform. All are
 *  benign and reversible (open a tab/drawer, move focus) — never mutations. */
export type ClaudeRevealAction =
  | { type: 'open_dir'; hostId: string; path: string }
  | { type: 'open_file'; hostId: string; path: string }
  | { type: 'open_service_logs'; hostId: string; service: string; taskId?: string }
  | { type: 'focus_host'; hostId: string };

/** Main → renderer request payloads for the claude:uiRequest channel. */
export type ClaudeUiRequestPayload =
  | { kind: 'listTerminals' }
  | { kind: 'readTerminal'; terminalId?: string; lines?: number }
  | { kind: 'reveal'; action: ClaudeRevealAction };

/** One open terminal tab, as reported by the renderer. */
export interface ClaudeTerminalInfo {
  id: string;
  hostId: string;
  hostName: string;
  title: string;
  active: boolean;
}

export interface ClaudeUiRequest {
  id: string;
  payload: ClaudeUiRequestPayload;
}

export type ClaudeUiResponse =
  | { id: string; ok: true; value: unknown }
  | { id: string; ok: false; error: string };

/** The user's reply to a permission or question card. */
export type ClaudePermissionAnswer =
  | { kind: 'allow' }
  | { kind: 'always' }
  | { kind: 'deny' }
  | { kind: 'answers'; choices: Record<string, string> };

/** History-dropdown row, persisted in the session index. */
export interface ClaudeSessionMeta {
  id: string;
  title: string;
  createdAt: number;
  lastUsedAt: number;
  turns: number;
  tokens: number;
}

/** Merges consecutive same-block delta events so persisted transcripts stay
 *  compact; replaying the merged list renders identically. */
export function coalesceChatEvents(events: ClaudeChatEvent[]): ClaudeChatEvent[] {
  const out: ClaudeChatEvent[] = [];
  for (const e of events) {
    const prev = out[out.length - 1];
    if (
      prev &&
      (e.type === 'text-delta' || e.type === 'think-delta') &&
      prev.type === e.type &&
      prev.blockId === e.blockId
    ) {
      out[out.length - 1] = { ...prev, text: prev.text + e.text };
      continue;
    }
    out.push(e);
  }
  return out;
}
