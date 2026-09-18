import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createRemoteBackend,
  PearDisconnectedError,
  type RemoteBackend,
  type RemoteState,
  type WebSocketLike,
} from '@pear/core';
import { startScratchSshd, type ScratchSshd } from '@pear/core/dist/node/testing/scratch-sshd';
import WebSocket from 'ws';
import { defaultConfig, type ServerConfig } from './config';
import { createPearServer, type PearServer } from './server';

/**
 * core's remote client against the real server and a real SSH terminal: the
 * pairing both Angular apps run on. `ws` stands in for the browser WebSocket.
 */

let sshd: ScratchSshd;
let root: string;
const servers: PearServer[] = [];
const clients: RemoteBackend[] = [];

before(async () => {
  sshd = await startScratchSshd();
  root = mkdtempSync(join(tmpdir(), 'pear-remote-'));
});
after(async () => {
  for (const c of clients) c.remote.close();
  for (const s of servers) await s.close();
  sshd.close();
  rmSync(root, { recursive: true, force: true });
});

let n = 0;
async function boot(over: Partial<ServerConfig> = {}) {
  const config: ServerConfig = {
    ...defaultConfig(),
    port: 0,
    auth: 'none',
    verifyHostKeys: false,
    dataDir: join(root, `d${n++}`),
    uiDir: root,
    mobileDir: root,
    ...over,
  };
  const server = createPearServer(config, 'test');
  servers.push(server);
  const { port } = await server.listen();
  return { server, port, config };
}

function connect(port: number, extra: Partial<Parameters<typeof createRemoteBackend>[0]> = {}) {
  const sockets: WebSocket[] = [];
  const states: RemoteState[] = [];
  const api = createRemoteBackend({
    url: `ws://127.0.0.1:${port}/api/ws`,
    socket: (url) => {
      const ws = new WebSocket(url, { headers: { origin: `http://127.0.0.1:${port}` } });
      sockets.push(ws);
      // `ws` implements the DOM event-handler properties.
      return ws as unknown as WebSocketLike;
    },
    ...extra,
  });
  api.remote.onState((s) => states.push(s));
  clients.push(api);
  return { api, sockets, states, kill: () => sockets[sockets.length - 1].terminate() };
}

const settle = (ms = 250) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, ms = 5000) => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting');
    await settle(20);
  }
};
const SIZE = { cols: 80, rows: 24 };
const hostInput = () => ({
  name: 'loop',
  host: '127.0.0.1',
  port: sshd.port,
  user: 'tester',
  kind: 'plain' as const,
  auth: { method: 'password' as const, password: 'hunter2' },
});

test('it is a PearApi: calls made before the socket opens simply wait for it', async () => {
  const { port } = await boot();
  const { api, states } = connect(port);
  assert.equal(api.remote.state(), 'connecting');
  const host = await api.hosts.upsert(hostInput()); // issued before hello
  assert.equal(host.auth?.hasPassword, true);
  assert.deepEqual(
    (await api.hosts.list()).map((h) => h.name),
    ['loop'],
  );
  assert.deepEqual(states, ['open']);
  assert.equal(api.remote.hello()?.features.claudeOnServer, true);
  assert.deepEqual(await api.hosts.sshConfigEntries(), await api.hosts.sshConfigEntries());
  await assert.rejects(api.fs.list('ghost', '/'), /Unknown host/);
  assert.throws(() => api.transfers.pathForFile({}), /not available/);
});

test('a dropped link is invisible to the terminal: output resumes exactly where it stopped', async () => {
  const { port, server } = await boot();
  const { api, kill, states } = connect(port);
  const host = await api.hosts.upsert(hostInput());
  let screen = '';
  const exits: string[] = [];
  api.term.onData((_id, data) => (screen += data));
  api.term.onExit((id) => exits.push(id));

  const termId = await api.term.open(host.id, SIZE);
  api.term.write(termId, 'one');
  await until(() => screen.includes('echo:one'));

  kill(); // the iPad went to the home screen
  await until(() => api.remote.state() === 'reconnecting');
  server.service.terms.write(termId, 'two'); // the shell keeps talking
  api.term.write(termId, 'typed-while-offline'); // must NOT be replayed later

  await until(() => api.remote.state() === 'open');
  await until(() => screen.includes('echo:two'));
  api.term.write(termId, 'three');
  await until(() => screen.includes('echo:three'));

  assert.equal(screen, server.service.terms.read(termId, null)?.data); // no gap, no duplicate
  assert.equal(screen.includes('typed-while-offline'), false);
  assert.equal(screen.includes('\x1bc'), false); // delta, not a reset
  assert.deepEqual(exits, []);
  assert.deepEqual(states, ['open', 'reconnecting', 'open']);
});

test('in-flight calls reject on drop; calls made while reconnecting ride it out', async () => {
  const { port, server } = await boot();
  const { api, kill } = connect(port);
  await api.hosts.list();
  server.service.override('hosts:probe', () => new Promise(() => {})); // never answers
  const stuck = api.hosts.probe({ addr: 'x', port: 22 });
  await settle(50);
  kill();
  await assert.rejects(stuck, PearDisconnectedError);
  await until(() => api.remote.state() === 'reconnecting');
  assert.deepEqual(await api.hosts.list(), []); // queued, then served after reconnect
});

test('a close requested while offline still reaches the server', async () => {
  const { port, server } = await boot();
  const { api, kill } = connect(port);
  const host = await api.hosts.upsert(hostInput());
  const termId = await api.term.open(host.id, SIZE);
  kill();
  await until(() => api.remote.state() === 'reconnecting');
  api.term.close(termId);
  await until(() => api.remote.state() === 'open');
  await until(() => !server.service.terms.list().some((t) => t.termId === termId && !t.exited));
});

test('server restart: old terminals report exit instead of hanging forever', async () => {
  const first = await boot();
  const { api } = connect(first.port);
  const host = await api.hosts.upsert(hostInput());
  const exits: string[] = [];
  api.term.onExit((id) => exits.push(id));
  const termId = await api.term.open(host.id, SIZE);

  await first.server.close();
  servers.splice(servers.indexOf(first.server), 1);
  await until(() => api.remote.state() === 'reconnecting');
  const second = createPearServer({ ...first.config, port: first.port }, 'test');
  servers.push(second);
  await second.listen();

  await until(() => api.remote.state() === 'open', 15000);
  assert.deepEqual(exits, [termId]);
  assert.deepEqual(
    (await api.hosts.list()).map((h) => h.name),
    ['loop'],
  ); // data survived
});

test('a reloaded page adopts the terminal it lost: clear screen, scrollback, then live', async () => {
  const { port } = await boot();
  const before = connect(port);
  const host = await before.api.hosts.upsert(hostInput());
  const termId = await before.api.term.open(host.id, SIZE);
  before.api.term.write(termId, 'history');
  await settle();
  before.api.remote.close(); // page gone; nothing told the server to close the terminal

  const page = connect(port);
  const found = await page.api.remote.listTerminals();
  assert.deepEqual(
    found.map((t) => [t.termId, t.hostId, t.kind]),
    [[termId, host.id, 'shell']],
  );
  let screen = '';
  page.api.term.onData((id, data) => id === termId && (screen += data));
  await page.api.remote.adoptTerminal(termId, { cols: 90, rows: 20 });
  await until(() => screen.includes('echo:history'));
  assert.ok(screen.startsWith('\x1bc'));
  page.api.term.write(termId, 'live');
  await until(() => screen.includes('echo:live'));
  await assert.rejects(page.api.remote.adoptTerminal('nope', SIZE), /no longer exists/);
});

test('an expired login stops the retry loop and says so', async () => {
  const { port, server } = await boot();
  let signedIn = true;
  const { api, kill } = connect(port, { checkAuth: async () => signedIn });
  await api.hosts.list();
  // From now on the handshake fails, the way a 401 on upgrade looks to a browser.
  signedIn = false;
  server.http.removeAllListeners('upgrade');
  server.http.on('upgrade', (_req, socket) => socket.destroy());
  kill();
  await until(() => api.remote.state() === 'unauthorized');
  await assert.rejects(api.hosts.list(), /Not signed in/);
});

test('resume() finds a dead socket that still claims to be open', async () => {
  const { port } = await boot();
  const { api, sockets } = connect(port);
  await api.hosts.list();
  // A suspended iOS socket: no close event, nothing ever comes back.
  const zombie = sockets[0];
  zombie.removeAllListeners('message');
  (zombie as unknown as WebSocketLike).onmessage = null;
  zombie.send = () => {};
  api.remote.resume();
  await until(() => api.remote.state() === 'reconnecting', 4000);
  await until(() => api.remote.state() === 'open');
  assert.equal(sockets.length, 2);
});
