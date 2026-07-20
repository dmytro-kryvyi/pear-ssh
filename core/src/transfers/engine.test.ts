import { test } from 'node:test';
import assert from 'node:assert/strict';
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

  private async transferTo(
    from: MemTransport,
    fromPath: string,
    to: MemTransport,
    toPath: string,
    opts?: TransferOpts,
  ): Promise<void> {
    if (this.gate) {
      // Simulate an in-flight stream: a partial file exists at the dest.
      to.fs.set(toPath, { kind: 'file', data: '<partial>' });
      await this.gate;
      this.gate = null;
    }
    if (opts?.signal?.aborted) throw new Error('aborted');
    const node = from.fs.get(fromPath);
    if (node?.kind !== 'file') throw new Error(`${fromPath}: not a file`);
    to.fs.set(toPath, { kind: 'file', data: node.data });
    opts?.onProgress?.({ bytes: node.data.length, total: node.data.length });
  }

  dispose(): void {}
}

// ---- Harness ---------------------------------------------------------------

function harness(seed: {
  a?: Record<string, string | null>;
  b?: Record<string, string | null>;
  local?: Record<string, string | null>;
}) {
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
  const engine = new TransferEngine(env, { onUpdate: (j) => updates.push(j) }, () => (time += 200));
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

test('joinPath handles root and trailing slashes', () => {
  assert.equal(joinPath('/', 'a'), '/a');
  assert.equal(joinPath('/x/', 'a'), '/x/a');
  assert.equal(joinPath('/x', ''), '/x');
});
