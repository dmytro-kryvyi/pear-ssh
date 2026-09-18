import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TerminalHub, type TermOps, type TermPolicy } from './term-hub';

const SIZE = { cols: 80, rows: 24 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function rig(policy?: TermPolicy) {
  const data: [string, string, number][] = [];
  const exits: string[] = [];
  const calls: string[] = [];
  const hub = new TerminalHub(
    { onData: (id, d, seq) => data.push([id, d, seq]), onExit: (id) => exits.push(id) },
    policy,
  );
  const ops = (id: string): TermOps => ({
    write: (d) => calls.push(`write ${id} ${d}`),
    resize: (s) => calls.push(`resize ${id} ${s.cols}x${s.rows}`),
    // A real channel reports its own close; mirror that.
    close: () => {
      calls.push(`close ${id}`);
      hub.ended(id);
    },
  });
  const open = (id: string) => hub.track(id, { hostId: 'h', kind: 'shell', size: SIZE }, ops(id));
  return { hub, data, exits, calls, open };
}

test('zero policy is a passthrough: events flow, nothing is kept', () => {
  const { hub, data, exits, calls, open } = rig();
  open('t');
  hub.ingest('t', 'hello');
  hub.write('t', 'x');
  hub.resize('t', { cols: 100, rows: 30 });
  assert.deepEqual(data, [['t', 'hello', 5]]);
  assert.deepEqual(hub.read('t', null), { mode: 'reset', data: '', seq: 5 });
  assert.deepEqual(calls, ['write t x', 'resize t 100x30']);
  assert.equal(hub.list()[0].cols, 100);
  hub.ended('t');
  assert.deepEqual(exits, ['t']);
  assert.equal(hub.has('t'), false);
});

test('never-attached terminals are never reaped (the Electron case)', async () => {
  const { hub, calls, open } = rig({ graceMs: 0, ringChars: 0 });
  open('t');
  hub.detachClient('nobody');
  await sleep(10);
  assert.deepEqual(calls, []);
  assert.equal(hub.has('t'), true);
});

test('delta read returns exactly the missing suffix', () => {
  const { hub, open } = rig({ graceMs: Infinity, ringChars: 1000 });
  open('t');
  hub.ingest('t', 'abc');
  hub.ingest('t', 'defg');
  hub.ingest('t', 'hi');
  assert.deepEqual(hub.read('t', 3), { mode: 'delta', data: 'defghi', seq: 9 });
  assert.deepEqual(hub.read('t', 5), { mode: 'delta', data: 'fghi', seq: 9 });
  assert.deepEqual(hub.read('t', 9), { mode: 'delta', data: '', seq: 9 });
  assert.deepEqual(hub.read('t', null), { mode: 'reset', data: 'abcdefghi', seq: 9 });
});

test('a cursor the ring has dropped, or never produced, yields a reset', () => {
  const { hub, open } = rig({ graceMs: Infinity, ringChars: 6 });
  open('t');
  for (const chunk of ['aaa', 'bbb', 'ccc', 'ddd']) hub.ingest('t', chunk);
  // 12 emitted, cap 6 → 'aaa','bbb' dropped.
  assert.deepEqual(hub.read('t', 3), { mode: 'reset', data: 'cccddd', seq: 12 });
  assert.deepEqual(hub.read('t', 6), { mode: 'delta', data: 'cccddd', seq: 12 });
  assert.equal(hub.read('t', 99)?.mode, 'reset'); // e.g. a cursor from before a server restart
  assert.equal(hub.read('missing', 0), null);
});

test('grace 0 closes on last detach; a second client keeps it alive', () => {
  const { hub, calls, exits, open } = rig({ graceMs: 0, ringChars: 100 });
  open('t');
  hub.attach('t', 'ipad');
  hub.attach('t', 'laptop');
  hub.detachClient('ipad');
  assert.deepEqual(calls, []);
  hub.detachClient('laptop');
  assert.deepEqual(calls, ['close t']);
  assert.deepEqual(exits, ['t']);
});

test('grace period: reattach cancels the reap, expiry closes', async () => {
  const { hub, calls, open } = rig({ graceMs: 40, ringChars: 100 });
  open('a');
  open('b');
  hub.attach('a', 'c1');
  hub.attach('b', 'c1');
  hub.detachClient('c1');
  hub.attach('a', 'c2'); // came back in time
  await sleep(90);
  assert.deepEqual(calls, ['close b']);
  assert.equal(hub.has('a'), true);
});

test('maxDetached evicts the longest-detached terminal', () => {
  let clock = 0;
  const calls: string[] = [];
  const hub = new TerminalHub(
    { onData: () => {}, onExit: () => {} },
    { graceMs: Infinity, ringChars: 10, maxDetached: 2 },
    () => ++clock,
  );
  for (const id of ['a', 'b', 'c']) {
    hub.track(
      id,
      { hostId: 'h', kind: 'shell', size: SIZE },
      {
        write: () => {},
        resize: () => {},
        close: () => {
          calls.push(id);
          hub.ended(id);
        },
      },
    );
    hub.attach(id, `client-${id}`);
  }
  hub.detachClient('client-a');
  hub.detachClient('client-b');
  assert.deepEqual(calls, []);
  hub.detachClient('client-c');
  assert.deepEqual(calls, ['a']);
});

test('exited terminals keep their scrollback readable for a while', async () => {
  const { hub, open } = rig({ graceMs: Infinity, ringChars: 100, exitedKeepMs: 40 });
  open('t');
  hub.ingest('t', 'last words');
  hub.ended('t');
  assert.equal(hub.list()[0].exited, true);
  assert.equal(hub.read('t', null)?.data, 'last words');
  hub.write('t', 'ignored');
  await sleep(90);
  assert.equal(hub.has('t'), false);
});

test('global cap drops detached scrollback first, never an attached one', () => {
  const { hub, open } = rig({ graceMs: Infinity, ringChars: 100, globalRingChars: 10 });
  open('idle');
  open('live');
  hub.attach('idle', 'c1');
  hub.attach('live', 'c2');
  hub.ingest('idle', '12345678');
  hub.detachClient('c1');
  hub.ingest('live', 'abcdefgh'); // 16 held > 10
  assert.deepEqual(hub.read('idle', null), { mode: 'reset', data: '', seq: 8 });
  assert.equal(hub.read('live', null)?.data, 'abcdefgh');
});

test('repaint jiggles the size so full-screen programs redraw', () => {
  const { hub, calls, open } = rig({ graceMs: Infinity, ringChars: 100 });
  open('t');
  hub.repaint('t');
  assert.deepEqual(calls, ['resize t 80x23', 'resize t 80x24']);
});
