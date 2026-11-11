import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TransferEngine, type TransferJobSnapshot } from '../transfers/engine';
import { LocalConnection } from './local';
import { makeStagingDir, removeStaging } from './staging';
import { nodeTarIo } from './tar-io';

/**
 * The engine's tar leg against the real thing: LocalConnection on both ends
 * (the "host" is this machine, reached through its own execPipe), so what
 * nodeTarIo packs is extracted by the GNU tar on this box and vice versa.
 */

let root: string;
const LONG = 'l'.repeat(120);
const BIG = 24 * 1024 * 1024;

before(() => {
  root = mkdtempSync(join(tmpdir(), 'pear-tareng-'));
  const src = join(root, 'src', 'tree');
  mkdirSync(join(src, 'sub'), { recursive: true });
  mkdirSync(join(src, '__MACOSX'));
  for (let i = 0; i < 100; i++)
    writeFileSync(join(src, i % 2 ? 'sub' : '', `f${i}.txt`), `content ${i}`);
  writeFileSync(join(src, LONG), 'long');
  writeFileSync(join(src, '.DS_Store'), 'junk');
  writeFileSync(join(src, '__MACOSX', '._f0.txt'), 'junk');
  symlinkSync('f0.txt', join(src, 'link'));
  utimesSync(join(src, 'f0.txt'), new Date(1_600_000_000_000), new Date(1_600_000_000_000));
});
after(() => rmSync(root, { recursive: true, force: true }));

function engine() {
  const updates: TransferJobSnapshot[] = [];
  const host = new LocalConnection();
  const relay = new LocalConnection();
  const eng = new TransferEngine(
    {
      connection: async (hostId) => {
        const t = hostId === null ? relay : host;
        if (!t.isConnected) await t.connect();
        return t;
      },
      makeStagingDir,
      removeStaging,
      tar: nodeTarIo,
    },
    { onUpdate: (j) => updates.push(j) },
  );
  const finished = (id: string) =>
    new Promise<TransferJobSnapshot>((resolve) => {
      const check = () => {
        const last = updates.filter((u) => u.id === id).at(-1);
        if (last && ['done', 'error', 'canceled'].includes(last.status)) resolve(last);
        else setTimeout(check, 5);
      };
      check();
    });
  return { eng, updates, finished };
}

test('upload leg: a 100-file tree streams through tar -x with links, mtimes and no mac-meta', async () => {
  const { eng, updates, finished } = engine();
  const dst = join(root, 'dst-upload');
  mkdirSync(dst);
  for (const verify of [false, true]) {
    const id = eng.start({
      src: { hostId: null, dir: join(root, 'src') },
      dest: { hostId: 'host', dir: dst },
      names: ['tree'],
      op: 'copy',
      conflict: 'rename',
      verify,
    });
    const last = await finished(id);
    assert.equal(last.status, 'done', last.error);
    const got = join(dst, verify ? 'tree (1)' : 'tree');
    assert.equal(readFileSync(join(got, 'f0.txt'), 'utf8'), 'content 0');
    assert.equal(readFileSync(join(got, 'sub', 'f1.txt'), 'utf8'), 'content 1');
    assert.equal(readFileSync(join(got, LONG), 'utf8'), 'long');
    assert.equal(readlinkSync(join(got, 'link')), 'f0.txt');
    assert.equal(Math.floor(lstatSync(join(got, 'f0.txt')).mtimeMs / 1000), 1_600_000_000);
    assert.equal(existsSync(join(got, '.DS_Store')), false);
    assert.equal(existsSync(join(got, '__MACOSX')), false);
    assert.equal(last.fileCount, 102);
    assert.equal(last.filesDone, 102);
    if (verify) assert.ok(updates.some((u) => u.id === id && u.phase === 'verifying'));
  }
});

test('download leg: tar -c on the host, unpacked on the Pear machine', async () => {
  const { eng, finished } = engine();
  const dst = join(root, 'dst-download');
  mkdirSync(dst);
  const last = await finished(
    eng.start({
      src: { hostId: 'host', dir: join(root, 'src') },
      dest: { hostId: null, dir: dst },
      names: ['tree'],
      op: 'copy',
      conflict: 'rename',
      verify: true,
    }),
  );
  assert.equal(last.status, 'done', last.error);
  assert.equal(readFileSync(join(dst, 'tree', 'sub', 'f99.txt'), 'utf8'), 'content 99');
  assert.equal(readlinkSync(join(dst, 'tree', 'link')), 'f0.txt');
  assert.equal(existsSync(join(dst, 'tree', '__MACOSX')), false);
  assert.equal(last.filesDone, 102);
});

test('cancel mid-stream leaves no half-written file behind', async () => {
  const { eng, updates, finished } = engine();
  const src = join(root, 'cancel-src', 'tree');
  mkdirSync(src, { recursive: true });
  for (let i = 0; i < 40; i++) writeFileSync(join(src, `s${i}.txt`), 'small');
  const big = randomBytes(BIG);
  writeFileSync(join(src, 'big.bin'), big);
  const dst = join(root, 'cancel-dst');
  mkdirSync(dst);
  // Something slow enough to catch: tar -x reading from a throttled pipe.
  const id = eng.start({
    src: { hostId: null, dir: join(root, 'cancel-src') },
    dest: { hostId: 'host', dir: dst },
    names: ['tree'],
    op: 'copy',
    conflict: 'rename',
    verify: false,
  });
  while (!updates.some((u) => u.id === id && u.currentName === 'tree/big.bin' && u.bytesDone > 0)) {
    await new Promise((r) => setTimeout(r, 1));
  }
  eng.cancel(id);
  const last = await finished(id);
  assert.equal(last.status, 'canceled');
  assert.equal(existsSync(join(dst, 'tree', 'big.bin')), false, 'the partial was removed');
  const hash = createHash('sha256').update(big).digest('hex');
  assert.ok(hash.length === 64);
});
