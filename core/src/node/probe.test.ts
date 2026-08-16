import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:net';
import { probeSsh } from './probe';

let sshServer: Server;
let sshPort: number;
let httpServer: Server;
let httpPort: number;
let silentServer: Server;
let silentPort: number;
let closedPort: number;

const listen = (server: Server) =>
  new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port));
  });

before(async () => {
  sshServer = createServer((socket) => socket.write('SSH-2.0-OpenSSH_9.6\r\n'));
  sshPort = await listen(sshServer);

  httpServer = createServer((socket) => socket.write('HTTP/1.1 400 Bad Request\r\n\r\n'));
  httpPort = await listen(httpServer);

  silentServer = createServer(() => {}); // accepts, never speaks
  silentPort = await listen(silentServer);

  // Grab a port that was just freed — nothing listens there anymore.
  const throwaway = createServer();
  closedPort = await listen(throwaway);
  await new Promise((r) => throwaway.close(r));
});

after(() => {
  sshServer.close();
  httpServer.close();
  silentServer.close();
});

test('an SSH banner reports ok with a latency', async () => {
  const result = await probeSsh('127.0.0.1', sshPort);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.ok(result.latencyMs >= 1);
    assert.match(result.banner ?? '', /^SSH-2\.0/);
  }
});

test('an open port that is not sshd is a failure, not a false positive', async () => {
  const result = await probeSsh('127.0.0.1', httpPort);
  assert.deepEqual(result, { ok: false, error: 'other', detail: 'not an SSH listener' });
});

test('a closed port reports refused', async () => {
  const result = await probeSsh('127.0.0.1', closedPort);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error, 'refused');
});

test('a silent listener times out within the budget', async () => {
  const started = Date.now();
  const result = await probeSsh('127.0.0.1', silentPort, 300);
  assert.deepEqual(result, { ok: false, error: 'timeout' });
  assert.ok(Date.now() - started < 2000);
});

test('an unresolvable name reports unreachable', async () => {
  const result = await probeSsh('definitely-not-a-real-host.invalid', 22, 2000);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error, 'unreachable');
});
