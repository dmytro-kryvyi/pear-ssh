import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FileInfo, FsOpSnapshot, HostConfig, TransferJobSnapshot } from '@pear/core';
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
const ops = new Map<string, FsOpSnapshot>();

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
    if (channel === 'fsop:update') ops.set((args[0] as FsOpSnapshot).id, args[0] as FsOpSnapshot);
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

test('a folder with many files travels as one tar stream, minus macOS metadata', async () => {
  const src = join(root, 'tarsrc', 'tree');
  mkdirSync(join(src, 'sub', '__MACOSX'), { recursive: true });
  for (let i = 0; i < 200; i++) writeFileSync(join(src, i % 3 ? '' : 'sub', `f${i}.txt`), `n${i}`);
  writeFileSync(join(src, 'n'.repeat(120)), 'long');
  writeFileSync(join(src, '.DS_Store'), 'junk');
  writeFileSync(join(src, 'sub', '__MACOSX', '._f0.txt'), 'junk');
  symlinkSync('f1.txt', join(src, 'link'));
  const dest = join(root, 'remote', 'tar-dest');
  mkdirSync(dest);
  for (const verify of [false, true]) {
    const jobId = (await server.service.invoke('transfers:start', [
      {
        src: { hostId: null, dir: join(root, 'tarsrc') },
        dest: { hostId: host.id, dir: dest },
        names: ['tree'],
        op: 'copy',
        conflict: 'rename',
        verify,
      },
    ])) as string;
    const job = await settled(jobId);
    assert.equal(job.status, 'done', job.error);
    const got = join(dest, verify ? 'tree (1)' : 'tree');
    assert.equal(readFileSync(join(got, 'f1.txt'), 'utf8'), 'n1');
    assert.equal(readFileSync(join(got, 'sub', 'f3.txt'), 'utf8'), 'n3');
    assert.equal(readFileSync(join(got, 'n'.repeat(120)), 'utf8'), 'long');
    assert.equal(readlinkSync(join(got, 'link')), 'f1.txt');
    assert.equal(existsSync(join(got, '.DS_Store')), false);
    assert.equal(existsSync(join(got, 'sub', '__MACOSX')), false);
    assert.equal(job.fileCount, 202);
    assert.equal(job.filesDone, 202);
    assert.equal(job.fileIndex, 202);
    assert.ok(typeof job.filesPerSec === 'number' || job.filesPerSec === null);
  }
});

test('the dialog-based upload channel explains itself instead of hanging', async () => {
  await assert.rejects(
    server.service.invoke('fs:upload', [host.id, '/tmp', 'skip', false]),
    /browser/,
  );
});

const opSettled = async (id: string) => {
  for (let i = 0; i < 400; i++) {
    const op = ops.get(id);
    if (op && op.status !== 'running') return op;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('op never settled');
};

test('fs:info and fs:setPerms describe and change a file', async () => {
  const dir = join(root, 'remote', 'props');
  mkdirSync(join(dir, 'sub'), { recursive: true });
  writeFileSync(join(dir, 'a.txt'), 'hello');
  writeFileSync(join(dir, 'sub', 'b.txt'), 'world!');
  const info = (await server.service.invoke('fs:info', [host.id, join(dir, 'a.txt')])) as FileInfo;
  assert.equal(info.kind, 'file');
  assert.equal(info.size, 5);
  assert.equal(info.name, 'a.txt');
  assert.ok(info.owner.length > 0);
  assert.ok(info.mtimeMs > 0);

  await server.service.invoke('fs:setPerms', [host.id, join(dir, 'a.txt'), { mode: 0o600 }]);
  const after = (await server.service.invoke('fs:info', [host.id, join(dir, 'a.txt')])) as FileInfo;
  assert.equal(after.modeText, '-rw-------');

  const deep = (await server.service.invoke('fs:info', [host.id, dir, true])) as FileInfo;
  assert.equal(deep.kind, 'dir');
  assert.deepEqual([deep.dir?.files, deep.dir?.dirs], [2, 1]);

  await assert.rejects(
    server.service.invoke('fs:info', [host.id, join(dir, 'nope')]),
    /No such file/,
  );
});

test('ops: compress then extract run as cancellable background ops', async () => {
  const dir = join(root, 'remote', 'props');
  const tools = (await server.service.invoke('ops:tools', [host.id])) as { tools: string[] };
  assert.ok(tools.tools.includes('tar'));

  const packId = (await server.service.invoke('ops:compress', [
    host.id,
    dir,
    ['a.txt', 'sub'],
    'props.tar.gz',
    'tar.gz',
  ])) as string;
  const packed = await opSettled(packId);
  assert.equal(packed.status, 'done', packed.error);
  assert.equal(packed.label, 'Compress 2 items → props.tar.gz');
  assert.ok(existsSync(join(dir, 'props.tar.gz')));

  const unpackId = (await server.service.invoke('ops:extract', [
    host.id,
    join(dir, 'props.tar.gz'),
    join(dir, 'out'),
  ])) as string;
  const unpacked = await opSettled(unpackId);
  assert.equal(unpacked.status, 'done', unpacked.error);
  assert.deepEqual(unpacked.dirs, [dir, join(dir, 'out')]);
  assert.equal(readFileSync(join(dir, 'out', 'sub', 'b.txt'), 'utf8'), 'world!');

  const listed = (await server.service.invoke('ops:list', [])) as FsOpSnapshot[];
  assert.equal(listed.length, 2);
  await server.service.invoke('ops:clearFinished', []);
  assert.equal(((await server.service.invoke('ops:list', [])) as FsOpSnapshot[]).length, 0);

  await assert.rejects(
    server.service.invoke('ops:extract', [host.id, join(dir, 'a.txt'), dir]),
    /Not a known archive type/,
  );
});
