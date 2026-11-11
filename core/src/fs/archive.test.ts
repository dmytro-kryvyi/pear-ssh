import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  archiveKind,
  archiveStem,
  availableFormats,
  compressCommand,
  defaultFormat,
  detectArchiveTools,
  extractCommand,
  isSingleFileKind,
  parseTools,
  type ArchiveTools,
} from './archive';
import { planCompress, planExtract } from './archive-ops';

const gnu: ArchiveTools = { tools: ['tar', 'gzip', 'xz', 'zstd', 'unzip', 'zip'], tar: 'gnu' };
const busy: ArchiveTools = { tools: ['tar', 'gzip', 'zstd'], tar: 'busybox' };
const mac: ArchiveTools = { tools: ['tar', 'bsdtar', 'gzip', 'zip', 'unzip'], tar: 'bsd' };
const bare: ArchiveTools = { tools: [], tar: 'none' };
const seven: ArchiveTools = { tools: ['7z'], tar: 'none' };

test('archiveKind by suffix, case-insensitive', () => {
  assert.equal(archiveKind('a.tar.gz'), 'tar.gz');
  assert.equal(archiveKind('A.TGZ'), 'tar.gz');
  assert.equal(archiveKind('a.tar.zst'), 'tar.zst');
  assert.equal(archiveKind('a.tbz2'), 'tar.bz2');
  assert.equal(archiveKind('a.tar'), 'tar');
  assert.equal(archiveKind('a.zip'), 'zip');
  assert.equal(archiveKind('a.7z'), '7z');
  assert.equal(archiveKind('a.rar'), 'rar');
  assert.equal(archiveKind('notes.txt.gz'), 'gz');
  assert.equal(archiveKind('README'), null);
  assert.equal(archiveKind('.gz'), null);
});

test('archiveStem strips the archive suffix only', () => {
  assert.equal(archiveStem('assets.tar.gz', 'tar.gz'), 'assets');
  assert.equal(archiveStem('Site.TGZ', 'tar.gz'), 'Site');
  assert.equal(archiveStem('notes.txt.gz', 'gz'), 'notes.txt');
  assert.ok(isSingleFileKind('gz'));
  assert.ok(!isSingleFileKind('tar.gz'));
});

test('parseTools detects the tar flavour', () => {
  assert.deepEqual(parseTools('TOOL:tar\nTOOL:gzip\nTARV:tar (GNU tar) 1.35\n'), {
    tools: ['tar', 'gzip'],
    tar: 'gnu',
  });
  assert.equal(parseTools('TOOL:tar\nTARV:bsdtar 3.7.4 - libarchive 3.7.4\n').tar, 'bsd');
  assert.equal(parseTools('TOOL:tar\nTARV:\n').tar, 'busybox');
  assert.equal(parseTools('TOOL:zip\nTARV:\n').tar, 'none');
  assert.deepEqual(parseTools('TOOL:bogus\n').tools, []);
});

test('detectArchiveTools never throws', async () => {
  const t = await detectArchiveTools(async () => {
    throw new Error('no shell');
  });
  assert.deepEqual(t, { tools: [], tar: 'none' });
});

test('extract commands per kind and toolbox', () => {
  const a = "/d/it's.tar.gz";
  assert.equal(
    extractCommand('tar.gz', a, '/d/out', gnu),
    `mkdir -p -- '/d/out' && tar -x -z -f '/d/it'\\''s.tar.gz' -C '/d/out'`,
  );
  assert.equal(
    extractCommand('tar.xz', '/a.tar.xz', '/o', gnu),
    `mkdir -p -- '/o' && tar -x -J -f '/a.tar.xz' -C '/o'`,
  );
  assert.equal(
    extractCommand('tar.zst', '/a', '/o', gnu),
    `mkdir -p -- '/o' && tar -x --zstd -f '/a' -C '/o'`,
  );
  assert.equal(
    extractCommand('tar.zst', '/a', '/o', busy),
    `mkdir -p -- '/o' && zstd -dc '/a' | tar -x -f - -C '/o'`,
  );
  assert.equal(
    extractCommand('tar.zst', '/a', '/o', mac),
    `mkdir -p -- '/o' && tar -x --zstd -f '/a' -C '/o'`,
  );
  assert.equal(extractCommand('tar.xz', '/a', '/o', busy), null);
  assert.equal(
    extractCommand('tar.xz', '/a', '/o', mac),
    `mkdir -p -- '/o' && tar -x -J -f '/a' -C '/o'`,
  );
  assert.equal(
    extractCommand('tar.xz', '/a', '/o', { tools: ['bsdtar'], tar: 'none' }),
    `mkdir -p -- '/o' && bsdtar -x -J -f '/a' -C '/o'`,
  );
  assert.equal(
    extractCommand('zip', '/a.zip', '/o', gnu),
    `mkdir -p -- '/o' && unzip -o -q '/a.zip' -d '/o'`,
  );
  assert.equal(extractCommand('zip', '/a.zip', '/o', busy), null);
  assert.equal(
    extractCommand('zip', '/a.zip', '/o', seven),
    `mkdir -p -- '/o' && 7z x -y -o'/o' '/a.zip'`,
  );
  assert.equal(
    extractCommand('7z', '/a.7z', '/o', mac),
    `mkdir -p -- '/o' && bsdtar -x -f '/a.7z' -C '/o'`,
  );
  assert.equal(
    extractCommand('rar', '/a.rar', '/o', { tools: ['unrar'], tar: 'none' }),
    `mkdir -p -- '/o' && unrar x -o+ '/a.rar' '/o/'`,
  );
  assert.equal(
    extractCommand('gz', '/d/notes.txt.gz', '/d', gnu),
    `mkdir -p -- '/d' && gzip -dc '/d/notes.txt.gz' > '/d/notes.txt'`,
  );
  assert.equal(extractCommand('tar', '/a.tar', '/o', bare), null);
});

test('compress commands per format and toolbox', () => {
  assert.equal(
    compressCommand('tar.gz', '/d', ['a', "b c'"], '/d/x.tar.gz', gnu),
    `cd -- '/d' && tar -c -z -f '/d/x.tar.gz' -- 'a' 'b c'\\'''`,
  );
  assert.equal(
    compressCommand('tar', '/d', ['a'], '/d/x.tar', gnu),
    `cd -- '/d' && tar -c -f '/d/x.tar' -- 'a'`,
  );
  assert.equal(
    compressCommand('tar.zst', '/d', ['a'], '/d/x', gnu),
    `cd -- '/d' && tar -c --zstd -f '/d/x' -- 'a'`,
  );
  assert.equal(
    compressCommand('tar.zst', '/d', ['a'], '/d/x', busy),
    `cd -- '/d' && tar -c -f - -- 'a' | zstd -q -o '/d/x'`,
  );
  assert.equal(
    compressCommand('tar.xz', '/d', ['a'], '/d/x', mac),
    `cd -- '/d' && tar -c -J -f '/d/x' -- 'a'`,
  );
  assert.equal(
    compressCommand('zip', '/d', ['a'], '/d/x.zip', gnu),
    `cd -- '/d' && zip -r -q -- '/d/x.zip' 'a'`,
  );
  assert.equal(
    compressCommand('zip', '/d', ['a'], '/d/x.zip', { tools: ['bsdtar'], tar: 'none' }),
    `cd -- '/d' && bsdtar -a -c -f '/d/x.zip' -- 'a'`,
  );
  assert.equal(
    compressCommand('zip', '/d', ['a'], '/d/x.zip', seven),
    `cd -- '/d' && 7z a -y -tzip -- '/d/x.zip' 'a'`,
  );
  assert.equal(
    compressCommand('7z', '/d', ['a'], '/d/x.7z', seven),
    `cd -- '/d' && 7z a -y -- '/d/x.7z' 'a'`,
  );
  assert.equal(compressCommand('7z', '/d', ['a'], '/d/x.7z', gnu), null);
  assert.equal(compressCommand('tar.bz2', '/d', ['a'], '/d/x', busy), null);
});

test('availableFormats and defaultFormat follow the toolbox', () => {
  assert.deepEqual(
    availableFormats(gnu).map((f) => f.format),
    ['tar.gz', 'zip', 'tar.xz', 'tar.zst', 'tar'],
  );
  assert.deepEqual(
    availableFormats(seven).map((f) => f.format),
    ['zip', '7z'],
  );
  assert.deepEqual(availableFormats(bare), []);
  assert.equal(defaultFormat(gnu), 'tar.gz');
  assert.equal(defaultFormat(seven), 'zip');
  assert.equal(defaultFormat(bare), null);
});

test('planExtract labels, dirs and errors', () => {
  const sub = planExtract(gnu, '/srv/assets.tar.gz', '/srv/assets');
  assert.equal(sub.label, 'Extract assets.tar.gz → assets/');
  assert.deepEqual(sub.dirs, ['/srv', '/srv/assets']);
  assert.equal(sub.result, '/srv/assets');
  const here = planExtract(gnu, '/srv/a.zip', '/srv');
  assert.equal(here.label, 'Extract a.zip → ./');
  assert.deepEqual(here.dirs, ['/srv']);
  assert.throws(() => planExtract(gnu, '/srv/README', '/srv'), /Not a known archive type/);
  assert.throws(() => planExtract(busy, '/srv/a.zip', '/srv'), /needs unzip, bsdtar or 7z/);
});

test('planCompress labels and validation', () => {
  const one = planCompress(gnu, '/srv', ['web'], 'web.tar.gz', 'tar.gz');
  assert.equal(one.label, 'Compress web → web.tar.gz');
  assert.equal(one.result, '/srv/web.tar.gz');
  assert.deepEqual(one.dirs, ['/srv']);
  assert.equal(
    planCompress(gnu, '/', ['a', 'b'], 'x.zip', 'zip').label,
    'Compress 2 items → x.zip',
  );
  assert.throws(() => planCompress(gnu, '/srv', [], 'x.tar', 'tar'), /Nothing selected/);
  assert.throws(() => planCompress(gnu, '/srv', ['../etc'], 'x.tar', 'tar'), /Invalid name/);
  assert.throws(() => planCompress(bare, '/srv', ['a'], 'x.tar', 'tar'), /No tool on this host/);
});
