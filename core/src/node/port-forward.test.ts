import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { connect as tcpConnect } from 'node:net';
import { Server } from 'ssh2';
import type { HostConfig } from '../types';
import { SshConnection } from './connection';
import { LocalConnection } from './local';
import { PortForwardManager } from './port-forward';

// In-process ssh2 server whose direct-tcpip handler echoes bytes back for
// ECHO_PORT and rejects everything else — enough to prove the whole path:
// local listener → forwardOut leg → remote destination and back.

const ECHO_PORT = 7777;

let server: Server;
let port: number;

before(async () => {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
  });
  server = new Server({ hostKeys: [privateKey] }, (client) => {
    client.on('authentication', (ctx) => ctx.accept());
    client.on('ready', () => {
      client.on('tcpip', (accept, reject, info) => {
        if (info.destPort !== ECHO_PORT) {
          reject();
          return;
        }
        const stream = accept();
        stream.on('data', (d: Buffer) => stream.write(`echo:${d.toString()}`));
      });
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      port = (server.address() as { port: number }).port;
      resolve();
    });
  });
});

after(() => server.close());

const host = (over: Partial<HostConfig> = {}): HostConfig => ({
  id: 'loop',
  name: 'loopback',
  host: '127.0.0.1',
  port,
  user: 'tester',
  kind: 'plain',
  auth: { agent: false, password: 'pw' },
  ...over,
});

async function connected(): Promise<SshConnection> {
  const conn = new SshConnection(host());
  await conn.connect();
  return conn;
}

function roundTrip(localPort: number, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = tcpConnect(localPort, '127.0.0.1', () => socket.write(payload));
    socket.once('data', (d) => {
      socket.destroy();
      resolve(d.toString());
    });
    socket.once('error', reject);
    setTimeout(() => reject(new Error('round-trip timed out')), 3000).unref();
  });
}

test('port forward round-trips bytes and close() frees the local port', async () => {
  const conn = await connected();
  const mgr = new PortForwardManager(async () => conn);

  const info = await mgr.open(host(), ECHO_PORT);
  assert.equal(info.localHost, '127.0.0.1');
  assert.ok(info.localPort > 0);
  assert.equal(await roundTrip(info.localPort, 'ping'), 'echo:ping');
  assert.equal(mgr.list().length, 1);

  assert.equal(mgr.close(info.id), true);
  assert.equal(mgr.list().length, 0);
  await assert.rejects(() => roundTrip(info.localPort, 'x'), /ECONNREFUSED/);
  assert.equal(mgr.close(info.id), false); // idempotent

  conn.dispose();
});

test('refused remote port fails the open() call via the eager probe', async () => {
  const conn = await connected();
  const mgr = new PortForwardManager(async () => conn);
  await assert.rejects(() => mgr.open(host(), ECHO_PORT + 1));
  assert.equal(mgr.list().length, 0);
  conn.dispose();
});

test('non-SSH transports are rejected with a clear error', async () => {
  const mgr = new PortForwardManager(async () => new LocalConnection());
  await assert.rejects(
    () => mgr.open(host({ name: 'my-pc', local: true }), 80),
    /direct SSH connection.*local host/,
  );
});

test('closeForHost tears down all forwards of that host', async () => {
  const conn = await connected();
  const mgr = new PortForwardManager(async () => conn);
  await mgr.open(host(), ECHO_PORT);
  await mgr.open(host(), ECHO_PORT);
  assert.equal(mgr.list().length, 2);
  assert.equal(mgr.closeForHost('loop'), 2);
  assert.equal(mgr.list().length, 0);
  conn.dispose();
});
