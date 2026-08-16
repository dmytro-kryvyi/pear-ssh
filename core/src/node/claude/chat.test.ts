import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ClaudeChatEvent } from '../../claude/events';
import { ClaudeExecutor } from './executor';
import { PermissionBridge } from './permission-bridge';

function bridge(events: ClaudeChatEvent[]) {
  return new PermissionBridge((e) => events.push(e));
}

/** request() emits its card after internal awaits — let microtasks drain. */
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('bridge: allow / deny round-trips with resolved events', async () => {
  const events: ClaudeChatEvent[] = [];
  const b = bridge(events);

  const allowP = b.request('mcp__pear__run_command', { host: 'h', command: 'id' });
  await tick();
  const req1 = events.find((e) => e.type === 'permission') as Extract<
    ClaudeChatEvent,
    { type: 'permission' }
  >;
  assert.equal(req1.display, 'h $ id');
  b.answer(req1.requestId, { kind: 'allow' });
  const allowed = JSON.parse(await allowP);
  assert.equal(allowed.behavior, 'allow');
  assert.deepEqual(allowed.updatedInput, { host: 'h', command: 'id' });
  assert.ok(
    events.some((e) => e.type === 'permission-resolved' && e.status === 'allow'),
  );

  const denyP = b.request('Bash', { command: 'rm -rf /' });
  await tick();
  const req2 = events.filter((e) => e.type === 'permission')[1] as Extract<
    ClaudeChatEvent,
    { type: 'permission' }
  >;
  b.answer(req2.requestId, { kind: 'deny' });
  const denied = JSON.parse(await denyP);
  assert.equal(denied.behavior, 'deny');
  assert.ok(denied.message);
});

test('bridge: allow-for-session skips the card next time; autoApprove skips all', async () => {
  const events: ClaudeChatEvent[] = [];
  const b = bridge(events);

  const p = b.request('mcp__pear__write_file', { host: 'h', path: '/x', content: 'a' });
  await tick();
  const req = events.find((e) => e.type === 'permission') as Extract<
    ClaudeChatEvent,
    { type: 'permission' }
  >;
  b.answer(req.requestId, { kind: 'always' });
  assert.equal(JSON.parse(await p).behavior, 'allow');

  // Same tool again: no new permission event, immediate allow.
  const before = events.length;
  const p2 = await b.request('mcp__pear__write_file', { host: 'h', path: '/y', content: 'b' });
  assert.equal(JSON.parse(p2).behavior, 'allow');
  assert.equal(events.length, before);

  // Different tool still asks — until autoApprove.
  b.setAutoApprove(true);
  const p3 = await b.request('Bash', { command: 'ls' });
  assert.equal(JSON.parse(p3).behavior, 'allow');
});

test('bridge: AskUserQuestion becomes a question card answered via updatedInput', async () => {
  const events: ClaudeChatEvent[] = [];
  const b = bridge(events);
  const questions = [
    { question: 'Which tag?', options: [{ label: '2.4.1' }, { label: '2.4.2' }] },
  ];
  const p = b.request('AskUserQuestion', { questions });
  await tick();
  const q = events.find((e) => e.type === 'question') as Extract<
    ClaudeChatEvent,
    { type: 'question' }
  >;
  assert.equal(q.questions[0].question, 'Which tag?');
  b.answer(q.requestId, { kind: 'answers', choices: { 'Which tag?': '2.4.1' } });
  const reply = JSON.parse(await p);
  assert.equal(reply.behavior, 'allow');
  assert.deepEqual(reply.updatedInput.answers, { 'Which tag?': '2.4.1' });
  assert.ok(events.some((e) => e.type === 'question-answered'));
});

test('bridge: denyAll settles everything pending as deny', async () => {
  const events: ClaudeChatEvent[] = [];
  const b = bridge(events);
  const p1 = b.request('Bash', { command: 'a' });
  const p2 = b.request('mcp__pear__run_command', { host: 'h', command: 'b' });
  await tick();
  b.denyAll();
  assert.equal(JSON.parse(await p1).behavior, 'deny');
  assert.equal(JSON.parse(await p2).behavior, 'deny');
});

test('bridge: edit_file permission card carries a computed diff', async () => {
  const executor = new ClaudeExecutor({
    hosts: () => [
      { id: 'h', name: 'h', host: 'h', port: 22, user: 'u', kind: 'plain' },
    ],
    isConnected: () => true,
    exec: async () => ({ code: 0, stdout: '', stderr: '' }),
    readFile: async () => 'port = 80\nhost = a\n',
    writeFile: async () => {},
    listDir: async (_h: unknown, path: string) => ({ path, entries: [] }),
  });
  const events: ClaudeChatEvent[] = [];
  const b = new PermissionBridge((e) => events.push(e), executor);

  const p = b.request('mcp__pear__edit_file', {
    host: 'h',
    path: '/etc/app.conf',
    old_string: 'port = 80',
    new_string: 'port = 8080',
  });
  await tick();
  const card = events.find((e) => e.type === 'permission') as Extract<
    ClaudeChatEvent,
    { type: 'permission' }
  >;
  assert.equal(card.display, 'edit h:/etc/app.conf');
  assert.equal(card.diff?.oldText, 'port = 80\nhost = a\n');
  assert.equal(card.diff?.newText, 'port = 8080\nhost = a\n');
  b.answer(card.requestId, { kind: 'deny' });
  await p;

  // Ambiguous/no-match edits still get a card, just without a diff.
  const p2 = b.request('mcp__pear__edit_file', {
    host: 'h',
    path: '/etc/app.conf',
    old_string: 'nope',
    new_string: 'x',
  });
  await tick();
  const card2 = events.filter((e) => e.type === 'permission')[1] as Extract<
    ClaudeChatEvent,
    { type: 'permission' }
  >;
  assert.equal(card2.diff, undefined);
  b.answer(card2.requestId, { kind: 'deny' });
  await p2;
});
