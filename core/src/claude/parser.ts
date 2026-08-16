import type { ClaudeChatEvent } from './events';

interface OpenBlock {
  kind: 'text' | 'thinking' | 'tool_use';
  blockId: string;
  toolName?: string;
  toolUseId?: string;
  inputJson?: string;
  startedAt: number;
}

/** Human-oriented one-liner for a tool card header. */
export function toolDisplay(tool: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const s = (k: string) => (typeof i[k] === 'string' ? (i[k] as string) : undefined);
  switch (tool) {
    case 'mcp__pear__run_command':
      return `${s('host') ?? '?'} $ ${s('command') ?? ''}`;
    case 'mcp__pear__read_file':
      return `read ${s('host') ?? '?'}:${s('path') ?? ''}`;
    case 'mcp__pear__write_file':
      return `write ${s('host') ?? '?'}:${s('path') ?? ''}`;
    case 'mcp__pear__list_dir':
      return `ls ${s('host') ?? '?'}:${s('path') ?? ''}`;
    case 'mcp__pear__list_hosts':
      return 'list hosts';
    case 'mcp__pear__edit_file':
      return `edit ${s('host') ?? '?'}:${s('path') ?? ''}`;
    case 'mcp__pear__host_vitals':
      return `vitals ${s('host') ?? '?'}`;
    case 'mcp__pear__service_ps':
      return `${s('host') ?? '?'} service ps ${s('service') ?? ''}`;
    case 'mcp__pear__service_logs':
      return `${s('host') ?? '?'} logs ${s('target') ?? ''}`;
    case 'mcp__pear__list_guests':
      return `guests ${s('host') ?? '?'}`;
    case 'mcp__pear__list_terminals':
      return 'list terminals';
    case 'mcp__pear__read_terminal':
      return `read terminal ${s('terminal') ?? '(active)'}`;
    case 'mcp__pear__reveal_in_app':
      return `show in app: ${s('action') ?? '?'} ${s('host') ?? ''}${
        s('path') ? `:${s('path')}` : s('service') ? ` ${s('service')}` : ''
      }`;
    case 'mcp__pear__transfer_between_hosts': {
      const names = Array.isArray(i['names']) ? (i['names'] as unknown[]) : [];
      const what = names.length === 1 ? String(names[0]) : `${names.length} items`;
      return `transfer ${what} ${s('src_host') ?? '?'}:${s('src_dir') ?? ''} → ${
        s('dest_host') ?? '?'
      }:${s('dest_dir') ?? ''}`;
    }
    case 'mcp__pear__transfer_status':
      return `transfer status${s('job_id') ? ` ${s('job_id')}` : ''}`;
    case 'mcp__pear__port_forward':
      return `forward localhost:${typeof i['local_port'] === 'number' ? i['local_port'] : '?'} → ${
        s('host') ?? '?'
      }:${typeof i['remote_port'] === 'number' ? i['remote_port'] : '?'}`;
    case 'mcp__pear__list_port_forwards':
      return 'list port forwards';
    case 'mcp__pear__close_port_forward':
      return `close forward ${s('id') ?? ''}`;
    case 'Bash':
      return `local $ ${s('command') ?? ''}`;
    case 'ToolSearch':
      return `find tools: ${s('query') ?? ''}`;
    case 'WebSearch':
      return `web search: ${s('query') ?? ''}`;
    case 'WebFetch':
      return `fetch ${s('url') ?? ''}`;
    case 'Read':
    case 'Write':
    case 'Edit':
      return `${tool} ${s('file_path') ?? ''}`;
    default: {
      const json = JSON.stringify(input ?? {});
      return `${tool} ${json.length > 80 ? json.slice(0, 77) + '…' : json}`;
    }
  }
}

/**
 * Maps the claude CLI's stream-json stdout (one JSON object per line) to
 * ClaudeChatEvents. Streaming deltas are preferred; complete assistant
 * messages are used only for blocks that never streamed (so the parser works
 * with or without --include-partial-messages, without double-rendering).
 */
export class ChatStreamParser {
  private buffer = '';
  private seq = 0;
  private open = new Map<number, OpenBlock>();
  /** tool_use id -> blockId, for correlating tool_result. */
  private toolBlocks = new Map<string, string>();
  /** blockIds that already produced streamed content. */
  private streamedText = new Set<string>();
  private sawStreamEvents = false;
  /** Context size after the latest API call (per-call usage snapshot). */
  private lastContextTokens = 0;

  constructor(private readonly now: () => number = Date.now) {}

  private nextId(): string {
    return 'b' + ++this.seq;
  }

  push(chunk: string): ClaudeChatEvent[] {
    this.buffer += chunk;
    const events: ClaudeChatEvent[] = [];
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let msg: Record<string, any>;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // non-JSON noise (should not happen on stdout, but be robust)
      }
      this.handle(msg, events);
    }
    return events;
  }

  private handle(msg: Record<string, any>, out: ClaudeChatEvent[]): void {
    switch (msg['type']) {
      case 'system':
        if (msg['subtype'] === 'init') {
          out.push({
            type: 'init',
            sessionId: String(msg['session_id'] ?? ''),
            model: String(msg['model'] ?? ''),
          });
        } else if (msg['subtype'] === 'compact_boundary') {
          out.push({ type: 'divider', text: 'context compacted' });
        }
        return;
      case 'stream_event':
        this.sawStreamEvents = true;
        this.handleStreamEvent(msg['event'] ?? {}, out);
        return;
      case 'assistant':
        // Subagent (Task) messages carry parent_tool_use_id and bill a
        // separate context — they must not drive the main context meter.
        if (msg['parent_tool_use_id'] == null) {
          this.trackUsage((msg['message'] ?? {})['usage'], out);
        }
        this.handleAssistant(msg['message'] ?? {}, out);
        return;
      case 'user':
        this.handleToolResults(msg['message'] ?? {}, out);
        return;
      case 'result':
        this.handleResult(msg, out);
        return;
    }
  }

  private handleStreamEvent(event: Record<string, any>, out: ClaudeChatEvent[]): void {
    const index = Number(event['index'] ?? 0);
    switch (event['type']) {
      case 'content_block_start': {
        const cb = event['content_block'] ?? {};
        const blockId = this.nextId();
        if (cb['type'] === 'tool_use') {
          this.open.set(index, {
            kind: 'tool_use',
            blockId,
            toolName: String(cb['name'] ?? 'tool'),
            toolUseId: String(cb['id'] ?? ''),
            inputJson: '',
            startedAt: this.now(),
          });
        } else if (cb['type'] === 'thinking' || cb['type'] === 'redacted_thinking') {
          this.open.set(index, { kind: 'thinking', blockId, startedAt: this.now() });
        } else {
          this.open.set(index, { kind: 'text', blockId, startedAt: this.now() });
        }
        return;
      }
      case 'content_block_delta': {
        const block = this.open.get(index);
        if (!block) return;
        const delta = event['delta'] ?? {};
        if (delta['type'] === 'text_delta' && block.kind === 'text') {
          this.streamedText.add(block.blockId);
          out.push({ type: 'text-delta', blockId: block.blockId, text: String(delta['text'] ?? '') });
        } else if (delta['type'] === 'thinking_delta' && block.kind === 'thinking') {
          out.push({
            type: 'think-delta',
            blockId: block.blockId,
            text: String(delta['thinking'] ?? ''),
          });
        } else if (delta['type'] === 'input_json_delta' && block.kind === 'tool_use') {
          block.inputJson = (block.inputJson ?? '') + String(delta['partial_json'] ?? '');
        }
        return;
      }
      case 'content_block_stop': {
        const block = this.open.get(index);
        if (!block) return;
        this.open.delete(index);
        if (block.kind === 'thinking') {
          const secs = Math.max(1, Math.round((this.now() - block.startedAt) / 1000));
          out.push({ type: 'think-done', blockId: block.blockId, secs });
        } else if (block.kind === 'tool_use' && block.toolUseId) {
          this.emitToolStart(block.toolUseId, block.toolName ?? 'tool', block.inputJson, out);
        }
        return;
      }
    }
  }

  private emitToolStart(
    toolUseId: string,
    tool: string,
    inputJson: string | unknown,
    out: ClaudeChatEvent[],
  ): void {
    if (this.toolBlocks.has(toolUseId)) return; // already emitted (stream + full message)
    let input: unknown = inputJson;
    if (typeof inputJson === 'string') {
      try {
        input = inputJson ? JSON.parse(inputJson) : {};
      } catch {
        input = {};
      }
    }
    const blockId = this.nextId();
    this.toolBlocks.set(toolUseId, blockId);
    out.push({ type: 'tool-start', blockId, tool, display: toolDisplay(tool, input) });
  }

  /** Complete assistant messages: emit only what never streamed. */
  private handleAssistant(message: Record<string, any>, out: ClaudeChatEvent[]): void {
    const content = Array.isArray(message['content']) ? message['content'] : [];
    for (const cb of content) {
      if (cb?.['type'] === 'text') {
        if (this.sawStreamEvents) continue; // already rendered via deltas
        const blockId = this.nextId();
        out.push({ type: 'text-delta', blockId, text: String(cb['text'] ?? '') });
      } else if (cb?.['type'] === 'thinking') {
        if (this.sawStreamEvents) continue;
        const blockId = this.nextId();
        out.push({ type: 'think-delta', blockId, text: String(cb['thinking'] ?? '') });
        out.push({ type: 'think-done', blockId, secs: 1 });
      } else if (cb?.['type'] === 'tool_use') {
        this.emitToolStart(String(cb['id'] ?? ''), String(cb['name'] ?? 'tool'), cb['input'], out);
      }
    }
  }

  /** User-role messages carry tool_result blocks for prior tool_use calls. */
  private handleToolResults(message: Record<string, any>, out: ClaudeChatEvent[]): void {
    const content = Array.isArray(message['content']) ? message['content'] : [];
    for (const cb of content) {
      if (cb?.['type'] !== 'tool_result') continue;
      const blockId = this.toolBlocks.get(String(cb['tool_use_id'] ?? ''));
      if (!blockId) continue;
      const raw = cb['content'];
      const text = Array.isArray(raw)
        ? raw
            .map((p: any) => (p?.type === 'text' ? String(p.text ?? '') : ''))
            .filter(Boolean)
            .join('\n')
        : typeof raw === 'string'
          ? raw
          : '';
      out.push({
        type: 'tool-end',
        blockId,
        status: cb['is_error'] ? 'error' : 'done',
        output: text,
      });
    }
  }

  /** Per-API-call usage. input + cache_read + cache_creation + output of one
   *  call = the context size right now. Emitted per assistant message so the
   *  meter tracks live during multi-step turns. */
  private trackUsage(usage: unknown, out: ClaudeChatEvent[]): void {
    if (!usage || typeof usage !== 'object') return;
    const u = usage as Record<string, unknown>;
    const n = (k: string) => (typeof u[k] === 'number' ? (u[k] as number) : 0);
    const tokens =
      n('input_tokens') + n('cache_read_input_tokens') + n('cache_creation_input_tokens') + n('output_tokens');
    if (tokens <= 0) return;
    this.lastContextTokens = tokens;
    out.push({ type: 'usage', contextTokens: tokens, costUsd: 0 });
  }

  private handleResult(msg: Record<string, any>, out: ClaudeChatEvent[]): void {
    // The result event's usage SUMS every API call of the turn (the cached
    // context is re-counted per call), so it wildly overstates context size —
    // report the last per-call snapshot and only take the cost from here.
    const usage = msg['usage'] ?? {};
    const n = (k: string) => (typeof usage[k] === 'number' ? (usage[k] as number) : 0);
    const contextTokens =
      this.lastContextTokens ||
      n('input_tokens') + n('cache_read_input_tokens') + n('cache_creation_input_tokens') + n('output_tokens');
    if (contextTokens > 0) {
      out.push({
        type: 'usage',
        contextTokens,
        costUsd: typeof msg['total_cost_usd'] === 'number' ? msg['total_cost_usd'] : 0,
      });
    }
    if (msg['subtype'] && msg['subtype'] !== 'success') {
      out.push({
        type: 'error',
        message: String(msg['result'] ?? msg['subtype']).slice(0, 500),
      });
    }
    out.push({ type: 'turn-done' });
  }
}
