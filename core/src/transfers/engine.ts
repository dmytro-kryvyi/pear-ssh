import type { AbortSignalLike, SshTransport } from '../ssh/transport';
import { uuid } from '../uuid';

// Moves files between hosts without ever holding content in memory: same-host
// operations never come here (the UI calls rename/copy directly); everything
// else is streamed through the transports, cross-host via a staging directory
// on the Pear machine (the local relay) — download stage, then upload stage.

export type ConflictPolicy = 'rename' | 'overwrite' | 'skip';
export type TransferOp = 'copy' | 'move';
export type TransferStatus = 'queued' | 'running' | 'done' | 'error' | 'canceled';

/** `hostId: null` is the Pear machine itself (paths are absolute). */
export interface TransferEndpoint {
  hostId: string | null;
  dir: string;
}

export interface TransferRequest {
  src: TransferEndpoint;
  dest: TransferEndpoint;
  /** Entry names inside src.dir. */
  names: string[];
  op: TransferOp;
  conflict: ConflictPolicy;
}

export interface TransferJobSnapshot {
  id: string;
  label: string;
  src: TransferEndpoint;
  dest: TransferEndpoint;
  op: TransferOp;
  /** 1 = plain upload or download; 2 = cross-host relay. */
  stages: 1 | 2;
  /** 0 while downloading, 1 while uploading. */
  stage: 0 | 1;
  /** Bytes done within the current stage; total is per stage. */
  bytesDone: number;
  bytesTotal: number;
  currentName: string | null;
  status: TransferStatus;
  error?: string;
}

export interface TransferEnv {
  /** Resolve a transport; null is the local relay (the Pear machine). */
  connection(hostId: string | null): Promise<SshTransport>;
  /** Fresh unique staging directory on the Pear machine. */
  makeStagingDir(): Promise<string>;
  removeStaging(dir: string): Promise<void>;
}

export interface TransferEvents {
  onUpdate(job: TransferJobSnapshot): void;
}

export function joinPath(dir: string, name: string): string {
  if (!name) return dir;
  return (dir === '/' ? '' : dir.replace(/\/$/, '')) + '/' + name;
}

/** Pure-layer AbortSignal: transports bridge it to the platform's own. */
class Aborter implements AbortSignalLike {
  aborted = false;
  private listeners = new Set<() => void>();

  addEventListener(_type: 'abort', listener: () => void): void {
    this.listeners.add(listener);
  }
  removeEventListener(_type: 'abort', listener: () => void): void {
    this.listeners.delete(listener);
  }
  abort(): void {
    if (this.aborted) return;
    this.aborted = true;
    for (const listener of [...this.listeners]) listener();
  }
}

/** One file to carry; paths relative to the endpoints' dirs. destRel differs
 *  from srcRel only when a top-level name was renamed to dodge a conflict. */
interface ManifestFile {
  srcRel: string;
  destRel: string;
  size: number;
}

interface Manifest {
  /** Dest-relative directories to create, parents before children. */
  dirs: string[];
  files: ManifestFile[];
  /** Top-level source names to delete after a successful move. */
  moveRoots: string[];
}

interface Job {
  snapshot: TransferJobSnapshot;
  req: TransferRequest;
  aborter: Aborter;
  /** Path + host of the file currently being written, for partial cleanup. */
  partial: { hostId: string | null; path: string } | null;
}

const PROGRESS_INTERVAL_MS = 100;

export class TransferEngine {
  private jobs = new Map<string, Job>();
  private queue: string[] = [];
  private running = 0;
  private maxParallel = 2;
  private lastEmit = new Map<string, number>();

  constructor(
    private readonly env: TransferEnv,
    private readonly events: TransferEvents,
    private readonly now: () => number = () => Date.now(),
  ) {}

  start(req: TransferRequest): string {
    const id = uuid();
    const job: Job = {
      req,
      aborter: new Aborter(),
      partial: null,
      snapshot: {
        id,
        label: req.names.length === 1 ? req.names[0] : `${req.names.length} items`,
        src: req.src,
        dest: req.dest,
        op: req.op,
        stages: req.src.hostId !== null && req.dest.hostId !== null ? 2 : 1,
        stage: 0,
        bytesDone: 0,
        bytesTotal: 0,
        currentName: null,
        status: 'queued',
      },
    };
    this.jobs.set(id, job);
    this.queue.push(id);
    this.emit(job, true);
    this.pump();
    return id;
  }

  cancel(id: string): void {
    const job = this.jobs.get(id);
    if (!job) return;
    if (job.snapshot.status === 'queued') {
      this.queue = this.queue.filter((q) => q !== id);
      job.snapshot.status = 'canceled';
      this.emit(job, true);
      return;
    }
    if (job.snapshot.status === 'running') job.aborter.abort();
  }

  list(): TransferJobSnapshot[] {
    return [...this.jobs.values()].map((j) => ({ ...j.snapshot }));
  }

  clearFinished(): void {
    for (const [id, job] of this.jobs) {
      if (job.snapshot.status !== 'queued' && job.snapshot.status !== 'running') {
        this.jobs.delete(id);
        this.lastEmit.delete(id);
      }
    }
  }

  setMaxParallel(n: number): void {
    this.maxParallel = Math.max(1, n);
    this.pump();
  }

  private pump(): void {
    while (this.running < this.maxParallel && this.queue.length > 0) {
      const id = this.queue.shift()!;
      const job = this.jobs.get(id);
      if (!job || job.snapshot.status !== 'queued') continue;
      this.running++;
      void this.run(job).finally(() => {
        this.running--;
        this.pump();
      });
    }
  }

  private async run(job: Job): Promise<void> {
    const snap = job.snapshot;
    snap.status = 'running';
    this.emit(job, true);
    let staging: string | null = null;
    try {
      const src = await this.env.connection(job.req.src.hostId);
      const dest = await this.env.connection(job.req.dest.hostId);
      const manifest = await this.buildManifest(job, src, dest);
      snap.bytesTotal = manifest.files.reduce((a, f) => a + f.size, 0);
      this.emit(job, true);

      if (snap.stages === 2) {
        staging = await this.env.makeStagingDir();
        const relay = await this.env.connection(null);
        await this.copyStage(job, manifest, {
          from: src, fromDir: job.req.src.dir, fromKey: 'srcRel',
          to: relay, toDir: staging, toHostId: null, mode: 'download',
        });
        snap.stage = 1;
        snap.bytesDone = 0;
        this.emit(job, true);
        await this.copyStage(job, manifest, {
          from: relay, fromDir: staging, fromKey: 'destRel',
          to: dest, toDir: job.req.dest.dir, toHostId: job.req.dest.hostId, mode: 'upload',
        });
      } else {
        await this.copyStage(job, manifest, {
          from: src, fromDir: job.req.src.dir, fromKey: 'srcRel',
          to: dest, toDir: job.req.dest.dir, toHostId: job.req.dest.hostId,
          mode: job.req.dest.hostId === null ? 'download' : 'upload',
        });
      }

      if (job.req.op === 'move') {
        for (const name of manifest.moveRoots) {
          await src.remove(joinPath(job.req.src.dir, name), true);
        }
      }
      snap.bytesDone = snap.bytesTotal;
      snap.currentName = null;
      snap.status = 'done';
    } catch (err) {
      if (job.aborter.aborted) {
        snap.status = 'canceled';
        await this.removePartial(job);
      } else {
        snap.status = 'error';
        snap.error = err instanceof Error ? err.message : String(err);
      }
    } finally {
      if (staging) await this.env.removeStaging(staging).catch(() => {});
      this.emit(job, true);
    }
  }

  /**
   * Carry every manifest file across one leg. One side of a leg is always the
   * Pear machine, so each file is a single `download` (remote source) or
   * `uploadFile` (remote dest) driven by the remote side's transport.
   */
  private async copyStage(
    job: Job,
    manifest: Manifest,
    leg: {
      from: SshTransport;
      fromDir: string;
      fromKey: 'srcRel' | 'destRel';
      to: SshTransport;
      toDir: string;
      toHostId: string | null;
      mode: 'download' | 'upload';
    },
  ): Promise<void> {
    const snap = job.snapshot;
    for (const dir of manifest.dirs) {
      this.checkCanceled(job);
      await leg.to.mkdir(joinPath(leg.toDir, dir)).catch(() => {});
    }
    let doneBytes = 0;
    for (const file of manifest.files) {
      this.checkCanceled(job);
      const fromPath = joinPath(leg.fromDir, file[leg.fromKey]);
      const toPath = joinPath(leg.toDir, file.destRel);
      snap.currentName = file.destRel;
      job.partial = { hostId: leg.toHostId, path: toPath };
      const opts = {
        signal: job.aborter,
        onProgress: (p: { bytes: number }) => {
          snap.bytesDone = doneBytes + Math.min(p.bytes, file.size);
          this.emit(job);
        },
      };
      if (leg.mode === 'download') await leg.from.download(fromPath, toPath, opts);
      else await leg.to.uploadFile(fromPath, toPath, opts);
      doneBytes += file.size;
      snap.bytesDone = doneBytes;
      job.partial = null;
      this.emit(job);
    }
  }

  private checkCanceled(job: Job): void {
    if (job.aborter.aborted) throw new Error('canceled');
  }

  private async removePartial(job: Job): Promise<void> {
    if (!job.partial) return;
    try {
      const t = await this.env.connection(job.partial.hostId);
      await t.remove(job.partial.path);
    } catch {
      // best-effort cleanup of a half-written file
    }
  }

  /** Walk the sources, resolve dest-name conflicts, and total the bytes. */
  private async buildManifest(job: Job, src: SshTransport, dest: SshTransport): Promise<Manifest> {
    const { req } = job;
    const manifest: Manifest = { dirs: [], files: [], moveRoots: [] };
    for (const name of req.names) {
      this.checkCanceled(job);
      const srcPath = joinPath(req.src.dir, name);
      const st = await src.stat(srcPath);
      if (!st) throw new Error(`${srcPath}: no such file or directory`);

      let destName = name;
      const existing = await dest.stat(joinPath(req.dest.dir, name));
      if (existing) {
        if (req.conflict === 'skip') continue;
        if (req.conflict === 'overwrite') {
          await dest.remove(joinPath(req.dest.dir, name), true);
        } else {
          destName = await this.uniqueName(dest, req.dest.dir, name);
        }
      }
      manifest.moveRoots.push(name);

      if (st.kind === 'dir') {
        manifest.dirs.push(destName);
        await this.walkDir(job, src, srcPath, name, destName, manifest);
      } else {
        manifest.files.push({ srcRel: name, destRel: destName, size: st.size });
      }
    }
    return manifest;
  }

  private async walkDir(
    job: Job,
    src: SshTransport,
    absDir: string,
    srcRoot: string,
    destRoot: string,
    manifest: Manifest,
  ): Promise<void> {
    this.checkCanceled(job);
    const listing = await src.listDir(absDir);
    for (const entry of listing.entries) {
      const srcRel = srcRoot + '/' + entry.name;
      const destRel = destRoot + '/' + entry.name;
      if (entry.kind === 'dir') {
        manifest.dirs.push(destRel);
        await this.walkDir(job, src, joinPath(absDir, entry.name), srcRel, destRel, manifest);
      } else {
        manifest.files.push({ srcRel, destRel, size: entry.size });
      }
    }
  }

  private async uniqueName(dest: SshTransport, dir: string, name: string): Promise<string> {
    const dot = name.startsWith('.') ? -1 : name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    for (let i = 1; i < 100; i++) {
      const candidate = `${stem} (${i})${ext}`;
      if (!(await dest.stat(joinPath(dir, candidate)))) return candidate;
    }
    throw new Error(`No free name for ${name} in ${dir}`);
  }

  private emit(job: Job, force = false): void {
    const id = job.snapshot.id;
    const now = this.now();
    if (!force && now - (this.lastEmit.get(id) ?? 0) < PROGRESS_INTERVAL_MS) return;
    this.lastEmit.set(id, now);
    this.events.onUpdate({ ...job.snapshot });
  }
}
