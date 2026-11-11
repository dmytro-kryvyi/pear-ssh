import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Server } from 'ssh2';
import { SessionManager } from '../ssh/sessions';
import type { HostConfig, TermSize } from '../types';
import { SshConnection, resolveAuth } from './connection';

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
/** Refuse session channels the way sshd does past MaxSessions. */
let refuseSessions = false;
let hungExecClosed = false;

before(async () => {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
  });

  server = new Server({ hostKeys: [privateKey] }, (client) => {
    client.on('authentication', (ctx) => ctx.accept());
    client.on('ready', () => {
      client.on('session', (accept, reject) => {
        if (refuseSessions) return reject();
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
          if (info.command === 'cat') {
            stream.on('data', (d: Buffer) => stream.write(d));
            stream.on('end', () => {
              stream.exit(0);
              stream.end();
            });
            return;
          }
          if (info.command === 'fail') {
            stream.stderr.write('bad things\n');
            stream.exit(3);
            stream.end();
            return;
          }
          if (info.command.includes('hang')) {
            // Never exits — a wedged docker daemon, from the client's side. The
            // session closing is what frees one of sshd's MaxSessions slots.
            session.on('close', () => (hungExecClosed = true));
            return;
          }
          stream.write(
            info.command.includes('pvesh') ? 'FACET:proxmox\n' : `ran: ${info.command}\n`,
          );
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

test('exec past its deadline rejects and closes the channel', async () => {
  const { sessions, host } = harness();
  hungExecClosed = false;
  try {
    await assert.rejects(
      sessions.exec(host, 'docker stats hang', { timeoutMs: 200 }),
      (err: Error) =>
        err.name === 'ExecTimeoutError' && /timed out after 0 s: docker stats hang/.test(err.message),
    );
    await settle();
    assert.equal(hungExecClosed, true);
    // The connection itself is fine afterwards.
    assert.match((await sessions.exec(host, 'true')).stdout, /ran: true/);
  } finally {
    sessions.disposeAll();
  }
});

test('a refused session channel reads as the MaxSessions limit, not an ssh2 code', async () => {
  const { sessions, host } = harness();
  await sessions.exec(host, 'true'); // connect while sessions are still allowed
  refuseSessions = true;
  try {
    for (const open of [
      () => sessions.exec(host, 'docker ps'),
      () => sessions.openTerminal(host, SIZE),
      () => sessions.listDir(host, '/'),
    ]) {
      await assert.rejects(open, (err: Error) => {
        assert.match(err.message, /^loopback refused to open another SSH session.*MaxSessions/);
        return true;
      });
    }
  } finally {
    refuseSessions = false;
    sessions.disposeAll();
  }
});

test('execPipe carries stdin to the command and its stdout, stderr and exit back', async () => {
  const { sessions, host } = harness();
  try {
    const conn = await sessions.connection(host);
    const echo = await conn.execPipe!('cat');
    const chunks: Uint8Array[] = [];
    echo.onData((c) => chunks.push(c));
    const closed = new Promise<number | null>((r) => echo.onClose(r));
    echo.write(new TextEncoder().encode('ping '));
    echo.write(new TextEncoder().encode('pong'));
    echo.end();
    assert.equal(await closed, 0);
    assert.equal(Buffer.concat(chunks).toString(), 'ping pong');

    const failing = await conn.execPipe!('fail');
    let stderr = '';
    failing.onStderr((t) => (stderr += t));
    const code = await new Promise<number | null>((r) => failing.onClose(r));
    assert.equal(code, 3);
    assert.equal(stderr, 'bad things\n');

    const hung = await conn.execPipe!('hang');
    const hungClosed = new Promise<number | null>((r) => hung.onClose(r));
    hung.close();
    assert.equal(await hungClosed, null, 'a torn-down channel has no exit status');
  } finally {
    sessions.disposeAll();
  }
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

// ---- resolveAuth method mapping --------------------------------------------

const withAgentSock = (value: string | undefined, fn: () => void) => {
  const saved = process.env.SSH_AUTH_SOCK;
  if (value === undefined) delete process.env.SSH_AUTH_SOCK;
  else process.env.SSH_AUTH_SOCK = value;
  try {
    fn();
  } finally {
    if (saved === undefined) delete process.env.SSH_AUTH_SOCK;
    else process.env.SSH_AUTH_SOCK = saved;
  }
};

const authHost = (auth: HostConfig['auth']): HostConfig => ({
  id: 'x',
  name: 'x',
  host: 'x',
  port: 22,
  user: 'u',
  kind: 'plain',
  auth,
});

test('method password uses password only — no agent, no keys', () => {
  const keyDir = mkdtempSync(join(tmpdir(), 'pear-key-'));
  const keyPath = join(keyDir, 'id_test');
  writeFileSync(keyPath, 'FAKE-KEY');
  try {
    withAgentSock('/tmp/agent.sock', () => {
      const out = resolveAuth(authHost({ method: 'password', password: 'pw', privateKeyPath: keyPath }));
      assert.deepEqual(out, { password: 'pw', tryKeyboard: true });
    });
  } finally {
    rmSync(keyDir, { recursive: true, force: true });
  }
});

test('method agent uses the agent only, honoring agentForward', () => {
  withAgentSock('/tmp/agent.sock', () => {
    assert.deepEqual(resolveAuth(authHost({ method: 'agent' })), { agent: '/tmp/agent.sock' });
    assert.deepEqual(resolveAuth(authHost({ method: 'agent', agentForward: true })), {
      agent: '/tmp/agent.sock',
      agentForward: true,
    });
  });
  withAgentSock(undefined, () => {
    assert.deepEqual(resolveAuth(authHost({ method: 'agent' })), {});
  });
});

test('method key reads the explicit key and skips the agent', () => {
  const keyDir = mkdtempSync(join(tmpdir(), 'pear-key-'));
  const keyPath = join(keyDir, 'id_test');
  writeFileSync(keyPath, 'FAKE-KEY');
  try {
    withAgentSock('/tmp/agent.sock', () => {
      const out = resolveAuth(authHost({ method: 'key', privateKeyPath: keyPath, passphrase: 'pp' }));
      assert.equal(out.privateKey?.toString(), 'FAKE-KEY');
      assert.equal(out.passphrase, 'pp');
      assert.equal(out.agent, undefined);
      assert.equal(out.password, undefined);
    });
  } finally {
    rmSync(keyDir, { recursive: true, force: true });
  }
});

test('undefined method keeps the legacy chain: agent plus explicit key plus password', () => {
  const keyDir = mkdtempSync(join(tmpdir(), 'pear-key-'));
  const keyPath = join(keyDir, 'id_test');
  writeFileSync(keyPath, 'FAKE-KEY');
  try {
    withAgentSock('/tmp/agent.sock', () => {
      const out = resolveAuth(authHost({ privateKeyPath: keyPath, password: 'pw' }));
      assert.equal(out.agent, '/tmp/agent.sock');
      assert.equal(out.privateKey?.toString(), 'FAKE-KEY');
      assert.deepEqual([out.password, out.tryKeyboard], ['pw', true]);
    });
    withAgentSock('/tmp/agent.sock', () => {
      // agent: false opts out of the running agent, exactly as before
      const out = resolveAuth(authHost({ agent: false, privateKeyPath: keyPath }));
      assert.equal(out.agent, undefined);
      assert.equal(out.privateKey?.toString(), 'FAKE-KEY');
    });
  } finally {
    rmSync(keyDir, { recursive: true, force: true });
  }
});
