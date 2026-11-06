import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ClaudeChatEvent } from '../../claude/events';
import { ClaudeChatSession } from './chat-session';

// A stand-in for the claude CLI: answers every user line with a one-text
// turn. Its init reports the --resume value (prefixed) so tests can see
// which spawn they are talking to.
const FAKE = `
const args = process.argv.slice(2);
const r = args.indexOf('--resume');
const sid = r >= 0 ? 'R:' + args[r + 1] : 'S1';
process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: sid, model: 'fake' }) + '\\n');
let buf = '';
process.stdin.on('data', (c) => {
  buf += c;
  let nl;
  while ((nl = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.type !== 'user') continue;
    const text = String(msg.message.content);
    if (text === 'fail-auth') {
      process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in · Please run /login' }) + '\\n');
      continue;
    }
    process.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'echo ' + text }] } }) + '\\n');
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', usage: { input_tokens: 1 } }) + '\\n');
  }
});
process.stdin.on('end', () => process.exit(0));
`;

function fakeClaude(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pear-fake-claude-'));
  const file = join(dir, 'fake-claude.js');
  writeFileSync(file, FAKE);
  return `${JSON.stringify(process.execPath)} ${JSON.stringify(file)}`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function untilTurnDone(events: ClaudeChatEvent[], from: number): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (events.slice(from).some((e) => e.type === 'turn-done')) return;
    await sleep(25);
  }
  throw new Error('turn never finished: ' + JSON.stringify(events.slice(from)));
}

test('session: idle process is retired quietly and the next send resumes it', async () => {
  const events: ClaudeChatEvent[] = [];
  const s = new ClaudeChatSession(
    { dir: tmpdir(), bin: fakeClaude(), idleMs: 80 },
    (e) => events.push(e),
  );
  s.send('hi');
  await untilTurnDone(events, 0);
  assert.equal(s.sessionId, 'S1');
  assert.ok(events.some((e) => e.type === 'text-delta' && e.text === 'echo hi'));
  assert.ok(s.running);

  const after = events.length;
  await sleep(300); // idle timer fires, fake exits
  assert.equal(s.running, false, 'idle process should be stopped');
  assert.deepEqual(events.slice(after), [], 'an idle stop owes the UI nothing');

  s.send('again');
  await untilTurnDone(events, after);
  assert.equal(s.sessionId, 'R:S1', 'respawn resumes the same CLI session');
  s.dispose();
});

test('session: an is_error result reaches the UI as an error, then turn-done', async () => {
  const events: ClaudeChatEvent[] = [];
  const s = new ClaudeChatSession({ dir: tmpdir(), bin: fakeClaude(), idleMs: 0 }, (e) =>
    events.push(e),
  );
  s.send('fail-auth');
  await untilTurnDone(events, 0);
  const err = events.find((e) => e.type === 'error') as Extract<ClaudeChatEvent, { type: 'error' }>;
  assert.match(err.message, /Please run \/login/);
  assert.ok(s.running, 'idleMs 0 keeps the process');
  s.dispose();
});
