import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeChatRuntime, type ChatSessionHandle } from './chat-runtime';
import type { ClaudeChatEvent } from './events';

function rig() {
  const emitted: ClaudeChatEvent[] = [];
  const calls: string[] = [];
  let feed: (e: ClaudeChatEvent) => void = () => {};
  const runtime = new ClaudeChatRuntime({
    storage: { read: () => null, write: () => {} },
    transcripts: { read: () => null, write: () => {} } as never,
    emit: (e) => emitted.push(e),
    createSession: (_opts, onEvent): ChatSessionHandle => {
      feed = onEvent;
      calls.push('spawn');
      return {
        sessionId: 's1',
        send: (t) => calls.push(`send ${t}`),
        setModel: () => {},
        interrupt: () => calls.push('interrupt'),
        dispose: () => calls.push('dispose'),
      };
    },
  });
  return { runtime, emitted, calls, feed: (e: ClaudeChatEvent) => feed(e) };
}

test('snapshot of an idle runtime is empty and not busy', () => {
  const { runtime } = rig();
  assert.deepEqual(runtime.snapshot(), {
    sessionId: null,
    events: [],
    busy: false,
    model: null,
    autoApprove: false,
  });
});

test('snapshot mid-turn: busy, coalesced, and it disturbs nothing', () => {
  const { runtime, calls, feed } = rig();
  runtime.setAutoApprove(true);
  runtime.send('check the disks');
  feed({ type: 'text-delta', blockId: 'b1', text: 'Look' } as ClaudeChatEvent);
  feed({ type: 'text-delta', blockId: 'b1', text: 'ing…' } as ClaudeChatEvent);

  const before = [...calls];
  const snap = runtime.snapshot();
  assert.equal(snap.busy, true);
  assert.equal(snap.sessionId, 's1');
  assert.equal(snap.autoApprove, true);
  assert.equal(snap.events[0].type, 'user');
  // Two deltas of one block arrive as one — same shape chatResume returns.
  assert.equal(snap.events.filter((e) => e.type === 'text-delta').length, 1);
  // The whole point: unlike resume(), nobody got interrupted, disposed or respawned.
  assert.deepEqual(calls, before);

  feed({ type: 'turn-done' });
  assert.equal(runtime.snapshot().busy, false);
  assert.equal(runtime.snapshot().events.length, snap.events.length + 1);
});

test('resume() by contrast tears the running session down (why snapshot exists)', () => {
  const { runtime, calls } = rig();
  runtime.send('hi');
  runtime.resume('s1');
  assert.ok(calls.includes('dispose'));
});
