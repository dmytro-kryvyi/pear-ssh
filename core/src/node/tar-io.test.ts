import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { randomBytes } from 'node:crypto';
import {
  linkSync,
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
import { LocalConnection } from './local';
import { nodeTarIo } from './tar-io';
import { PipeClosedError } from '../transfers/stream-util';

/**
 * The Node tar glue against the real GNU tar on this machine: what `pack`
 * writes must extract with `tar -x`, and what `tar -c` writes must `unpack`.
 */

let root: string;
const LONG = 'n'.repeat(120);
const DEEP = ['d'.repeat(90), 'e'.repeat(90), 'f'.repeat(90)].join('/'); // > 255: GNU L record
const BIG = 5 * 1024 * 1024;
let bigBytes: Buffer;

before(() => {
  root = mkdtempSync(join(tmpdir(), 'pear-tar-'));
  const src = join(root, 'src', 'tree');
  mkdirSync(join(src, 'sub', 'deeper'), { recursive: true });
  mkdirSync(join(src, 'empty-dir'));
  mkdirSync(join(src, '__MACOSX'));
  mkdirSync(join(src, DEEP.split('/').slice(0, 2).join('/')), { recursive: true });
  writeFileSync(join(src, 'a.txt'), 'hello');
  writeFileSync(join(src, 'sub', 'b.txt'), 'world');
  writeFileSync(join(src, 'sub', 'deeper', 'c.txt'), '');
  writeFileSync(join(src, 'run.sh'), '#!/bin/sh\n', { mode: 0o755 });
  writeFileSync(join(src, LONG), 'long name');
  writeFileSync(join(src, DEEP), 'deep');
  bigBytes = randomBytes(BIG);
  writeFileSync(join(src, 'big.bin'), bigBytes);
  writeFileSync(join(src, '.DS_Store'), 'junk');
  writeFileSync(join(src, '._a.txt'), 'junk');
  writeFileSync(join(src, '__MACOSX', 'x'), 'junk');
  symlinkSync('a.txt', join(src, 'link'));
  linkSync(join(src, 'a.txt'), join(src, 'hard'));
  utimesSync(join(src, 'a.txt'), new Date(1_600_000_000_000), new Date(1_600_000_000_000));
});
after(() => rmSync(root, { recursive: true, force: true }));

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

function conn(): LocalConnection {
  const c = new LocalConnection();
  void c.connect();
  return c;
}

/** Everything `pack` is asked to carry: the tree minus macOS leftovers. */
const FILES = [
  'a.txt',
  'sub/b.txt',
  'sub/deeper/c.txt',
  'run.sh',
  LONG,
  DEEP,
  'big.bin',
  'link',
  'hard',
];
const DIRS = [
  'tree',
  'tree/sub',
  'tree/sub/deeper',
  'tree/empty-dir',
  ...DEEP.split('/')
    .slice(0, 2)
    .map((_, i, a) => 'tree/' + a.slice(0, i + 1).join('/')),
];

test('pack streams a tree that GNU tar -x restores with modes, mtimes and links', async () => {
  const out = join(root, 'out-pack');
  mkdirSync(out);
  const pipe = await conn().execPipe(`tar -x -o -f - -C ${JSON.stringify(out)}`);
  let stderr = '';
  pipe.onStderr((t) => (stderr += t));
  const closed = new Promise<number | null>((r) => pipe.onClose(r));
  const events: string[] = [];
  const hashes = new Map<number, string>();
  await nodeTarIo.pack(
    join(root, 'src'),
    { dirs: DIRS, files: FILES.map((f) => ({ src: `tree/${f}`, entry: `tree/${f}`, size: 0 })) },
    pipe,
    {
      hash: true,
      onEntry: (i, phase, h) => {
        events.push(`${phase}:${i}`);
        if (h) hashes.set(i, h);
      },
      onProgress: () => {},
    },
  );
  assert.equal(await closed, 0, stderr);
  assert.equal(events.filter((e) => e.startsWith('done')).length, FILES.length);

  const got = join(out, 'tree');
  assert.equal(readFileSync(join(got, 'a.txt'), 'utf8'), 'hello');
  assert.equal(readFileSync(join(got, 'sub', 'b.txt'), 'utf8'), 'world');
  assert.equal(readFileSync(join(got, 'sub', 'deeper', 'c.txt'), 'utf8'), '');
  assert.equal(readFileSync(join(got, LONG), 'utf8'), 'long name');
  assert.equal(readFileSync(join(got, DEEP), 'utf8'), 'deep');
  assert.equal(sha(readFileSync(join(got, 'big.bin'))), sha(bigBytes));
  assert.equal(hashes.get(FILES.indexOf('big.bin')), sha(bigBytes));
  assert.equal(lstatSync(join(got, 'run.sh')).mode & 0o777, 0o755);
  assert.equal(Math.floor(lstatSync(join(got, 'a.txt')).mtimeMs / 1000), 1_600_000_000);
  assert.equal(readlinkSync(join(got, 'link')), 'a.txt');
  assert.ok(lstatSync(join(got, 'empty-dir')).isDirectory());
  assert.equal(readFileSync(join(got, 'hard'), 'utf8'), 'hello');
  assert.throws(() => lstatSync(join(got, '.DS_Store')), /ENOENT/);
});

test('unpack restores what GNU tar -c streams, renaming the root and dropping mac-meta', async () => {
  const out = join(root, 'out-unpack');
  mkdirSync(out);
  const pipe = await conn().execPipe(`tar -c -f - -C ${JSON.stringify(join(root, 'src'))} ./tree`);
  const started: string[] = [];
  const done = new Map<string, string | undefined>();
  const result = await nodeTarIo.unpack(pipe, out, {
    hash: true,
    map: (path) => {
      const parts = path.split('/');
      if (parts[0] !== 'tree') return null;
      if (parts.some((p) => p === '__MACOSX' || p === '.DS_Store' || p.startsWith('._')))
        return null;
      return ['renamed', ...parts.slice(1)].join('/');
    },
    onEntry: (rel, phase, h) => (phase === 'start' ? started.push(rel) : done.set(rel, h)),
    onProgress: () => {},
  });
  assert.equal(result.code, 0);
  assert.equal(result.atEnd, true);
  const got = join(out, 'renamed');
  assert.equal(readFileSync(join(got, 'a.txt'), 'utf8'), 'hello');
  assert.equal(readFileSync(join(got, 'sub', 'b.txt'), 'utf8'), 'world');
  assert.equal(readFileSync(join(got, LONG), 'utf8'), 'long name');
  assert.equal(readFileSync(join(got, DEEP), 'utf8'), 'deep');
  assert.equal(sha(readFileSync(join(got, 'big.bin'))), sha(bigBytes));
  assert.equal(done.get('renamed/big.bin'), sha(bigBytes));
  assert.equal(lstatSync(join(got, 'run.sh')).mode & 0o777, 0o755);
  assert.equal(Math.floor(lstatSync(join(got, 'a.txt')).mtimeMs / 1000), 1_600_000_000);
  assert.equal(readlinkSync(join(got, 'link')), 'a.txt');
  assert.equal(readFileSync(join(got, 'hard'), 'utf8'), 'hello', 'hard link carried by GNU tar');
  assert.ok(lstatSync(join(got, 'empty-dir')).isDirectory());
  for (const junk of ['.DS_Store', '._a.txt', '__MACOSX']) {
    assert.throws(() => lstatSync(join(got, junk)), /ENOENT/, junk);
  }
  assert.ok(started.includes('renamed/big.bin'));
});

test('pack fails promptly when the far side quits without reading', async () => {
  const pipe = await conn().execPipe('exit 3');
  const closed = new Promise<number | null>((r) => pipe.onClose(r));
  await assert.rejects(
    nodeTarIo.pack(
      join(root, 'src'),
      { dirs: [], files: [{ src: 'tree/big.bin', entry: 'big.bin', size: BIG }] },
      pipe,
      { onEntry: () => {}, onProgress: () => {} },
    ),
    (err: Error) => err instanceof PipeClosedError,
  );
  assert.equal(await closed, 3);
});

test('unpack rejects a truncated stream and names the entry in flight', async () => {
  const out = join(root, 'out-trunc');
  mkdirSync(out);
  const src = JSON.stringify(join(root, 'src'));
  const pipe = await conn().execPipe(`tar -c -f - -C ${src} ./tree/big.bin | head -c 70000`);
  const started: string[] = [];
  await assert.rejects(
    nodeTarIo.unpack(pipe, out, {
      map: (p) => p,
      onEntry: (rel, phase) => phase === 'start' && started.push(rel),
      onProgress: () => {},
    }),
    /ended in the middle/,
  );
  assert.deepEqual(started, ['tree/big.bin']);
});
