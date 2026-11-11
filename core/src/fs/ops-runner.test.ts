import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ShellChannel, SshTransport } from '../ssh/transport';
import { FsOpsRunner, parseExit, wrapForPty, type FsOpSnapshot } from './ops-runner';

class FakeChannel implements ShellChannel {
  closed = false;
  private dataCb: (chunk: string) => void = () => {};
  private closeCb: () => void = () => {};
  write(): void {}
  resize(): void {}
  close(): void {
    this.closed = true;
    // A real PTY reports the close asynchronously once the process dies.
    setTimeout(() => this.closeCb(), 0);
  }
  onData(cb: (chunk: string) => void): void {
    this.dataCb = cb;
  }
  onClose(cb: () => void): void {
    this.closeCb = cb;
  }
  emit(chunk: string): void {
    this.dataCb(chunk);
  }
  finish(): void {
    this.closeCb();
  }
}

function fakeTransport(commands: string[], channels: FakeChannel[], gate?: Promise<void>) {
  return {
    async shellCommand(command: string): Promise<ShellChannel> {
      if (gate) await gate;
      commands.push(command);
      const ch = new FakeChannel();
      channels.push(ch);
      return ch;
    },
  } as unknown as SshTransport;
}

function harness(gate?: Promise<void>) {
  const commands: string[] = [];
  const channels: FakeChannel[] = [];
  const updates: FsOpSnapshot[] = [];
  const transport = fakeTransport(commands, channels, gate);
  const runner = new FsOpsRunner(
    { connection: async () => transport, now: () => 1000 },
    { onUpdate: (op) => updates.push(op) },
  );
  const spec = {
    hostId: 'h',
    kind: 'extract' as const,
    label: 'Extract a.tgz → a/',
    command: 'tar -x',
    dirs: ['/d'],
    result: '/d/a',
  };
  const tick = () => new Promise((r) => setTimeout(r, 5));
  return { commands, channels, updates, runner, spec, tick };
}

test('wrapForPty forces sh and appends the exit marker', () => {
  assert.equal(
    wrapForPty("tar -x -f 'a'"),
    `sh -c 'tar -x -f '\\''a'\\''; printf '\\''\\n__PEAR_EXIT:%s__\\n'\\'' "$?"'`,
  );
});

test('parseExit strips CR, takes the last marker and the output before it', () => {
  assert.deepEqual(parseExit('one\r\ntwo\r\n__PEAR_EXIT:0__\r\n'), { code: 0, output: 'one\ntwo' });
  assert.deepEqual(parseExit('__PEAR_EXIT:1__\nx\n__PEAR_EXIT:3__\n'), {
    code: 3,
    output: '__PEAR_EXIT:1__\nx',
  });
  assert.deepEqual(parseExit('lost\n'), { code: null, output: 'lost' });
});

test('a successful command goes running → done with the wrapped command', async () => {
  const h = harness();
  const id = h.runner.start(h.spec);
  assert.equal(h.updates[0].status, 'running');
  assert.equal(h.updates[0].id, id);
  await h.tick();
  assert.equal(h.commands[0], wrapForPty('tar -x'));
  h.channels[0].emit('x\r\n__PEAR_EXIT:0__\r\n');
  h.channels[0].finish();
  await h.tick();
  const last = h.updates.at(-1)!;
  assert.equal(last.status, 'done');
  assert.equal(last.exitCode, 0);
  assert.equal(last.output, 'x');
  assert.equal(last.finishedAt, 1000);
  assert.equal(h.runner.list()[0].status, 'done');
});

test('a non-zero exit is an error carrying the last output line', async () => {
  const h = harness();
  h.runner.start(h.spec);
  await h.tick();
  h.channels[0].emit(
    'tar: a.tgz: Cannot open: No such file\ntar: Error is not recoverable\n__PEAR_EXIT:2__\n',
  );
  h.channels[0].finish();
  await h.tick();
  const last = h.updates.at(-1)!;
  assert.equal(last.status, 'error');
  assert.equal(last.error, 'exit 2: tar: Error is not recoverable');
  assert.match(last.output!, /Cannot open/);
});

test('closing without a marker is reported as a lost connection', async () => {
  const h = harness();
  h.runner.start(h.spec);
  await h.tick();
  h.channels[0].finish();
  await h.tick();
  assert.equal(h.updates.at(-1)!.status, 'error');
  assert.match(h.updates.at(-1)!.error!, /without a status/);
});

test('cancel closes the channel and ends as canceled', async () => {
  const h = harness();
  const id = h.runner.start(h.spec);
  await h.tick();
  h.runner.cancel(id);
  assert.equal(h.updates.at(-1)!.cancelRequested, true);
  assert.equal(h.updates.at(-1)!.status, 'running');
  assert.ok(h.channels[0].closed);
  await h.tick();
  assert.equal(h.updates.at(-1)!.status, 'canceled');
  h.runner.cancel(id); // idempotent on finished ops
});

test('cancel before the channel exists still closes it once it arrives', async () => {
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  const h = harness(gate);
  const id = h.runner.start(h.spec);
  await h.tick();
  h.runner.cancel(id);
  assert.equal(h.channels.length, 0);
  open();
  await h.tick();
  assert.ok(h.channels[0].closed);
  await h.tick();
  assert.equal(h.updates.at(-1)!.status, 'canceled');
});

test('a failing connection is an error; clearFinished drops finished ops only', async () => {
  const updates: FsOpSnapshot[] = [];
  const runner = new FsOpsRunner(
    {
      connection: async () => {
        throw new Error('auth failed');
      },
    },
    { onUpdate: (op) => updates.push(op) },
  );
  runner.start({ hostId: 'h', kind: 'compress', label: 'c', command: 'x', dirs: [], result: '/x' });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(updates.at(-1)!.status, 'error');
  assert.equal(updates.at(-1)!.error, 'auth failed');
  assert.equal(runner.list().length, 1);
  runner.clearFinished();
  assert.equal(runner.list().length, 0);
});
