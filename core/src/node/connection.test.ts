import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { Server } from 'ssh2';
import { SessionManager } from '../ssh/sessions';
import type { HostConfig, TermSize } from '../types';
import { SshConnection } from './connection';

/**
 * Drives the real ssh2 transport through SessionManager against an in-process
 * ssh2 server — the same wiring desktop/src/main.ts uses. Covers the parts the
 * fake-transport tests deliberately don't: the ShellChannel adapter, stderr
 * merging, and the rows/cols argument order of setWindow.
 *
 * Doubles as the behavioural contract for any other SshTransport
 * implementation (e.g. a native Android one).
 */

let server: Server;
let port: number;
let lastResize: { cols: number; rows: number } | null = null;

before(async () => {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
  });

  server = new Server({ hostKeys: [privateKey] }, (client) => {
    client.on('authentication', (ctx) => ctx.accept());
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept();
        session.on('pty', (a) => a?.());
        session.on('window-change', (a, _r, info) => {
          a?.();
          lastResize = { cols: info.cols, rows: info.rows };
        });
        session.on('shell', (acceptShell) => {
          const stream = acceptShell();
          stream.write('motd-banner\r\n');
          stream.stderr.write('stderr-line\r\n');
          stream.on('data', (d: Buffer) => stream.write(`echo:${d.toString()}`));
        });
        session.on('exec', (acceptExec, _rej, info) => {
          const stream = acceptExec();
          stream.write(info.command.includes('pvesh') ? 'PVE\n' : `ran: ${info.command}\n`);
          stream.exit(0);
          stream.end();
        });
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

const SIZE: TermSize = { cols: 80, rows: 24 };
const settle = () => new Promise((r) => setTimeout(r, 250));

function harness() {
  const host: HostConfig = {
    id: 'loop',
    name: 'loopback',
    host: '127.0.0.1',
    port,
    user: 'tester',
    kind: 'plain',
    auth: { agent: false, password: 'pw' },
  };
  const chunks: string[] = [];
  const exits: string[] = [];
  const disconnects: string[] = [];
  const sessions = new SessionManager(
    {
      onTermData: (_id, chunk) => chunks.push(chunk),
      onTermExit: (id) => exits.push(id),
      onHostDisconnected: (id) => disconnects.push(id),
    },
    (cfg) => new SshConnection(cfg),
  );
  return { sessions, host, chunks, exits, disconnects };
}

test('shell stdout and stderr both surface through onTermData', async () => {
  const { sessions, host, chunks } = harness();
  await sessions.openTerminal(host, SIZE);
  await settle();

  const out = chunks.join('');
  assert.match(out, /motd-banner/);
  assert.match(out, /stderr-line/);
  sessions.disposeAll();
});

test('writeTerminal reaches the remote shell', async () => {
  const { sessions, host, chunks } = harness();
  const handle = await sessions.openTerminal(host, SIZE);
  await settle();

  sessions.writeTerminal(handle.id, 'hello\n');
  await settle();

  assert.match(chunks.join(''), /echo:hello/);
  sessions.disposeAll();
});

test('resizeTerminal sends rows and cols the right way round', async () => {
  const { sessions, host } = harness();
  const handle = await sessions.openTerminal(host, SIZE);
  await settle();
  lastResize = null;

  sessions.resizeTerminal(handle.id, { cols: 132, rows: 43 });
  await settle();

  assert.deepEqual(lastResize, { cols: 132, rows: 43 });
  sessions.disposeAll();
});

test('exec returns stdout with an exit code', async () => {
  const { sessions, host } = harness();
  const result = await sessions.exec(host, 'uname -a');

  assert.equal(result.code, 0);
  assert.match(result.stdout, /ran: uname -a/);
  sessions.disposeAll();
});

test('orchestration detection runs over the real transport', async () => {
  const { sessions, host } = harness();
  const facets = await sessions.detectOrchFacets(host);

  assert.equal(facets.proxmox, true);
  assert.equal(facets.docker, false);
  sessions.disposeAll();
});

test('closing a terminal and dropping a host fire their callbacks', async () => {
  const { sessions, host, exits, disconnects } = harness();
  const handle = await sessions.openTerminal(host, SIZE);
  await settle();

  sessions.closeTerminal(handle.id);
  await settle();
  assert.deepEqual(exits, [handle.id]);

  sessions.disconnectHost(host.id);
  await settle();
  assert.deepEqual(disconnects, [host.id]);
  sessions.disposeAll();
});
