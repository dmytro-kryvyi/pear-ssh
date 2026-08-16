import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChatStreamParser, toolDisplay } from './parser';
import { coalesceChatEvents, type ClaudeChatEvent } from './events';

const line = (obj: unknown) => JSON.stringify(obj) + '\n';

function streamEvent(event: unknown) {
  return line({ type: 'stream_event', event });
}

test('parser: init, streamed text, and result → usage/turn-done', () => {
  const p = new ChatStreamParser();
  const events: ClaudeChatEvent[] = [];
  events.push(...p.push(line({ type: 'system', subtype: 'init', session_id: 's-1', model: 'claude-x' })));
  events.push(...p.push(streamEvent({ type: 'content_block_start', index: 0, content_block: { type: 'text' } })));
  events.push(...p.push(streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hel' } })));
  events.push(...p.push(streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'lo' } })));
  events.push(...p.push(streamEvent({ type: 'content_block_stop', index: 0 })));
  events.push(
    ...p.push(
      line({
        type: 'result',
        subtype: 'success',
        usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 900 },
        total_cost_usd: 0.01,
      }),
    ),
  );

  assert.deepEqual(events[0], { type: 'init', sessionId: 's-1', model: 'claude-x' });
  const text = events.filter((e) => e.type === 'text-delta');
  assert.equal(text.length, 2);
  assert.equal(text.map((e) => (e as { text: string }).text).join(''), 'Hello');
  const usage = events.find((e) => e.type === 'usage');
  assert.deepEqual(usage, { type: 'usage', contextTokens: 1020, costUsd: 0.01 });
  assert.equal(events[events.length - 1].type, 'turn-done');
});

test('parser: chunks split mid-line and garbage lines are handled', () => {
  const p = new ChatStreamParser();
  const full = streamEvent({ type: 'content_block_start', index: 0, content_block: { type: 'text' } });
  const events = [
    ...p.push(full.slice(0, 20)),
    ...p.push(full.slice(20)),
    ...p.push('not json at all\n'),
    ...p.push(streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } })),
  ];
  assert.deepEqual(
    events.map((e) => e.type),
    ['text-delta'],
  );
});

test('parser: thinking block gets duration from the injected clock', () => {
  let t = 1000;
  const p = new ChatStreamParser(() => t);
  const events: ClaudeChatEvent[] = [];
  events.push(...p.push(streamEvent({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } })));
  events.push(...p.push(streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } })));
  t += 4200;
  events.push(...p.push(streamEvent({ type: 'content_block_stop', index: 0 })));
  assert.deepEqual(events[0], { type: 'think-delta', blockId: 'b1', text: 'hmm' });
  assert.deepEqual(events[1], { type: 'think-done', blockId: 'b1', secs: 4 });
});

test('parser: tool_use streams input json, correlates tool_result, dedupes full message', () => {
  const p = new ChatStreamParser();
  const events: ClaudeChatEvent[] = [];
  events.push(...p.push(streamEvent({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', name: 'mcp__pear__run_command', id: 'tu-1' } })));
  events.push(...p.push(streamEvent({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"host":"edge-01","com' } })));
  events.push(...p.push(streamEvent({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: 'mand":"whoami"}' } })));
  events.push(...p.push(streamEvent({ type: 'content_block_stop', index: 1 })));
  // the CLI also emits the complete assistant message — must not duplicate
  events.push(
    ...p.push(
      line({
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'tu-1', name: 'mcp__pear__run_command', input: { host: 'edge-01', command: 'whoami' } }],
        },
      }),
    ),
  );
  events.push(
    ...p.push(
      line({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: [{ type: 'text', text: 'avrora' }] }] },
      }),
    ),
  );

  const starts = events.filter((e) => e.type === 'tool-start');
  assert.equal(starts.length, 1);
  assert.deepEqual(starts[0], {
    type: 'tool-start',
    blockId: 'b2',
    tool: 'mcp__pear__run_command',
    display: 'edge-01 $ whoami',
  });
  const end = events.find((e) => e.type === 'tool-end');
  assert.deepEqual(end, { type: 'tool-end', blockId: 'b2', status: 'done', output: 'avrora' });
});

test('parser: without stream events, complete assistant messages render wholesale', () => {
  const p = new ChatStreamParser();
  const events = p.push(
    line({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Full answer.' },
          { type: 'tool_use', id: 'tu-9', name: 'Bash', input: { command: 'ls' } },
        ],
      },
    }),
  );
  assert.deepEqual(
    events.map((e) => e.type),
    ['text-delta', 'tool-start'],
  );
  assert.equal((events[0] as { text: string }).text, 'Full answer.');
});

test('parser: context meter uses per-call snapshots, not the cumulative result sum', () => {
  const p = new ChatStreamParser();
  const events: ClaudeChatEvent[] = [];
  const assistant = (usage: unknown, parent?: string) =>
    line({
      type: 'assistant',
      ...(parent ? { parent_tool_use_id: parent } : {}),
      message: { content: [], usage },
    });
  // Three API calls in one turn, each re-reading the ~100k cached context.
  events.push(...p.push(assistant({ input_tokens: 3, cache_read_input_tokens: 100_000, output_tokens: 50 })));
  events.push(...p.push(assistant({ input_tokens: 4, cache_read_input_tokens: 100_500, output_tokens: 60 })));
  // A subagent's context is separate — must not move the meter.
  events.push(...p.push(assistant({ input_tokens: 9, cache_read_input_tokens: 400, output_tokens: 5 }, 'tu-task')));
  events.push(
    ...p.push(
      line({
        type: 'result',
        subtype: 'success',
        // Cumulative across calls: ~300k, far above the real context size.
        usage: { input_tokens: 16, cache_read_input_tokens: 300_900, output_tokens: 115 },
        total_cost_usd: 0.42,
      }),
    ),
  );

  const usages = events.filter((e) => e.type === 'usage') as Array<{ contextTokens: number; costUsd: number }>;
  assert.deepEqual(
    usages.map((u) => u.contextTokens),
    [100_053, 100_564, 100_564],
  );
  assert.equal(usages[2].costUsd, 0.42);
});

test('parser: error result and compact boundary', () => {
  const p = new ChatStreamParser();
  const compact = p.push(line({ type: 'system', subtype: 'compact_boundary' }));
  assert.deepEqual(compact, [{ type: 'divider', text: 'context compacted' }]);
  const events = p.push(line({ type: 'result', subtype: 'error_max_turns', result: 'too many turns', usage: {} }));
  assert.deepEqual(
    events.map((e) => e.type),
    ['error', 'turn-done'],
  );
});

test('toolDisplay covers pear tools, local tools, and fallback', () => {
  assert.equal(toolDisplay('mcp__pear__write_file', { host: 'db', path: '/etc/x' }), 'write db:/etc/x');
  assert.equal(toolDisplay('Bash', { command: 'uname -a' }), 'local $ uname -a');
  assert.match(toolDisplay('SomeTool', { a: 1 }), /^SomeTool \{"a":1\}$/);
});

test('coalesceChatEvents merges same-block deltas only', () => {
  const merged = coalesceChatEvents([
    { type: 'text-delta', blockId: 'b1', text: 'a' },
    { type: 'text-delta', blockId: 'b1', text: 'b' },
    { type: 'text-delta', blockId: 'b2', text: 'c' },
    { type: 'turn-done' },
    { type: 'text-delta', blockId: 'b2', text: 'd' },
  ]);
  assert.deepEqual(merged, [
    { type: 'text-delta', blockId: 'b1', text: 'ab' },
    { type: 'text-delta', blockId: 'b2', text: 'c' },
    { type: 'turn-done' },
    { type: 'text-delta', blockId: 'b2', text: 'd' },
  ]);
});
