import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRemoteBackend, type HostKeyPrompt, type WebSocketLike } from '@pear/core';
import { startScratchSshd, type ScratchSshd } from '@pear/core/dist/node/testing/scratch-sshd';
import WebSocket from 'ws';
import { defaultConfig } from './config';
import { createPearServer, type PearServer } from './server';

let root: string;
let server: PearServer;
let port: number;
let sshd: ScratchSshd;
const closers: (() => void)[] = [];

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'pear-tofu-'));
  sshd = await startScratchSshd();
  server = createPearServer(
    {
      ...defaultConfig(),
      port: 0,
      auth: 'none',
      dataDir: join(root, 'data'),
      uiDir: root,
      mobileDir: root,
    },
    'test',
  );
  ({ port } = await server.listen());
});
after(async () => {
  for (const c of closers) c();
  await server.close();
  sshd.close();
  rmSync(root, { recursive: true, force: true });
});

function client(gate?: (p: HostKeyPrompt) => Promise<boolean>) {
  const api = createRemoteBackend({
    url: `ws://127.0.0.1:${port}/api/ws`,
    socket: (url) =>
      new WebSocket(url, {
        headers: { origin: `http://127.0.0.1:${port}` },
      }) as unknown as WebSocketLike,
    ...(gate ? { hostKeyGate: { confirm: gate } } : {}),
  });
  closers.push(() => api.remote.close());
  return api;
}
const hostInput = (p: number) => ({
  name: 'box',
  host: '127.0.0.1',
  port: p,
  user: 't',
  kind: 'plain' as const,
  auth: { method: 'password' as const, password: 'pw' },
});
const SIZE = { cols: 80, rows: 24 };

test('an unknown key refuses the connection and says exactly which key', async () => {
  const api = client();
  const host = await api.hosts.upsert(hostInput(sshd.port));
  const err = await api.term.open(host.id, SIZE).then(
    () => null,
    (e: Error & { code?: string; data?: HostKeyPrompt }) => e,
  );
  assert.equal(err?.code, 'UNKNOWN_HOST_KEY');
  assert.match(err?.data?.fingerprint ?? '', /^SHA256:[A-Za-z0-9+/]{43}$/);
  assert.equal(err?.data?.keyType, 'ssh-rsa');
  assert.equal(err?.data?.port, sshd.port);
  assert.equal(sshd.shells(), 0); // and no password ever went out
});

test('declining leaves nothing behind; accepting is asked once, stored, and the call just succeeds', async () => {
  let asked = 0;
  let answer = false;
  const api = client(async () => (asked++, answer));
  const host = (await api.hosts.list())[0];
  await assert.rejects(api.term.open(host.id, SIZE), /Unknown host key/);
  assert.equal(asked, 1);

  answer = true;
  // Pollers and the terminal all hit the unknown key at once: one question.
  const [termId] = await Promise.all([
    api.term.open(host.id, SIZE),
    api.orch.get(host.id).catch(() => null),
    api.monitor.sample(host.id).catch(() => null),
  ]);
  assert.equal(typeof termId, 'string');
  assert.equal(asked, 2);
  assert.match(readFileSync(join(root, 'data', 'known_hosts.json'), 'utf8'), /SHA256:/);

  // Trusted now: a client with no gate at all connects without ceremony.
  const plain = client();
  assert.equal(typeof (await plain.term.open(host.id, SIZE)), 'string');
  assert.equal(asked, 2);
});

test('a CHANGED key is its own, louder error and carries both fingerprints', async () => {
  const impostor = await startScratchSshd(); // same address family, new key
  try {
    const api = client();
    const host = await api.hosts.upsert(hostInput(impostor.port));
    // Put a different key on file for that address, as if it had been seen before.
    await api.hostKeys?.trust({
      host: '127.0.0.1',
      port: impostor.port,
      keyType: 'ssh-rsa',
      fingerprint: 'SHA256:' + 'A'.repeat(43),
    });
    const err = await api.term.open(host.id, SIZE).then(
      () => null,
      (e: Error & { code?: string; data?: HostKeyPrompt }) => e,
    );
    assert.equal(err?.code, 'HOST_KEY_CHANGED');
    assert.equal(err?.data?.knownFingerprint, 'SHA256:' + 'A'.repeat(43));
    assert.match(err?.message ?? '', /CHANGED/);
    assert.equal(impostor.shells(), 0);
    await assert.rejects(
      api.hostKeys!.trust({ host: 'x', port: 1, keyType: 'k', fingerprint: 'not-a-fingerprint' }),
      /fingerprint/,
    );
  } finally {
    impostor.close();
  }
});
