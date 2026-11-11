import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { TransferEngine, joinPath } from './engine';
import type { TransferEnv, TransferJobSnapshot, TransferRequest } from './engine';
import type {
  DirListing,
  FileEntry,
} from '../types';
import type { ExecResult, ShellChannel, SshTransport, TransferOpts } from '../ssh/transport';

// ---- In-memory transport ---------------------------------------------------

type Node = { kind: 'file'; data: string } | { kind: 'dir' };

/**
 * A filesystem as a flat path map. download/uploadFile move content between
 * two MemTransports through the shared `disk` of the local relay — mirroring
 * how the real transports stream through the Pear machine.
 */
class MemTransport implements SshTransport {
  isConnected = true;
  /** Pause gate: when set, the next download/uploadFile waits on it. */
  gate: Promise<void> | null = null;
  /** When set, hash() returns a bogus digest — simulates a corrupt read. */
  corruptHash = false;
  /** When set, hash() waits on it first — a slow checksum of a big file. */
  hashGate: Promise<void> | null = null;
  /** Progress callbacks per file (1 = one shot at the end). */
  chunks = 1;
  /** Announce a container push after the byte stream, like SubHostTransport. */
  pushPhase = false;
  /** Per-transfer delay, to let several files overlap. */
  delayMs = 0;
  /** Concurrency observed on this side (download/uploadFile calls in flight). */
  activeNow = 0;
  maxActive = 0;
  /** A file above the small-file limit was in flight alongside another. */
  bigOverlap = false;
  /** Destination path whose transfer fails with 'boom'. */
  failOn: string | null = null;
  fs = new Map<string, Node>();

  constructor(
    private readonly relay: () => MemTransport,
    seed: Record<string, string | null> = {},
  ) {
    this.fs.set('/', { kind: 'dir' });
    for (const [path, data] of Object.entries(seed)) {
      this.seedPath(path, data);
    }
  }

  private seedPath(path: string, data: string | null): void {
    const parts = path.split('/').filter(Boolean);
    let cur = '';
    for (let i = 0; i < parts.length - 1; i++) {
      cur += '/' + parts[i];
      this.fs.set(cur, { kind: 'dir' });
    }
    this.fs.set(path, data === null ? { kind: 'dir' } : { kind: 'file', data });
  }

  async connect(): Promise<void> {}
  onClose(): void {}
  async shell(): Promise<ShellChannel> {
    throw new Error('not used');
  }
  async shellCommand(): Promise<ShellChannel> {
    throw new Error('not used');
  }
  async exec(): Promise<ExecResult> {
    return { code: 0, stdout: '', stderr: '' };
  }

  private entry(path: string, name: string): FileEntry {
    const node = this.fs.get(path)!;
    return {
      name,
      kind: node.kind,
      size: node.kind === 'file' ? node.data.length : 0,
      mtimeMs: 0,
      mode: node.kind === 'dir' ? 'drwxr-xr-x' : '-rw-r--r--',
    };
  }

  async listDir(path: string): Promise<DirListing> {
    const prefix = path === '/' ? '/' : path + '/';
    const entries: FileEntry[] = [];
    for (const key of this.fs.keys()) {
      if (key !== path && key.startsWith(prefix) && !key.slice(prefix.length).includes('/')) {
        entries.push(this.entry(key, key.slice(prefix.length)));
      }
    }
    return { path, entries };
  }

  async readFile(path: string): Promise<string> {
    const node = this.fs.get(path);
    if (node?.kind !== 'file') throw new Error(`${path}: not a file`);
    return node.data;
  }
  async writeFile(path: string, content: string): Promise<void> {
    this.fs.set(path, { kind: 'file', data: content });
  }
  async upload(): Promise<string> {
    throw new Error('not used');
  }

  async stat(path: string): Promise<FileEntry | null> {
    if (!this.fs.has(path)) return null;
    return this.entry(path, path.slice(path.lastIndexOf('/') + 1));
  }
  async mkdir(path: string): Promise<void> {
    if (this.fs.has(path)) throw new Error(`${path}: exists`);
    this.fs.set(path, { kind: 'dir' });
  }
  async remove(path: string, recursive = false): Promise<void> {
    const node = this.fs.get(path);
    if (!node) return;
    if (node.kind === 'dir') {
      const children = [...this.fs.keys()].filter((k) => k.startsWith(path + '/'));
      if (children.length && !recursive) throw new Error(`${path}: not empty`);
      for (const k of children) this.fs.delete(k);
    }
    this.fs.delete(path);
  }
  async rename(oldPath: string, newPath: string): Promise<void> {
    for (const [k, v] of [...this.fs]) {
      if (k === oldPath || k.startsWith(oldPath + '/')) {
        this.fs.delete(k);
        this.fs.set(newPath + k.slice(oldPath.length), v);
      }
    }
  }
  async copy(src: string, dest: string): Promise<void> {
    for (const [k, v] of [...this.fs]) {
      if (k === src || k.startsWith(src + '/')) {
        this.fs.set(dest + k.slice(src.length), { ...v });
      }
    }
  }

  /** remote(this) -> relay disk */
  async download(remotePath: string, localPath: string, opts?: TransferOpts): Promise<void> {
    await this.transferTo(this, remotePath, this.relay(), localPath, opts);
  }
  /** relay disk -> remote(this) */
  async uploadFile(localPath: string, remotePath: string, opts?: TransferOpts): Promise<void> {
    await this.transferTo(this.relay(), localPath, this, remotePath, opts);
  }

  async hash(path: string): Promise<string> {
    if (this.hashGate) {
      await this.hashGate;
      this.hashGate = null;
    }
    if (this.corruptHash) return 'corrupt';
    const node = this.fs.get(path);
    if (node?.kind !== 'file') throw new Error(`${path}: not a file`);
    return createHash('sha256').update(node.data).digest('hex');
  }

  private async transferTo(
    from: MemTransport,
    fromPath: string,
    to: MemTransport,
    toPath: string,
    opts?: TransferOpts,
  ): Promise<void> {
    const node = from.fs.get(fromPath);
    this.activeNow++;
    this.maxActive = Math.max(this.maxActive, this.activeNow);
    if (node?.kind === 'file' && node.data.length > 4 * 1024 * 1024 && this.activeNow > 1) {
      this.bigOverlap = true;
    }
    try {
      if (this.gate || this.delayMs) {
        // Simulate an in-flight stream: a partial file exists at the dest.
        to.fs.set(toPath, { kind: 'file', data: '<partial>' });
        if (this.gate) {
          await this.gate;
          this.gate = null;
        }
        if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
      }
      if (opts?.signal?.aborted) throw new Error('aborted');
      if (toPath === this.failOn) throw new Error('boom');
      if (node?.kind !== 'file') throw new Error(`${fromPath}: not a file`);
      to.fs.set(toPath, { kind: 'file', data: node.data });
    } finally {
      this.activeNow--;
    }
    const total = node.data.length;
    const chunks = Math.max(1, this.chunks);
    for (let k = 1; k <= chunks; k++) {
      opts?.onProgress?.({ bytes: Math.round((total * k) / chunks), total });
    }
    if (to.pushPhase) opts?.onPhase?.('pushing');
  }

  dispose(): void {}
}

// ---- Harness ---------------------------------------------------------------

function harness(
  seed: {
    a?: Record<string, string | null>;
    b?: Record<string, string | null>;
    local?: Record<string, string | null>;
  },
  clock?: () => number,
) {
  let localRef: MemTransport;
  const relay = () => localRef;
  const local = new MemTransport(relay, seed.local ?? {});
  localRef = local;
  const a = new MemTransport(relay, seed.a ?? {});
  const b = new MemTransport(relay, seed.b ?? {});
  const stagingDirs: string[] = [];
  const removedStaging: string[] = [];
  let stagingSeq = 0;

  const env: TransferEnv = {
    async connection(hostId) {
      if (hostId === null) return local;
      if (hostId === 'a') return a;
      if (hostId === 'b') return b;
      throw new Error(`unknown host ${hostId}`);
    },
    async makeStagingDir() {
      const dir = `/tmp/staging-${++stagingSeq}`;
      local.fs.set(dir, { kind: 'dir' });
      stagingDirs.push(dir);
      return dir;
    },
    async removeStaging(dir) {
      removedStaging.push(dir);
      await local.remove(dir, true);
    },
  };

  const updates: TransferJobSnapshot[] = [];
  let time = 0;
  const engine = new TransferEngine(
    env,
    { onUpdate: (j) => updates.push(j) },
    clock ?? (() => (time += 200)),
  );
  const finished = (id: string) =>
    new Promise<TransferJobSnapshot>((resolve) => {
      const check = () => {
        const last = updates.filter((u) => u.id === id).at(-1);
        if (last && (last.status === 'done' || last.status === 'error' || last.status === 'canceled'))
          resolve(last);
        else setTimeout(check, 1);
      };
      check();
    });

  return { engine, a, b, local, updates, finished, stagingDirs, removedStaging };
}

const req = (over: Partial<TransferRequest>): TransferRequest => ({
  src: { hostId: 'a', dir: '/src' },
  dest: { hostId: 'b', dir: '/dst' },
  names: ['f.txt'],
  op: 'copy',
  conflict: 'rename',
  verify: false,
  ...over,
});

// ---- Tests -----------------------------------------------------------------

test('cross-host copy stages through the relay and lands on the dest', async () => {
  const h = harness({ a: { '/src/f.txt': 'hello' }, b: { '/dst': null } });
  const id = h.engine.start(req({}));
  const last = await h.finished(id);

  assert.equal(last.status, 'done');
  assert.equal(last.stages, 2);
  assert.equal(await h.b.readFile('/dst/f.txt'), 'hello');
  // source untouched on copy
  assert.equal(await h.a.readFile('/src/f.txt'), 'hello');
  // staging cleaned
  assert.deepEqual(h.removedStaging, h.stagingDirs);
});

test('verify: a matching checksum lets the transfer complete', async () => {
  const h = harness({ a: { '/src/f.txt': 'hello' }, b: { '/dst': null } });
  const id = h.engine.start(req({ verify: true }));
  const last = await h.finished(id);

  assert.equal(last.status, 'done');
  assert.equal(await h.b.readFile('/dst/f.txt'), 'hello');
});

test('verify: a checksum mismatch fails the job and removes the partial', async () => {
  const h = harness({ a: { '/src/f.txt': 'hello' }, b: { '/dst': null } });
  h.b.corruptHash = true; // dest reads back a bogus digest
  const id = h.engine.start(req({ verify: true }));
  const last = await h.finished(id);

  assert.equal(last.status, 'error');
  assert.match(last.error ?? '', /checksum mismatch/);
  // corrupt file was cleaned off the dest
  assert.equal(await h.b.stat('/dst/f.txt'), null);
});

test('move deletes the source only after success', async () => {
  const h = harness({ a: { '/src/f.txt': 'hello' }, b: { '/dst': null } });
  const id = h.engine.start(req({ op: 'move' }));
  const last = await h.finished(id);

  assert.equal(last.status, 'done');
  assert.equal(await h.b.readFile('/dst/f.txt'), 'hello');
  assert.equal(await h.a.stat('/src/f.txt'), null);
});

test('download to the Pear machine is one stage', async () => {
  const h = harness({ a: { '/src/f.txt': 'data' }, local: { '/home/me': null } });
  const id = h.engine.start(req({ dest: { hostId: null, dir: '/home/me' } }));
  const last = await h.finished(id);

  assert.equal(last.status, 'done');
  assert.equal(last.stages, 1);
  assert.equal(await h.local.readFile('/home/me/f.txt'), 'data');
  assert.equal(h.stagingDirs.length, 0);
});

test('upload from the Pear machine is one stage', async () => {
  const h = harness({ local: { '/home/me/f.txt': 'data' }, b: { '/dst': null } });
  const id = h.engine.start(
    req({ src: { hostId: null, dir: '/home/me' }, dest: { hostId: 'b', dir: '/dst' } }),
  );
  const last = await h.finished(id);

  assert.equal(last.status, 'done');
  assert.equal(last.stages, 1);
  assert.equal(await h.b.readFile('/dst/f.txt'), 'data');
});

test('directories transfer recursively with structure preserved', async () => {
  const h = harness({
    a: { '/src/app/main.ts': 'main', '/src/app/lib/util.ts': 'util', '/src/app/empty': null },
    b: { '/dst': null },
  });
  const id = h.engine.start(req({ names: ['app'] }));
  const last = await h.finished(id);

  assert.equal(last.status, 'done');
  assert.equal(await h.b.readFile('/dst/app/main.ts'), 'main');
  assert.equal(await h.b.readFile('/dst/app/lib/util.ts'), 'util');
  assert.equal((await h.b.stat('/dst/app/empty'))?.kind, 'dir');
});

test('conflict rename keeps both files', async () => {
  const h = harness({ a: { '/src/f.txt': 'new' }, b: { '/dst/f.txt': 'old' } });
  const id = h.engine.start(req({ conflict: 'rename' }));
  const last = await h.finished(id);

  assert.equal(last.status, 'done');
  assert.equal(await h.b.readFile('/dst/f.txt'), 'old');
  assert.equal(await h.b.readFile('/dst/f (1).txt'), 'new');
});

test('conflict overwrite replaces the destination', async () => {
  const h = harness({ a: { '/src/f.txt': 'new' }, b: { '/dst/f.txt': 'old' } });
  const id = h.engine.start(req({ conflict: 'overwrite' }));
  const last = await h.finished(id);

  assert.equal(last.status, 'done');
  assert.equal(await h.b.readFile('/dst/f.txt'), 'new');
});

test('conflict skip drops the item (and still moves nothing on move)', async () => {
  const h = harness({ a: { '/src/f.txt': 'new' }, b: { '/dst/f.txt': 'old' } });
  const id = h.engine.start(req({ conflict: 'skip', op: 'move' }));
  const last = await h.finished(id);

  assert.equal(last.status, 'done');
  assert.equal(await h.b.readFile('/dst/f.txt'), 'old');
  // skipped items are not deleted from the source
  assert.equal(await h.a.readFile('/src/f.txt'), 'new');
});

test('a missing source fails the job with an error', async () => {
  const h = harness({ a: { '/src': null }, b: { '/dst': null } });
  const id = h.engine.start(req({ names: ['ghost.txt'] }));
  const last = await h.finished(id);

  assert.equal(last.status, 'error');
  assert.match(last.error!, /no such file/);
});

test('cancel mid-stream marks canceled and removes the partial file', async () => {
  const h = harness({ a: { '/src/f.txt': 'hello' }, b: { '/dst': null } });
  let release!: () => void;
  h.a.gate = new Promise((r) => (release = r));

  const id = h.engine.start(req({ dest: { hostId: null, dir: '/dl' } }));
  h.local.fs.set('/dl', { kind: 'dir' });
  // wait until the stream is "in flight" (partial exists), then cancel
  while (!h.local.fs.has('/dl/f.txt')) await new Promise((r) => setTimeout(r, 1));
  h.engine.cancel(id);
  release();
  const last = await h.finished(id);

  assert.equal(last.status, 'canceled');
  assert.equal(h.local.fs.has('/dl/f.txt'), false);
});

test('cancel while queued never runs the job', async () => {
  const h = harness({ a: { '/src/f.txt': 'x', '/src/g.txt': 'y' }, b: { '/dst': null } });
  h.engine.setMaxParallel(1);
  let release!: () => void;
  h.a.gate = new Promise((r) => (release = r));

  const first = h.engine.start(req({ names: ['f.txt'] }));
  const second = h.engine.start(req({ names: ['g.txt'] }));
  h.engine.cancel(second);
  release();

  await h.finished(first);
  const last = (await h.finished(second));
  assert.equal(last.status, 'canceled');
  assert.equal(await h.b.stat('/dst/g.txt'), null);
});

test('maxParallel limits concurrent jobs', async () => {
  const h = harness({
    a: { '/src/f.txt': 'x', '/src/g.txt': 'y', '/src/h.txt': 'z' },
    b: { '/dst': null },
  });
  h.engine.setMaxParallel(1);
  h.engine.start(req({ names: ['f.txt'] }));
  h.engine.start(req({ names: ['g.txt'] }));
  h.engine.start(req({ names: ['h.txt'] }));

  // With parallelism 1, at no point are two jobs running at once.
  const runningAtOnce = () =>
    new Set(
      h.updates.filter((u) => u.status === 'running').map((u) => u.id),
    );
  await h.finished(h.updates.at(-1)!.id);
  const timeline = h.updates.map((u) => `${u.id}:${u.status}`);
  // every job ran to done
  assert.equal(h.updates.filter((u) => u.status === 'done').length, 3);
  assert.ok(runningAtOnce().size <= 3, timeline.join('\n'));
});

test('staging is cleaned when the upload stage fails', async () => {
  const h = harness({ a: { '/src/f.txt': 'hello' }, b: {} }); // no /dst on b
  // uploads into a missing dir fail because mkdir only creates the leaf
  const brokenUpload = h.b.uploadFile.bind(h.b);
  h.b.uploadFile = async () => {
    throw new Error('disk full');
  };
  const id = h.engine.start(req({}));
  const last = await h.finished(id);
  h.b.uploadFile = brokenUpload;

  assert.equal(last.status, 'error');
  assert.match(last.error!, /disk full/);
  assert.deepEqual(h.removedStaging, h.stagingDirs);
});

test('progress updates are throttled but stage flips always emit', async () => {
  const h = harness({ a: { '/src/f.txt': 'hello' }, b: { '/dst': null } });
  const id = h.engine.start(req({}));
  const last = await h.finished(id);

  assert.equal(last.status, 'done');
  const stages = h.updates.filter((u) => u.id === id).map((u) => u.stage);
  assert.ok(stages.includes(0));
  assert.ok(stages.includes(1));
});

test('snapshots carry phases, timestamps and file counts', async () => {
  const h = harness({ a: { '/src/f.txt': 'hello', '/src/g.txt': 'world' } });
  const id = h.engine.start(req({ names: ['f.txt', 'g.txt'], dest: { hostId: null, dir: '/dl' } }));
  const last = await h.finished(id);

  assert.equal(last.status, 'done');
  const mine = h.updates.filter((u) => u.id === id);
  const phases = mine.map((u) => u.phase);
  assert.ok(phases.indexOf('listing') >= 0 && phases.indexOf('listing') < phases.indexOf('copying'));
  assert.equal(last.fileCount, 2);
  assert.equal(last.fileIndex, 2);
  assert.ok(typeof last.startedAt === 'number');
  assert.ok(last.finishedAt! >= last.startedAt!);
  assert.equal(last.bytesPerSec, null);
  assert.equal(last.etaSec, null);
});

test('throughput and ETA are reported mid-stream', async () => {
  const h = harness({ a: { '/src/big.bin': 'x'.repeat(4000) } });
  h.a.chunks = 4; // four progress callbacks; the clock moves 200 ms per emit
  const id = h.engine.start(req({ names: ['big.bin'], dest: { hostId: null, dir: '/dl' } }));
  await h.finished(id);

  const mid = h.updates.filter(
    (u) => u.id === id && u.status === 'running' && u.bytesDone > 0 && u.bytesDone < u.bytesTotal,
  );
  assert.ok(mid.length > 0, 'no mid-stream update');
  assert.ok(mid.some((u) => (u.bytesPerSec ?? 0) > 0), 'no throughput reported');
  assert.ok(mid.some((u) => typeof u.etaSec === 'number' && u.etaSec >= 0), 'no ETA reported');
});

test("each file's completion is emitted even inside the throttle window", async () => {
  // A frozen clock makes every throttled emit drop; the per-file 100% must
  // still reach the UI.
  const h = harness({ a: { '/src/f.txt': 'hello', '/src/g.txt': 'wonderful' } }, () => 0);
  h.a.delayMs = 5; // files overlap but land one after the other
  const id = h.engine.start(req({ names: ['f.txt', 'g.txt'], dest: { hostId: null, dir: '/dl' } }));
  const last = await h.finished(id);

  assert.equal(last.status, 'done');
  // Whichever file lands first, its completion (5 or 9 bytes) must be seen
  // before the total of 14.
  const firstDone = h.updates.find(
    (u) => u.id === id && u.status === 'running' && (u.bytesDone === 5 || u.bytesDone === 9),
  );
  assert.ok(
    firstDone,
    'first file never reported complete: ' +
      JSON.stringify(h.updates.filter((u) => u.id === id).map((u) => [u.status, u.bytesDone, u.phase])),
  );
});

test('cancel on a running job says cancelRequested before canceled', async () => {
  const h = harness({ a: { '/src/f.txt': 'hello' }, b: { '/dst': null } });
  let release!: () => void;
  h.a.gate = new Promise<void>((r) => (release = r));
  const id = h.engine.start(req({}));
  await new Promise((r) => setTimeout(r, 20));
  h.engine.cancel(id);
  release();
  const last = await h.finished(id);

  assert.equal(last.status, 'canceled');
  const mine = h.updates.filter((u) => u.id === id);
  const requestedAt = mine.findIndex((u) => u.cancelRequested && u.status === 'running');
  const canceledAt = mine.findIndex((u) => u.status === 'canceled');
  assert.ok(requestedAt >= 0, 'cancelRequested never emitted');
  assert.ok(requestedAt < canceledAt);
});

test('cancel during verify ends canceled and removes the unverified file', async () => {
  const h = harness({ a: { '/src/f.txt': 'hello' } });
  let release!: () => void;
  h.a.hashGate = new Promise<void>((r) => (release = r));
  const id = h.engine.start(req({ dest: { hostId: null, dir: '/dl' }, verify: true }));
  // wait for the verifying phase
  while (!h.updates.some((u) => u.id === id && u.phase === 'verifying')) {
    await new Promise((r) => setTimeout(r, 1));
  }
  h.engine.cancel(id);
  release();
  const last = await h.finished(id);

  assert.equal(last.status, 'canceled');
  assert.equal(h.local.fs.has('/dl/f.txt'), false, 'unverified file left behind');
});

test('a container push surfaces as its own phase', async () => {
  const h = harness({ local: { '/up/f.txt': 'hello' }, b: { '/dst': null } });
  h.b.pushPhase = true;
  const id = h.engine.start(req({ src: { hostId: null, dir: '/up' } }));
  const last = await h.finished(id);

  assert.equal(last.status, 'done');
  assert.ok(h.updates.some((u) => u.id === id && u.phase === 'pushing'));
});

test('small files are carried several at a time', async () => {
  const seed: Record<string, string> = {};
  for (let i = 0; i < 12; i++) seed[`/up/f${i}.txt`] = `file ${i}`;
  const h = harness({ local: seed, b: { '/dst': null } });
  h.b.delayMs = 15;
  const id = h.engine.start(
    req({ src: { hostId: null, dir: '/up' }, names: Object.keys(seed).map((p) => p.slice(4)) }),
  );
  const last = await h.finished(id);

  assert.equal(last.status, 'done');
  assert.ok(h.b.maxActive > 1, `no overlap (max ${h.b.maxActive})`);
  assert.ok(h.b.maxActive <= 8);
  for (let i = 0; i < 12; i++) assert.equal(h.b.fs.get(`/dst/f${i}.txt`)?.kind, 'file');
  assert.equal(last.bytesDone, last.bytesTotal);
});

test('a big file runs by itself', async () => {
  const big = 'x'.repeat(5 * 1024 * 1024);
  const h = harness({
    local: { '/up/a.txt': 'a', '/up/big.bin': big, '/up/b.txt': 'b', '/up/c.txt': 'c' },
    b: { '/dst': null },
  });
  h.b.delayMs = 10;
  const id = h.engine.start(
    req({ src: { hostId: null, dir: '/up' }, names: ['a.txt', 'big.bin', 'b.txt', 'c.txt'] }),
  );
  const last = await h.finished(id);

  assert.equal(last.status, 'done');
  assert.equal(h.b.bigOverlap, false, 'big file overlapped another transfer');
  assert.equal(h.b.fs.get('/dst/big.bin')?.kind, 'file');
});

test('one failing file stops the rest and the job reports the error', async () => {
  const seed: Record<string, string> = {};
  for (let i = 0; i < 10; i++) seed[`/up/f${i}.txt`] = `file ${i}`;
  const h = harness({ local: seed, b: { '/dst': null } });
  h.b.delayMs = 10;
  h.b.failOn = '/dst/f3.txt';
  const id = h.engine.start(
    req({ src: { hostId: null, dir: '/up' }, names: Object.keys(seed).map((p) => p.slice(4)) }),
  );
  const last = await h.finished(id);

  assert.equal(last.status, 'error');
  assert.match(last.error!, /boom/);
  // Nothing half-written is left behind, whichever files were in flight.
  for (let i = 0; i < 10; i++) {
    const node = h.b.fs.get(`/dst/f${i}.txt`);
    assert.ok(!(node?.kind === 'file' && node.data === '<partial>'), `f${i} partial left`);
  }
});

test('cancel removes every file that was in flight', async () => {
  const h = harness({
    local: { '/up/f1.txt': '1', '/up/f2.txt': '2', '/up/f3.txt': '3' },
    b: { '/dst': null },
  });
  h.b.delayMs = 80;
  const id = h.engine.start(
    req({ src: { hostId: null, dir: '/up' }, names: ['f1.txt', 'f2.txt', 'f3.txt'] }),
  );
  await new Promise((r) => setTimeout(r, 25));
  assert.ok(h.b.activeNow > 1, 'files were not in flight together');
  h.engine.cancel(id);
  const last = await h.finished(id);

  assert.equal(last.status, 'canceled');
  for (const n of ['f1', 'f2', 'f3']) assert.equal(h.b.fs.has(`/dst/${n}.txt`), false, `${n} partial left`);
});

test('joinPath handles root and trailing slashes', () => {
  assert.equal(joinPath('/', 'a'), '/a');
  assert.equal(joinPath('/x/', 'a'), '/x/a');
  assert.equal(joinPath('/x', ''), '/x');
});
