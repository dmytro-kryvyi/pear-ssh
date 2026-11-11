import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TAR_BLOCK,
  TarReader,
  TarWriter,
  headerChecksum,
  normalizeTarPath,
  paddingFor,
  type TarEntry,
} from './tar';

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

interface Seen {
  entry: TarEntry;
  data: Uint8Array[];
  ended: boolean;
}

/** Feed `bytes` to a reader in pieces of `chunk` bytes and collect entries. */
function read(bytes: Uint8Array, chunk = bytes.length): { seen: Seen[]; reader: TarReader } {
  const reader = new TarReader();
  const seen: Seen[] = [];
  reader.onEntry((entry) => seen.push({ entry, data: [], ended: false }));
  reader.onData((d) => seen[seen.length - 1].data.push(d));
  reader.onEntryEnd(() => (seen[seen.length - 1].ended = true));
  for (let at = 0; at < bytes.length; at += chunk) reader.push(bytes.subarray(at, at + chunk));
  reader.end();
  return { seen, reader };
}

function pack(entries: { entry: TarEntry; data?: string }[]): Uint8Array {
  const w = new TarWriter();
  const parts: Uint8Array[] = [];
  for (const { entry, data } of entries) {
    parts.push(w.header(entry));
    if (data !== undefined) {
      parts.push(enc(data), w.padding(entry.size));
    }
  }
  parts.push(w.end());
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const file = (path: string, data: string, mode = 0o644): { entry: TarEntry; data: string } => ({
  entry: { path, type: 'file', size: enc(data).length, mode, mtimeSec: 1_700_000_000 },
  data,
});

test('header checksum and padding follow the ustar rules', () => {
  const block = new TarWriter().header({
    path: 'a.txt',
    type: 'file',
    size: 5,
    mode: 0o644,
    mtimeSec: 0,
  });
  assert.equal(block.length, TAR_BLOCK);
  // name, mode, size, magic, checksum formatting
  assert.equal(dec(block.subarray(0, 5)), 'a.txt');
  assert.equal(dec(block.subarray(100, 108)), '0000644\0');
  assert.equal(dec(block.subarray(124, 136)), '00000000005\0');
  assert.equal(dec(block.subarray(257, 263)), 'ustar\0');
  assert.equal(dec(block.subarray(263, 265)), '00');
  const sum = headerChecksum(block);
  assert.equal(dec(block.subarray(148, 156)), sum.toString(8).padStart(6, '0') + '\0 ');
  assert.equal(paddingFor(0), 0);
  assert.equal(paddingFor(5), 507);
  assert.equal(paddingFor(512), 0);
  assert.equal(paddingFor(513), 511);
});

test('round trip: files, dirs, symlinks, modes and mtimes', () => {
  const bytes = pack([
    { entry: { path: 'tree', type: 'dir', size: 0, mode: 0o755, mtimeSec: 1 } },
    file('tree/a.txt', 'hello'),
    file('tree/empty', ''),
    file('tree/x.sh', 'echo', 0o755),
    {
      entry: {
        path: 'tree/link',
        type: 'symlink',
        size: 0,
        mode: 0o777,
        mtimeSec: 2,
        linkpath: 'a.txt',
      },
    },
    {
      entry: {
        path: 'tree/again',
        type: 'hardlink',
        size: 0,
        mode: 0o644,
        mtimeSec: 2,
        linkpath: 'tree/a.txt',
      },
    },
  ]);
  for (const chunk of [bytes.length, 512, 100, 1]) {
    const { seen, reader } = read(bytes, chunk);
    assert.equal(reader.atEnd, true, `chunk ${chunk}`);
    assert.deepEqual(
      seen.map((s) => [
        s.entry.path,
        s.entry.type,
        s.entry.size,
        s.entry.mode,
        s.entry.linkpath ?? '',
        s.ended,
      ]),
      [
        ['tree', 'dir', 0, 0o755, '', true],
        ['tree/a.txt', 'file', 5, 0o644, '', true],
        ['tree/empty', 'file', 0, 0o644, '', true],
        ['tree/x.sh', 'file', 4, 0o755, '', true],
        ['tree/link', 'symlink', 0, 0o777, 'a.txt', true],
        ['tree/again', 'hardlink', 0, 0o644, 'tree/a.txt', true],
      ],
    );
    assert.equal(dec(concat(seen[1].data)), 'hello');
    assert.equal(seen[1].entry.mtimeSec, 1_700_000_000);
    assert.equal(dec(concat(seen[3].data)), 'echo');
  }
});

test('long names: ustar prefix split when a slash allows it, GNU L record otherwise', () => {
  const deep = 'd'.repeat(60) + '/' + 'e'.repeat(60) + '/' + 'f'.repeat(60); // 182, splittable
  const flat = 'g'.repeat(150); // no slash: needs L
  const longLink = 'h'.repeat(120);
  const w = new TarWriter();
  const deepHeader = w.header({ path: deep, type: 'file', size: 0, mode: 0o644, mtimeSec: 0 });
  assert.equal(deepHeader.length, TAR_BLOCK, 'prefix split needs no extra record');
  assert.equal(dec(deepHeader.subarray(345, 345 + 121)), 'd'.repeat(60) + '/' + 'e'.repeat(60));
  const flatHeader = w.header({ path: flat, type: 'file', size: 0, mode: 0o644, mtimeSec: 0 });
  assert.equal(flatHeader.length, TAR_BLOCK * 3, 'L header + payload block + real header');
  assert.equal(dec(flatHeader.subarray(0, 13)), '././@LongLink');
  assert.equal(String.fromCharCode(flatHeader[156]), 'L');

  const bytes = pack([
    file(deep, 'x'),
    file(flat, 'y'),
    {
      entry: { path: 'l', type: 'symlink', size: 0, mode: 0o777, mtimeSec: 0, linkpath: longLink },
    },
  ]);
  const { seen } = read(bytes, 7);
  assert.deepEqual(
    seen.map((s) => [s.entry.path, s.entry.linkpath ?? '']),
    [
      [deep, ''],
      [flat, ''],
      ['l', longLink],
    ],
  );
  assert.equal(dec(concat(seen[1].data)), 'y');
});

test('pax x headers override path, linkpath, size and mtime; g headers are skipped', () => {
  const longPath = 'p'.repeat(300);
  const records = [`path=${longPath}`, 'size=3', 'mtime=1700000000.5', 'linkpath=zzz'];
  const paxBody = records
    .map((r) => {
      // "<len> <record>\n" where len counts itself
      let len = r.length + 3;
      while (`${len} ${r}\n`.length !== len) len = `${len} ${r}\n`.length;
      return `${len} ${r}\n`;
    })
    .join('');
  const w = new TarWriter();
  const rawX = w.header({
    path: 'PaxHeader/x',
    type: 'file',
    size: enc(paxBody).length,
    mode: 0o644,
    mtimeSec: 0,
  });
  rawX[156] = 'x'.charCodeAt(0);
  fixChecksum(rawX);
  const rawG = w.header({
    path: 'pax_global_header',
    type: 'file',
    size: 2,
    mode: 0o644,
    mtimeSec: 0,
  });
  rawG[156] = 'g'.charCodeAt(0);
  fixChecksum(rawG);
  const real = w.header({ path: 'short', type: 'file', size: 3, mode: 0o600, mtimeSec: 7 });
  const bytes = join([
    rawG,
    enc('ab'),
    w.padding(2),
    rawX,
    enc(paxBody),
    w.padding(enc(paxBody).length),
    real,
    enc('abc'),
    w.padding(3),
    w.end(),
  ]);
  const { seen } = read(bytes, 33);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].entry.path, longPath);
  assert.equal(seen[0].entry.mtimeSec, 1_700_000_000);
  assert.equal(seen[0].entry.size, 3);
  assert.equal(dec(concat(seen[0].data)), 'abc');
});

test('base-256 sizes, unknown types and ../ entries are handled', () => {
  const w = new TarWriter();
  // Size 5 in base-256 (GNU): top bit set on byte 0, big-endian value after.
  const big = w.header({ path: 'b', type: 'file', size: 0, mode: 0o644, mtimeSec: 0 });
  big.fill(0, 124, 136);
  big[124] = 0x80;
  big[135] = 5;
  fixChecksum(big);
  const weird = w.header({ path: 'fifo', type: 'file', size: 4, mode: 0o644, mtimeSec: 0 });
  weird[156] = '6'.charCodeAt(0); // fifo: not carried
  fixChecksum(weird);
  const bytes = join([
    big,
    enc('hello'),
    w.padding(5),
    weird,
    enc('junk'),
    w.padding(4),
    w.header({ path: '../escape', type: 'file', size: 2, mode: 0o644, mtimeSec: 0 }),
    enc('no'),
    w.padding(2),
    w.header({ path: 'ok', type: 'file', size: 2, mode: 0o644, mtimeSec: 0 }),
    enc('ok'),
    w.padding(2),
    w.end(),
  ]);
  const { seen } = read(bytes, 100);
  assert.deepEqual(
    seen.map((s) => [s.entry.path, dec(concat(s.data))]),
    [
      ['b', 'hello'],
      ['ok', 'ok'],
    ],
  );
});

test('truncated streams throw; a bad checksum is a format error; trailing padding is fine', () => {
  const bytes = pack([file('a', 'hello world')]);
  // Cut inside the payload.
  assert.throws(() => read(bytes.subarray(0, TAR_BLOCK + 4)), /ended in the middle/);
  // Cut inside a header.
  assert.throws(() => read(bytes.subarray(0, 100)), /inside a header/);
  // Clean end without the zero blocks is tolerated (the caller checks atEnd).
  const noEnd = read(bytes.subarray(0, TAR_BLOCK * 2));
  assert.equal(noEnd.reader.atEnd, false);
  assert.equal(noEnd.seen[0].ended, true);
  // Record padding after the end marker (tar pads to 10 KiB) is ignored.
  const padded = join([bytes, new Uint8Array(TAR_BLOCK * 10)]);
  assert.equal(read(padded, 1000).reader.atEnd, true);
  const corrupt = bytes.slice();
  corrupt[0] ^= 0xff;
  assert.throws(() => read(corrupt), /checksum mismatch/);
});

test('normalizeTarPath strips ./ and / prefixes and trailing slashes', () => {
  assert.equal(normalizeTarPath('./a/b/'), 'a/b');
  assert.equal(normalizeTarPath('././/x'), 'x');
  assert.equal(normalizeTarPath('/abs'), 'abs');
  assert.equal(normalizeTarPath('./'), '');
});

function fixChecksum(block: Uint8Array): void {
  block.set(enc(headerChecksum(block).toString(8).padStart(6, '0') + '\0 '), 148);
}

function concat(parts: Uint8Array[]): Uint8Array {
  return join(parts);
}

function join(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
