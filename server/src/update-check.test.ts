import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRemoteBackend, type RemoteUpdate, type WebSocketLike } from '@pear/core';
import WebSocket from 'ws';
import { defaultConfig } from './config';
import { createPearServer } from './server';
import { isNewer, UpdateCheck } from './update-check';

test('version ordering: numeric, strict, and deaf to anything odd', () => {
  assert.equal(isNewer('v0.10.0', '0.9.9'), true);
  assert.equal(isNewer('1.0.0', '0.99.99'), true);
  assert.equal(isNewer('0.2.0', '0.2.0'), false);
  assert.equal(isNewer('0.1.9', '0.2.0'), false);
  assert.equal(isNewer('v1.0.0-beta.1', '0.1.0'), false); // pre-releases never nag
  assert.equal(isNewer('latest', '0.1.0'), false);
  assert.equal(isNewer('0.2.0', 'dev'), false);
});

test('the check never throws, announces a release once, and distrusts foreign URLs', async () => {
  const seen: RemoteUpdate[] = [];
  let reply: unknown = { tag_name: 'v0.1.0' };
  const check = new UpdateCheck({
    current: '0.1.0',
    repo: 'o/r',
    onUpdate: (u) => seen.push(u),
    fetchJson: async () => {
      if (reply instanceof Error) throw reply;
      return reply;
    },
  });
  assert.equal(await check.checkNow(), null);
  reply = new Error('offline');
  assert.equal(await check.checkNow(), null);
  reply = { message: 'API rate limit exceeded' };
  assert.equal(await check.checkNow(), null);

  reply = { tag_name: 'v0.2.0', html_url: 'https://evil.example/phish' };
  assert.deepEqual(await check.checkNow(), {
    latest: '0.2.0',
    url: 'https://github.com/o/r/releases/latest',
  });
  reply = { tag_name: 'v0.2.0', html_url: 'https://github.com/o/r/releases/tag/v0.2.0' };
  await check.checkNow();
  assert.equal(seen.length, 1); // same version: told once
  assert.equal(check.update?.latest, '0.2.0');
});

test('clients learn of an update live, and again from the hello; the status file tracks idleness', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pear-upd-'));
  const server = createPearServer(
    {
      ...defaultConfig(),
      port: 0,
      auth: 'none',
      dataDir: join(root, 'data'),
      uiDir: root,
      mobileDir: root,
      updateCheck: false,
      enableLocalHost: true,
    },
    '0.1.0-test',
    {
      fetchJson: async () => ({
        tag_name: 'v0.3.0',
        html_url: 'https://github.com/dmytro-kryvyi/pear-ssh/releases/tag/v0.3.0',
      }),
    },
  );
  const { port } = await server.listen();
  const connect = () =>
    createRemoteBackend({
      url: `ws://127.0.0.1:${port}/api/ws`,
      socket: (u) =>
        new WebSocket(u, {
          headers: { origin: `http://127.0.0.1:${port}` },
        }) as unknown as WebSocketLike,
    });
  try {
    const early = connect();
    const heard: string[] = [];
    early.remote.onUpdateAvailable((u) => heard.push(u.latest));
    await early.hosts.list();
    assert.equal(early.remote.hello()?.version, '0.1.0');
    assert.equal(early.remote.hello()?.update, undefined);

    await server.updates.checkNow(); // the daily tick
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(heard, ['0.3.0']);

    const late = connect(); // connects after the fact: it is in the hello
    await late.hosts.list();
    assert.equal(late.remote.hello()?.update?.latest, '0.3.0');
    let lateHeard = '';
    late.remote.onUpdateAvailable((u) => (lateHeard = u.latest));
    assert.equal(lateHeard, '0.3.0');

    const status = () => JSON.parse(readFileSync(join(root, 'data', 'status.json'), 'utf8'));
    assert.equal(status().version, '0.1.0');
    assert.equal(status().terminals, 0);
    const host = await early.hosts.addLocal();
    await early.term.open(host.id, { cols: 80, rows: 24 });
    await new Promise((r) => setTimeout(r, 5500)); // the status writer's beat
    assert.equal(status().terminals, 1);
    assert.equal(status().claudeBusy, false);
    early.remote.close();
    late.remote.close();
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});
