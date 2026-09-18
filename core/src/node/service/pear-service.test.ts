import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { channelsOf } from '../../rpc/channels';
import type { HostConfig } from '../../types';
import { startScratchSshd, type ScratchSshd } from '../testing/scratch-sshd';
import { PearService, type PearServiceEnv } from './pear-service';

/**
 * The service is what Electron's main process used to do inline; these tests
 * pin that behaviour through the same channel names the IPC bridge uses, so
 * both embedders (ipcMain, pear-server's WebSocket) inherit it.
 */

let sshd: ScratchSshd;
const dirs: string[] = [];
const services: PearService[] = [];

before(async () => {
  sshd = await startScratchSshd();
});
after(async () => {
  for (const s of services) await s.dispose();
  sshd.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const SIZE = { cols: 80, rows: 24 };
const settle = (ms = 250) => new Promise((r) => setTimeout(r, ms));

const cipher = {
  available: () => true,
  encrypt: (plain: string) => Buffer.from(`enc:${plain}`).toString('base64'),
  decrypt: (c: string) => Buffer.from(c, 'base64').toString().replace(/^enc:/, ''),
};

function rig(extra: Partial<PearServiceEnv> = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'pear-svc-'));
  dirs.push(dataDir);
  const events: [string, ...unknown[]][] = [];
  const service = new PearService({
    dataDir,
    cipher,
    emit: (channel, ...args) => events.push([channel, ...args]),
    ...extra,
  });
  services.push(service);
  const addHost = (over: Partial<HostConfig> = {}) =>
    service.invoke('hosts:upsert', [
      {
        name: 'loop',
        host: '127.0.0.1',
        port: sshd.port,
        user: 'tester',
        kind: 'plain',
        auth: { method: 'password', password: 'hunter2' },
        ...over,
      },
    ]) as Promise<HostConfig>;
  const termText = (termId: string) =>
    events
      .filter((e) => e[0] === 'term:data' && e[1] === termId)
      .map((e) => e[2])
      .join('');
  return { service, events, dataDir, addHost, termText };
}

test('every invoke/send channel in the table has a handler', () => {
  const { service } = rig();
  for (const ch of [...channelsOf('invoke'), ...channelsOf('send')]) {
    assert.ok(service.hasHandler(ch), ch);
  }
});

test('secrets are write-only: encrypted at rest, flags across the boundary', async () => {
  const { service, dataDir, addHost } = rig();
  const saved = await addHost();
  assert.equal(saved.auth?.password, undefined);
  assert.equal(saved.auth?.hasPassword, true);
  const listed = (await service.invoke('hosts:list', [])) as HostConfig[];
  assert.equal(JSON.stringify(listed).includes('hunter2'), false);
  const onDisk = readFileSync(join(dataDir, 'hosts.json'), 'utf8');
  assert.equal(onDisk.includes('hunter2'), false);
  // …yet the connect-time chokepoint gets the plaintext back.
  assert.equal(service.resolveHost(saved.id)?.auth?.password, 'hunter2');
});

test('terminal round trip over the term:* channels, with sequence numbers', async () => {
  const { service, events, addHost, termText } = rig();
  const host = await addHost();
  const termId = (await service.invoke('term:open', [host.id, SIZE])) as string;
  await settle();
  assert.match(termText(termId), /motd-banner/);

  service.send('term:write', [termId, 'ping']);
  service.send('term:resize', [termId, { cols: 120, rows: 40 }]);
  await settle();
  assert.match(termText(termId), /echo:ping/);
  assert.deepEqual(sshd.lastResize(), { cols: 120, rows: 40 });

  const dataEvents = events.filter((e) => e[0] === 'term:data' && e[1] === termId);
  const last = dataEvents[dataEvents.length - 1];
  assert.equal(last[3], termText(termId).length);

  service.send('term:close', [termId]);
  await settle();
  assert.ok(events.some((e) => e[0] === 'term:exit' && e[1] === termId));
  assert.equal(service.terms.has(termId), false);
});

test('a client context attaches the opener; its departure follows the policy', async () => {
  const { service, events, addHost } = rig({ termPolicy: { graceMs: 0, ringChars: 1000 } });
  const host = await addHost();
  const termId = (await service.invoke('term:open', [host.id, SIZE], {
    clientId: 'ipad',
  })) as string;
  await settle();
  assert.match(service.terms.read(termId, null)?.data ?? '', /motd-banner/);
  service.terms.detachClient('ipad');
  await settle();
  assert.ok(events.some((e) => e[0] === 'term:exit' && e[1] === termId));
});

test('orch:get persists the detected kind on the stored record, not the decrypted view', async () => {
  const { service, dataDir, addHost } = rig();
  const host = await addHost();
  await service.invoke('orch:get', [host.id]);
  const listed = (await service.invoke('hosts:list', [])) as HostConfig[];
  assert.equal(listed[0].kind, 'proxmox');
  assert.equal(readFileSync(join(dataDir, 'hosts.json'), 'utf8').includes('hunter2'), false);
  assert.equal(service.resolveHost(host.id)?.auth?.password, 'hunter2');
});

test('sub-hosts: jump in, pin, unpin; removing the parent removes the tree', async () => {
  const { service, addHost } = rig();
  const parent = await addHost();
  const sub = (await service.invoke('subhosts:jumpIn', [
    parent.id,
    { type: 'docker', ref: 'web-1' },
    'web-1',
  ])) as HostConfig;
  assert.equal(sub.parentId, parent.id);
  assert.equal(((await service.invoke('subhosts:list', [])) as HostConfig[]).length, 1);

  await service.invoke('subhosts:pin', [sub.id]);
  assert.equal(((await service.invoke('subhosts:list', [])) as HostConfig[]).length, 0);
  assert.equal(((await service.invoke('hosts:list', [])) as HostConfig[]).length, 2);

  await service.invoke('subhosts:unpin', [sub.id]);
  assert.equal(((await service.invoke('hosts:list', [])) as HostConfig[]).length, 1);
  await service.invoke('subhosts:pin', [sub.id]);

  await service.invoke('hosts:remove', [parent.id]);
  assert.deepEqual(await service.invoke('hosts:list', []), []);
  assert.deepEqual(await service.invoke('subhosts:list', []), []);
});

test('feature gates: local host and ssh config can be switched off', async () => {
  const { service } = rig({ features: { localHost: false, sshConfig: false } });
  await assert.rejects(service.invoke('hosts:addLocal', []), /disabled/);
  assert.deepEqual(await service.invoke('hosts:sshConfigEntries', []), []);
  const open = rig();
  const local = (await open.service.invoke('hosts:addLocal', [])) as HostConfig;
  assert.equal(local.local, true);
  // Idempotent.
  assert.equal(((await open.service.invoke('hosts:addLocal', [])) as HostConfig).id, local.id);
});

test('unknown hosts and channels reject; send() never throws', async () => {
  const { service } = rig();
  await assert.rejects(service.invoke('fs:list', ['nope', '/']), /Unknown host/);
  await assert.rejects(service.invoke('no:such', []), /Unknown channel/);
  await assert.rejects(service.invoke('fs:upload', []), /not available/);
  await assert.rejects(
    service.invoke('transfers:download', ['h', '/', [], 'skip', false]),
    /not available/,
  );
  service.send('term:write', [42, null]);
  service.send('no:such', []);
});

test('override swaps a channel; startLocalUpload groups by source dir', async () => {
  const { service, addHost, events } = rig();
  const host = await addHost();
  const src = mkdtempSync(join(tmpdir(), 'pear-up-'));
  dirs.push(src);
  writeFileSync(join(src, 'a.txt'), 'a');
  writeFileSync(join(src, 'b.txt'), 'b');
  service.override('fs:upload', ([hostId, dir]) =>
    service.startLocalUpload(
      String(hostId),
      String(dir),
      [join(src, 'a.txt'), join(src, 'b.txt')],
      'skip',
      false,
    ),
  );
  const ids = (await service.invoke('fs:upload', [host.id, '/tmp'])) as string[];
  assert.equal(ids.length, 1);
  await settle(50);
  assert.ok(events.some((e) => e[0] === 'transfer:update'));
  assert.throws(() => service.override('no:such', () => null), /Unknown channel/);
});

test('UI round-trips fail fast with no client, resolve through claude:uiResponse', async () => {
  const sent: { id: string }[] = [];
  const { service } = rig({ sendUiRequest: (req) => (sent.push(req), true) });
  // Reach the private round-trip the way the executor does.
  const ask = (s: PearService) =>
    (s as unknown as { claudeUiRequest(p: unknown): Promise<unknown> }).claudeUiRequest({
      kind: 'listTerminals',
    });
  const pending = ask(service);
  service.send('claude:uiResponse', [{ id: sent[0].id, ok: true, value: ['t1'] }]);
  assert.deepEqual(await pending, ['t1']);

  const lonely = rig();
  await assert.rejects(ask(lonely.service), /No Pear window or client/);

  const closing = ask(service);
  service.rejectPendingUi('Pear window was closed');
  await assert.rejects(closing, /window was closed/);
});
