// A streaming tar codec for the transfer fast path: the Pear machine packs a
// tree into a tar stream that `tar -x` on the host unpacks, or unpacks the
// stream `tar -c` on the host produces. Pure: no node imports, so it is
// testable anywhere and keeps the fence around core/src/node intact.
//
// Writer: ustar headers, GNU 'L'/'K' records for names and link targets over
// 100 bytes (after trying the ustar prefix split), 11-digit octal sizes — so
// files must be under 8 GiB; the engine gates the fast path on that. GNU,
// bsdtar and busybox all read this.
//
// Reader: ustar and GNU headers, 'L'/'K', pax 'x'/'g' (path, linkpath, size,
// mtime), base-256 sizes, types 0/NUL/7 (file), 5 (dir), 2 (symlink),
// 1 (hard link); anything else is skipped together with its payload.

// The pure tsconfig has no DOM or Node lib; both exist at runtime everywhere
// this code runs (Node, Electron, WebView).
declare class TextEncoder {
  encode(s: string): Uint8Array;
}
declare class TextDecoder {
  constructor(label?: string);
  decode(b: Uint8Array): string;
}

export type TarEntryType = 'file' | 'dir' | 'symlink' | 'hardlink';

export interface TarEntry {
  /** Normalized: no leading './' or '/', no trailing '/'. */
  path: string;
  type: TarEntryType;
  /** Payload bytes that follow the header (0 for dirs and links). */
  size: number;
  /** Permission bits (0o7777 mask). */
  mode: number;
  mtimeSec: number;
  /** Target for symlinks; the earlier entry's path for hard links. */
  linkpath?: string;
}

export const TAR_BLOCK = 512;
/** Largest size an 11-digit octal field can carry. */
export const TAR_MAX_OCTAL_SIZE = 0o77777777777;

export class TarFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TarFormatError';
  }
}

export class TarTruncatedError extends Error {
  constructor(message = 'tar stream ended in the middle of an entry') {
    super(message);
    this.name = 'TarTruncatedError';
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const LONGLINK = '././@LongLink';

// ---- header layout ----------------------------------------------------------

const F = {
  name: [0, 100],
  mode: [100, 8],
  uid: [108, 8],
  gid: [116, 8],
  size: [124, 12],
  mtime: [136, 12],
  chksum: [148, 8],
  typeflag: [156, 1],
  linkname: [157, 100],
  magic: [257, 6],
  version: [263, 2],
  uname: [265, 32],
  gname: [297, 32],
  devmajor: [329, 8],
  devminor: [337, 8],
  prefix: [345, 155],
} as const;

function putBytes(block: Uint8Array, field: readonly [number, number], bytes: Uint8Array): void {
  block.set(bytes.subarray(0, field[1]), field[0]);
}

function putText(block: Uint8Array, field: readonly [number, number], text: string): void {
  putBytes(block, field, encoder.encode(text));
}

/** Octal, zero-padded to `digits`, NUL-terminated — the ustar convention. */
function putOctal(block: Uint8Array, field: readonly [number, number], value: number): void {
  const digits = field[1] - 1;
  putText(block, field, Math.max(0, Math.floor(value)).toString(8).padStart(digits, '0'));
}

/** The header checksum: every byte summed with the checksum field as spaces. */
export function headerChecksum(block: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < TAR_BLOCK; i++) {
    sum += i >= F.chksum[0] && i < F.chksum[0] + F.chksum[1] ? 0x20 : block[i];
  }
  return sum;
}

export function paddingFor(size: number): number {
  return (TAR_BLOCK - (size % TAR_BLOCK)) % TAR_BLOCK;
}

// ---- writer -----------------------------------------------------------------

const TYPEFLAG: Record<TarEntryType, string> = { file: '0', dir: '5', symlink: '2', hardlink: '1' };

/**
 * Split a long path at a '/' so that the tail fits `name` (100) and the head
 * fits `prefix` (155); null when no split works.
 */
function ustarSplit(bytes: Uint8Array): [Uint8Array, Uint8Array] | null {
  for (let i = bytes.length - 1; i > 0; i--) {
    if (bytes[i] !== 0x2f) continue;
    const head = bytes.subarray(0, i);
    const tail = bytes.subarray(i + 1);
    if (tail.length <= 100 && tail.length > 0 && head.length <= 155) return [head, tail];
  }
  return null;
}

export class TarWriter {
  /** Header blocks for an entry, including any GNU long-name records. */
  header(entry: TarEntry): Uint8Array {
    if (entry.type === 'file' && entry.size > TAR_MAX_OCTAL_SIZE) {
      throw new TarFormatError(`${entry.path}: too large for a ustar header`);
    }
    const parts: Uint8Array[] = [];
    const path = entry.type === 'dir' ? `${entry.path}/` : entry.path;
    const nameBytes = encoder.encode(path);
    let name = nameBytes;
    let prefix: Uint8Array | null = null;
    if (nameBytes.length > 100) {
      const split = ustarSplit(nameBytes);
      if (split) [prefix, name] = split;
      else {
        parts.push(...this.longRecord('L', nameBytes));
        name = nameBytes.subarray(0, 100);
      }
    }
    const linkBytes = encoder.encode(entry.linkpath ?? '');
    let link = linkBytes;
    if (linkBytes.length > 100) {
      parts.push(...this.longRecord('K', linkBytes));
      link = linkBytes.subarray(0, 100);
    }
    parts.push(
      this.block({
        name,
        prefix,
        mode: entry.mode & 0o7777,
        size: entry.type === 'file' ? entry.size : 0,
        mtime: entry.mtimeSec,
        type: TYPEFLAG[entry.type],
        link,
      }),
    );
    return concat(parts);
  }

  /** Zero bytes that bring a payload of `size` bytes up to a block boundary. */
  padding(size: number): Uint8Array {
    return new Uint8Array(paddingFor(size));
  }

  /** End of archive: two zero blocks. */
  end(): Uint8Array {
    return new Uint8Array(TAR_BLOCK * 2);
  }

  private longRecord(type: 'L' | 'K', bytes: Uint8Array): Uint8Array[] {
    const size = bytes.length + 1; // GNU includes the terminating NUL
    const header = this.block({
      name: encoder.encode(LONGLINK),
      prefix: null,
      mode: 0o644,
      size,
      mtime: 0,
      type,
      link: new Uint8Array(0),
    });
    const payload = new Uint8Array(size + paddingFor(size));
    payload.set(bytes);
    return [header, payload];
  }

  private block(h: {
    name: Uint8Array;
    prefix: Uint8Array | null;
    mode: number;
    size: number;
    mtime: number;
    type: string;
    link: Uint8Array;
  }): Uint8Array {
    const b = new Uint8Array(TAR_BLOCK);
    putBytes(b, F.name, h.name);
    putOctal(b, F.mode, h.mode);
    putOctal(b, F.uid, 0);
    putOctal(b, F.gid, 0);
    putOctal(b, F.size, h.size);
    putOctal(b, F.mtime, h.mtime);
    putText(b, F.typeflag, h.type);
    putBytes(b, F.linkname, h.link);
    putText(b, F.magic, 'ustar\0');
    putText(b, F.version, '00');
    putText(b, F.uname, 'root');
    putText(b, F.gname, 'root');
    putOctal(b, F.devmajor, 0);
    putOctal(b, F.devminor, 0);
    if (h.prefix) putBytes(b, F.prefix, h.prefix);
    // 6 digits, NUL, space — what every tar writes and reads.
    putText(b, F.chksum, headerChecksum(b).toString(8).padStart(6, '0') + '\0 ');
    return b;
  }
}

function concat(parts: Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0];
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// ---- reader -----------------------------------------------------------------

function fieldText(block: Uint8Array, field: readonly [number, number]): string {
  const bytes = block.subarray(field[0], field[0] + field[1]);
  let end = 0;
  while (end < bytes.length && bytes[end] !== 0) end++;
  return decoder.decode(bytes.subarray(0, end));
}

function fieldOctal(block: Uint8Array, field: readonly [number, number]): number {
  const text = fieldText(block, field).trim();
  if (!text) return 0;
  const n = parseInt(text, 8);
  if (!Number.isFinite(n)) throw new TarFormatError(`bad octal field: ${JSON.stringify(text)}`);
  return n;
}

/** Size: octal, or GNU base-256 when the top bit of the first byte is set. */
function fieldSize(block: Uint8Array): number {
  const [at, len] = F.size;
  if (block[at] & 0x80) {
    let n = 0;
    for (let i = 1; i < len; i++) n = n * 256 + block[at + i];
    return n;
  }
  return fieldOctal(block, F.size);
}

function isZeroBlock(block: Uint8Array): boolean {
  for (let i = 0; i < TAR_BLOCK; i++) if (block[i] !== 0) return false;
  return true;
}

/** Strip leading './' and '/', trailing '/'; empty when the result is nothing. */
export function normalizeTarPath(raw: string): string {
  let p = raw;
  while (p.startsWith('./') || p.startsWith('/')) p = p.replace(/^(\.\/|\/)+/, '');
  p = p.replace(/\/+$/, '');
  return p;
}

function hasDotDot(path: string): boolean {
  return path.split('/').some((seg) => seg === '..');
}

/** pax records: "<len> <key>=<value>\n", length counted over the whole record. */
function parsePax(payload: Uint8Array): Map<string, string> {
  const out = new Map<string, string>();
  let at = 0;
  while (at < payload.length) {
    let sp = at;
    while (sp < payload.length && payload[sp] !== 0x20) sp++;
    const len = parseInt(decoder.decode(payload.subarray(at, sp)), 10);
    if (!Number.isFinite(len) || len <= 0 || at + len > payload.length) break;
    const record = decoder.decode(payload.subarray(sp + 1, at + len - 1));
    const eq = record.indexOf('=');
    if (eq > 0) out.set(record.slice(0, eq), record.slice(eq + 1));
    at += len;
  }
  return out;
}

type Consumer =
  | { kind: 'entry'; entry: TarEntry }
  | { kind: 'collect'; into: 'L' | 'K' | 'x'; bytes: Uint8Array[] }
  | { kind: 'skip' };

/**
 * Feed it the stream in any chunking; it calls back per entry, per payload
 * piece and at each entry's end. `end()` must be called when the stream
 * closes: it throws TarTruncatedError if an entry was cut short.
 */
export class TarReader {
  private chunks: Uint8Array[] = [];
  private avail = 0;
  /** Payload bytes still owed to the current consumer, then its padding. */
  private consumer: Consumer | null = null;
  private remaining = 0;
  private pad = 0;
  private longName: string | null = null;
  private longLink: string | null = null;
  private pax: Map<string, string> | null = null;
  private zeroBlocks = 0;
  private entryCbs: ((e: TarEntry) => void)[] = [];
  private dataCbs: ((bytes: Uint8Array) => void)[] = [];
  private endCbs: ((e: TarEntry) => void)[] = [];

  /** The end-of-archive marker (two zero blocks) has been seen. */
  atEnd = false;

  onEntry(cb: (e: TarEntry) => void): void {
    this.entryCbs.push(cb);
  }
  /** Payload pieces of the entry announced by the last onEntry. */
  onData(cb: (bytes: Uint8Array) => void): void {
    this.dataCbs.push(cb);
  }
  onEntryEnd(cb: (e: TarEntry) => void): void {
    this.endCbs.push(cb);
  }

  push(chunk: Uint8Array): void {
    if (this.atEnd || chunk.length === 0) return;
    this.chunks.push(chunk);
    this.avail += chunk.length;
    for (;;) {
      if (this.remaining > 0) {
        if (this.avail === 0) return;
        this.drainPayload();
        continue;
      }
      if (this.pad > 0) {
        const take = Math.min(this.pad, this.avail);
        if (take === 0) return;
        this.take(take);
        this.pad -= take;
        if (this.pad > 0) return;
        continue;
      }
      if (this.consumer) this.finishConsumer();
      if (this.avail < TAR_BLOCK) return;
      this.readHeader(this.take(TAR_BLOCK));
      if (this.atEnd) return;
    }
  }

  /** Call when the stream closes. */
  end(): void {
    if (this.atEnd) return;
    if (this.remaining > 0 || this.pad > 0 || this.consumer) {
      throw new TarTruncatedError();
    }
    if (this.avail > 0) {
      throw new TarTruncatedError('tar stream ended inside a header');
    }
  }

  // Hand payload bytes to the current consumer without copying when the
  // leading chunk can be sliced.
  private drainPayload(): void {
    const head = this.chunks[0];
    const take = Math.min(this.remaining, head.length);
    const piece = take === head.length ? head : head.subarray(0, take);
    if (take === head.length) this.chunks.shift();
    else this.chunks[0] = head.subarray(take);
    this.avail -= take;
    this.remaining -= take;
    const c = this.consumer!;
    if (c.kind === 'entry') {
      if (c.entry.type === 'file') for (const cb of this.dataCbs) cb(piece);
    } else if (c.kind === 'collect') c.bytes.push(piece);
  }

  private finishConsumer(): void {
    const c = this.consumer!;
    this.consumer = null;
    if (c.kind === 'entry') {
      for (const cb of this.endCbs) cb(c.entry);
    } else if (c.kind === 'collect') {
      const bytes = concat(c.bytes.length ? c.bytes : [new Uint8Array(0)]);
      if (c.into === 'x') this.pax = parsePax(bytes);
      else {
        let end = bytes.length;
        while (end > 0 && bytes[end - 1] === 0) end--;
        const text = decoder.decode(bytes.subarray(0, end));
        if (c.into === 'L') this.longName = text;
        else this.longLink = text;
      }
    }
  }

  private take(n: number): Uint8Array {
    const head = this.chunks[0];
    if (head.length === n) {
      this.chunks.shift();
      this.avail -= n;
      return head;
    }
    if (head.length > n) {
      this.chunks[0] = head.subarray(n);
      this.avail -= n;
      return head.subarray(0, n);
    }
    const out = new Uint8Array(n);
    let at = 0;
    while (at < n) {
      const c = this.chunks[0];
      const want = n - at;
      if (c.length <= want) {
        out.set(c, at);
        at += c.length;
        this.chunks.shift();
      } else {
        out.set(c.subarray(0, want), at);
        at += want;
        this.chunks[0] = c.subarray(want);
      }
    }
    this.avail -= n;
    return out;
  }

  private readHeader(block: Uint8Array): void {
    if (isZeroBlock(block)) {
      if (++this.zeroBlocks >= 2) this.atEnd = true;
      return;
    }
    if (this.zeroBlocks > 0) throw new TarFormatError('data after an end-of-archive block');
    const expected = fieldOctal(block, F.chksum);
    if (headerChecksum(block) !== expected) throw new TarFormatError('header checksum mismatch');

    const type = String.fromCharCode(block[F.typeflag[0]]);
    const size = fieldSize(block);
    const begin = (consumer: Consumer): void => {
      this.consumer = consumer;
      this.remaining = size;
      this.pad = paddingFor(size);
    };

    if (type === 'L' || type === 'K') return begin({ kind: 'collect', into: type, bytes: [] });
    if (type === 'x') return begin({ kind: 'collect', into: 'x', bytes: [] });
    if (type === 'g') return begin({ kind: 'skip' }); // global pax header: ignored

    const magic = fieldText(block, F.magic);
    const posix = magic === 'ustar' && block[F.magic[0] + 5] === 0;
    let name = fieldText(block, F.name);
    const prefix = posix ? fieldText(block, F.prefix) : '';
    if (prefix) name = `${prefix}/${name}`;
    let linkpath = fieldText(block, F.linkname);
    let mtime = fieldOctal(block, F.mtime);
    let payload = size;
    if (this.longName !== null) name = this.longName;
    if (this.longLink !== null) linkpath = this.longLink;
    if (this.pax) {
      const p = this.pax;
      if (p.has('path')) name = p.get('path')!;
      if (p.has('linkpath')) linkpath = p.get('linkpath')!;
      if (p.has('size')) payload = Number(p.get('size'));
      if (p.has('mtime')) mtime = Math.floor(Number(p.get('mtime')));
    }
    this.longName = this.longLink = null;
    this.pax = null;

    let entryType: TarEntryType | null;
    switch (type) {
      case '0':
      case '\0':
      case '7':
        entryType = 'file';
        break;
      case '5':
        entryType = 'dir';
        break;
      case '2':
        entryType = 'symlink';
        break;
      case '1':
        entryType = 'hardlink';
        break;
      default:
        entryType = null;
    }
    const path = normalizeTarPath(name);
    // Whatever the type, the size field says how many bytes follow; only a
    // file's bytes are content. Unknown types and unsafe paths are skipped.
    this.consumer = null;
    this.remaining = payload;
    this.pad = paddingFor(payload);
    if (entryType === null || !path || hasDotDot(path)) {
      this.consumer = { kind: 'skip' };
      return;
    }
    const entry: TarEntry = {
      path,
      type: entryType,
      size: entryType === 'file' ? payload : 0,
      mode: fieldOctal(block, F.mode) & 0o7777,
      mtimeSec: mtime,
    };
    if (entryType === 'symlink' || entryType === 'hardlink') {
      entry.linkpath = entryType === 'hardlink' ? normalizeTarPath(linkpath) : linkpath;
    }
    this.consumer = { kind: 'entry', entry };
    for (const cb of this.entryCbs) cb(entry);
  }
}
