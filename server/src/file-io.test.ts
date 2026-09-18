import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HostConfig, TransferJobSnapshot } from '@pear/core';
import { defaultConfig } from './config';
import { safeFileName } from './file-io';
import { createPearServer, type PearServer } from './server';

/**
 * The "remote host" here is the server's own local-host transport: real
 * TransferEngine jobs, real files, no SSH fixture needed.
 */
let root: string;
let server: PearServer;
let port: number;
let host: HostConfig;
const jobs = new Map<string, TransferJobSnapshot>();

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'pear-fileio-'));
  mkdirSync(join(root, 'remote'));
  server = createPearServer(
    {
      ...defaultConfig(),
      port: 0,
      auth: 'none',
      dataDir: join(root, 'data'),
      uiDir: root,
      mobileDir: root,
      enableLocalHost: true,
    },
    'test',
  );
  ({ port } = await server.listen());
  host = (await server.service.invoke('hosts:addLocal', [])) as HostConfig;
  const emit = server.rpc.emit.bind(server.rpc);
  server.rpc.emit = (channel, ...args) => {
    if (channel === 'transfer:update')
      jobs.set((args[0] as TransferJobSnapshot).id, args[0] as TransferJobSnapshot);
    emit(channel, ...args);
  };
});
after(async () => {
  await server.close();
  rmSync(root, { recursive: true, force: true });
});

function call(
  path: string,
  opts: { method?: string; headers?: Record<string, string>; body?: Buffer | string } = {},
) {
  return new Promise<{
    status: number;
    headers: Record<string, string | string[] | undefined>;
    body: Buffer;
  }>((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: opts.method ?? 'GET',
        headers: { origin: `http://127.0.0.1:${port}`, ...opts.headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (d: Buffer) => chunks.push(d));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    req.on('error', reject);
    req.end(opts.body);
  });
}
const settled = async (jobId: string) => {
  for (let i = 0; i < 200; i++) {
    const job = jobs.get(jobId);
    if (job && ['done', 'error', 'canceled'].includes(job.status)) return job;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('job never settled');
};
const stagingDirs = () => readdirSync(tmpdir()).filter((n) => n.startsWith('pear-transfer-'));

test('file names are one segment, never a path', () => {
  assert.equal(safeFileName('notes.txt'), 'notes.txt');
  assert.equal(safeFileName(encodeURIComponent('résumé ✓.pdf')), 'résumé ✓.pdf');
  for (const bad of [
    '',
    '.',
    '..',
    '..%2Fetc%2Fpasswd',
    'a%2Fb',
    'a%5Cb',
    'x%00y',
    '%E0%A4%A',
    'n'.repeat(300),
  ]) {
    assert.equal(safeFileName(bad), null, bad);
  }
});

test('upload: the body streams to the host, and staging is cleaned up', async () => {
  const before = stagingDirs().length;
  const dir = join(root, 'remote');
  const body = Buffer.from('hello from the ipad\n'.repeat(5000));
  const res = await call(
    `/api/upload?hostId=${host.id}&dir=${encodeURIComponent(dir)}&conflict=overwrite`,
    {
      method: 'POST',
      headers: { 'x-pear-filename': encodeURIComponent('from ipad.txt') },
      body,
    },
  );
  assert.equal(res.status, 200, res.body.toString());
  const { jobId } = JSON.parse(res.body.toString());
  assert.equal((await settled(jobId)).status, 'done');
  assert.deepEqual(readFileSync(join(dir, 'from ipad.txt')), body);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(stagingDirs().length, before);
});

test('upload refuses traversal, unknown hosts, foreign origins', async () => {
  const q = `hostId=${host.id}&dir=${encodeURIComponent(join(root, 'remote'))}`;
  const evil = await call(`/api/upload?${q}`, {
    method: 'POST',
    headers: { 'x-pear-filename': '..%2F..%2Fpwned' },
    body: 'x',
  });
  assert.equal(evil.status, 400);
  assert.equal(existsSync(join(root, 'pwned')), false);
  assert.equal(
    (
      await call(`/api/upload?hostId=ghost&dir=%2Ftmp`, {
        method: 'POST',
        headers: { 'x-pear-filename': 'a' },
        body: 'x',
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await call(`/api/upload?${q}`, {
        method: 'POST',
        headers: { 'x-pear-filename': 'a', origin: 'https://evil.example' },
        body: 'x',
      })
    ).status,
    403,
  );
});

test('download: one file arrives as itself — and can never render in our origin', async () => {
  const dir = join(root, 'remote');
  writeFileSync(join(dir, 'evil.html'), '<script>alert(document.cookie)</script>');
  const jobId = (await server.service.invoke('transfers:download', [
    host.id,
    dir,
    ['evil.html'],
    'overwrite',
    false,
  ])) as string;
  assert.equal((await settled(jobId)).status, 'done');
  const res = await call(`/api/dl/${jobId}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.toString(), '<script>alert(document.cookie)</script>');
  assert.equal(res.headers['content-type'], 'application/octet-stream');
  assert.match(String(res.headers['content-disposition']), /^attachment; filename="evil\.html"/);
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.match(String(res.headers['content-security-policy']), /^sandbox/);
  assert.equal((await call('/api/dl/not-a-job')).status, 404);
  // One shot: fetched means gone.
  assert.equal((await call(`/api/dl/${jobId}`)).status, 404);
});

test('download: several entries (or a folder) arrive as a tar', async () => {
  const dir = join(root, 'remote');
  mkdirSync(join(dir, 'conf'));
  writeFileSync(join(dir, 'conf', 'nginx.conf'), 'worker_processes 1;');
  writeFileSync(join(dir, '-rf'), 'a file, not a flag');
  const jobId = (await server.service.invoke('transfers:download', [
    host.id,
    dir,
    ['conf', '-rf'],
    'overwrite',
    false,
  ])) as string;
  assert.equal((await settled(jobId)).status, 'done');
  const res = await call(`/api/dl/${jobId}`);
  assert.equal(res.headers['content-type'], 'application/x-tar');
  assert.match(String(res.headers['content-disposition']), /pear-download\.tar/);
  const out = join(root, 'dl.tar');
  writeFileSync(out, res.body);
  const listing = execFileSync('tar', ['-tf', out]).toString();
  assert.match(listing, /conf\/nginx\.conf/);
  assert.match(listing, /-rf/);
});

test('the dialog-based upload channel explains itself instead of hanging', async () => {
  await assert.rejects(
    server.service.invoke('fs:upload', [host.id, '/tmp', 'skip', false]),
    /browser/,
  );
});
