import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionManager } from './sessions';
import type { ExecResult, ShellChannel, SshTransport } from './transport';
import type { DirListing, HostConfig, TermSize } from '../types';

const HOST: HostConfig = {
  id: 'h1',
  name: 'test',
  host: 'example.invalid',
  port: 22,
  user: 'root',
  kind: 'plain',
};

class FakeChannel implements ShellChannel {
  written: string[] = [];
  resizes: TermSize[] = [];
  closed = false;
  private dataCb: (chunk: string) => void = () => {};
  private closeCb: () => void = () => {};

  write(data: string): void {
    this.written.push(data);
  }
  resize(size: TermSize): void {
    this.resizes.push(size);
  }
  close(): void {
    this.closed = true;
    this.closeCb();
  }
  onData(cb: (chunk: string) => void): void {
    this.dataCb = cb;
  }
  onClose(cb: () => void): void {
    this.closeCb = cb;
  }

  /** Test hook: simulate the remote end writing to the terminal. */
  emit(chunk: string): void {
    this.dataCb(chunk);
  }
}

class FakeTransport implements SshTransport {
  isConnected = false;
  channels: FakeChannel[] = [];
  execs: string[] = [];
  shellCommands: string[] = [];
  private closeCbs: Array<() => void> = [];

  constructor(private readonly execResult: ExecResult = { code: 0, stdout: '', stderr: '' }) {}

  async connect(): Promise<void> {
    this.isConnected = true;
  }
  onClose(cb: () => void): void {
    this.closeCbs.push(cb);
  }
  async shell(): Promise<ShellChannel> {
    const channel = new FakeChannel();
    this.channels.push(channel);
    return channel;
  }
  async shellCommand(command: string): Promise<ShellChannel> {
    this.shellCommands.push(command);
    const channel = new FakeChannel();
    this.channels.push(channel);
    return channel;
  }
  async exec(command: string): Promise<ExecResult> {
    this.execs.push(command);
    return this.execResult;
  }
  async listDir(): Promise<DirListing> {
    return { path: '/', entries: [] };
  }
  async readFile(): Promise<string> {
    return '';
  }
  async writeFile(): Promise<void> {}
  async upload(): Promise<string> {
    return '/remote/file';
  }
  async stat(): Promise<null> {
    return null;
  }
  async mkdir(): Promise<void> {}
  async remove(): Promise<void> {}
  async rename(): Promise<void> {}
  async copy(): Promise<void> {}
  async download(): Promise<void> {}
  async uploadFile(): Promise<void> {}
  dispose(): void {
    this.isConnected = false;
    for (const cb of this.closeCbs) cb();
  }

  /** Test hook: simulate the connection dropping from the far side. */
  drop(): void {
    this.dispose();
  }
}

function harness(
  transport = new FakeTransport(),
  resolveHost?: (id: string) => HostConfig | undefined,
) {
  const data: Array<[string, string]> = [];
  const exits: string[] = [];
  const disconnects: string[] = [];
  const factoryConfigs: HostConfig[] = [];
  const sessions = new SessionManager(
    {
      onTermData: (termId, chunk) => data.push([termId, chunk]),
      onTermExit: (termId) => exits.push(termId),
      onHostDisconnected: (hostId) => disconnects.push(hostId),
    },
    (config) => {
      factoryConfigs.push(config);
      return transport;
    },
    resolveHost,
  );
  return { sessions, transport, data, exits, disconnects, factoryConfigs };
}

const SIZE: TermSize = { cols: 80, rows: 24 };

test('terminal output is forwarded with the terminal id', async () => {
  const { sessions, transport, data } = harness();
  const handle = await sessions.openTerminal(HOST, SIZE);

  transport.channels[0].emit('hello');

  assert.deepEqual(data, [[handle.id, 'hello']]);
  assert.equal(handle.hostId, HOST.id);
});

test('write and resize reach the channel; close tears the terminal down', async () => {
  const { sessions, transport, exits } = harness();
  const handle = await sessions.openTerminal(HOST, SIZE);
  const channel = transport.channels[0];

  sessions.writeTerminal(handle.id, 'ls\n');
  sessions.resizeTerminal(handle.id, { cols: 120, rows: 40 });
  sessions.closeTerminal(handle.id);

  assert.deepEqual(channel.written, ['ls\n']);
  assert.deepEqual(channel.resizes, [{ cols: 120, rows: 40 }]);
  assert.ok(channel.closed);
  assert.deepEqual(exits, [handle.id]);
});

test('a dropped host connection exits its terminals and reports the disconnect', async () => {
  const { sessions, transport, exits, disconnects } = harness();
  const a = await sessions.openTerminal(HOST, SIZE);
  const b = await sessions.openTerminal(HOST, SIZE);

  transport.drop();

  assert.deepEqual(exits.sort(), [a.id, b.id].sort());
  assert.deepEqual(disconnects, [HOST.id]);
});

test('connections are reused per host while connected', async () => {
  const { sessions, transport } = harness();
  await sessions.openTerminal(HOST, SIZE);
  await sessions.openTerminal(HOST, SIZE);

  // Both terminals multiplex over one transport rather than reconnecting.
  assert.equal(transport.channels.length, 2);
  assert.ok(transport.isConnected);
});

test('orchestration probes run over the transport exec channel', async () => {
  const { sessions, transport } = harness(
    new FakeTransport({ code: 0, stdout: 'PVE\n', stderr: '' }),
  );

  const facets = await sessions.detectOrchFacets(HOST);

  assert.equal(facets.proxmox, true);
  assert.equal(facets.docker, false);
  assert.equal(transport.execs.length, 1);
});

// ---- Sub-hosts -------------------------------------------------------------

const SUB: HostConfig = {
  id: 's1',
  name: 'web',
  host: HOST.host,
  port: 22,
  user: 'root',
  kind: 'plain',
  parentId: HOST.id,
  target: { type: 'docker', ref: 'web' },
};

const resolver = (id: string) => (id === HOST.id ? HOST : id === SUB.id ? SUB : undefined);

test('a sub-host terminal runs docker exec in a parent-side PTY', async () => {
  const { sessions, transport } = harness(new FakeTransport(), resolver);

  const handle = await sessions.openTerminal(SUB, SIZE);

  assert.equal(handle.hostId, SUB.id);
  // The connect probe went over the parent's exec channel...
  assert.ok(transport.execs[0].includes("docker exec 'web'"));
  // ...and the shell is a docker exec -it in a parent PTY, not a login shell.
  assert.equal(transport.shellCommands.length, 1);
  assert.ok(transport.shellCommands[0].startsWith('docker exec -it'));
});

test('a dropped parent cascades to sub-host terminals and disconnect events', async () => {
  const { sessions, transport, exits, disconnects } = harness(new FakeTransport(), resolver);
  const parentTerm = await sessions.openTerminal(HOST, SIZE);
  const subTerm = await sessions.openTerminal(SUB, SIZE);

  transport.drop();

  assert.deepEqual(exits.sort(), [parentTerm.id, subTerm.id].sort());
  assert.ok(disconnects.includes(HOST.id));
  assert.ok(disconnects.includes(SUB.id));
});

test('disconnecting a sub-host leaves the parent connection alive', async () => {
  const { sessions, transport, disconnects } = harness(new FakeTransport(), resolver);
  await sessions.openTerminal(HOST, SIZE);
  await sessions.openTerminal(SUB, SIZE);

  sessions.disconnectHost(SUB.id);

  assert.ok(transport.isConnected);
  assert.deepEqual(disconnects, [SUB.id]);
});

test('a sub-host with an unknown parent rejects', async () => {
  const { sessions } = harness(new FakeTransport(), () => undefined);

  await assert.rejects(() => sessions.openTerminal(SUB, SIZE), /Parent host not found/);
});

test('a sub-host connect password authenticates the parent', async () => {
  const withPassword: HostConfig = { ...SUB, auth: { password: 'hunter2' } };
  const { sessions, factoryConfigs } = harness(new FakeTransport(), resolver);

  await sessions.openTerminal(withPassword, SIZE);

  assert.equal(factoryConfigs.length, 1);
  assert.equal(factoryConfigs[0].id, HOST.id);
  assert.equal(factoryConfigs[0].auth?.password, 'hunter2');
});

// ---- Via (jump) hosts ------------------------------------------------------

const VM: HostConfig = {
  id: 'v1',
  name: 'web-vm',
  host: '10.10.10.5',
  port: 22,
  user: 'root',
  kind: 'plain',
  via: HOST.id,
};

/** Like harness(), but with one FakeTransport per factory call and the jump
 *  argument captured — via-hosts must not share their jump's transport. */
function viaHarness(resolveHost: (id: string) => HostConfig | undefined) {
  const disconnects: string[] = [];
  const made: Array<{ config: HostConfig; jump?: SshTransport; transport: FakeTransport }> = [];
  const sessions = new SessionManager(
    {
      onTermData: () => {},
      onTermExit: () => {},
      onHostDisconnected: (hostId) => disconnects.push(hostId),
    },
    (config, jump) => {
      const transport = new FakeTransport();
      made.push({ config, jump, transport });
      return transport;
    },
    resolveHost,
  );
  return { sessions, made, disconnects };
}

test('a via-host connects its jump host first and tunnels through it', async () => {
  const { sessions, made } = viaHarness((id) => (id === HOST.id ? HOST : undefined));

  const handle = await sessions.openTerminal(VM, SIZE);

  assert.equal(handle.hostId, VM.id);
  assert.deepEqual(
    made.map((m) => m.config.id),
    [HOST.id, VM.id],
  );
  assert.equal(made[0].jump, undefined);
  assert.equal(made[1].jump, made[0].transport);
  assert.ok(made[0].transport.isConnected);
  assert.ok(made[1].transport.isConnected);
});

test('a via-host reuses an already-connected jump host', async () => {
  const { sessions, made } = viaHarness((id) => (id === HOST.id ? HOST : undefined));
  await sessions.openTerminal(HOST, SIZE);

  await sessions.openTerminal(VM, SIZE);

  assert.deepEqual(
    made.map((m) => m.config.id),
    [HOST.id, VM.id],
  );
});

test('a via-host with an unknown jump host rejects', async () => {
  const { sessions } = viaHarness(() => undefined);

  await assert.rejects(() => sessions.openTerminal(VM, SIZE), /Jump host not found/);
});

test('a via cycle trips the chain depth guard', async () => {
  const a: HostConfig = { ...HOST, id: 'a', via: 'b' };
  const b: HostConfig = { ...VM, id: 'b', via: 'a' };
  const { sessions } = viaHarness((id) => (id === 'a' ? a : id === 'b' ? b : undefined));

  await assert.rejects(() => sessions.openTerminal(a, SIZE), /too deep or cyclic/);
});
