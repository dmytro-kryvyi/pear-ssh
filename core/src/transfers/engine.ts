import type { AbortSignalLike, SshTransport, TransferOpts } from '../ssh/transport';
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
  /** Compare SHA-256 of source and destination after each file is copied,
   *  failing the job (and removing the partial) on any mismatch. */
  verify: boolean;
}

/** What a running job is doing right now, finer than its stage. */
export type TransferPhase =
  | 'listing'
  | 'copying'
  | 'verifying'
  | 'pushing'
  | 'pulling'
  | 'finalizing';

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
  // Everything below is optional on the wire (older clients ignore it) but
  // always filled in by the engine.
  phase?: TransferPhase;
  /** 1-based index of the file in flight within the current stage. */
  fileIndex?: number;
  fileCount?: number;
  /** Clock values from the engine's `now()` (ms). */
  startedAt?: number;
  stageStartedAt?: number;
  finishedAt?: number;
  /** Smoothed throughput of the current stage; null until measurable. */
  bytesPerSec?: number | null;
  /** Seconds left in the current stage at the current rate; null if unknown. */
  etaSec?: number | null;
  /** cancel() was called on a running job; `canceled` follows once it stops. */
  cancelRequested?: boolean;
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

function freshRate(now: number): RateTracker {
  return { samples: [{ at: now, bytes: 0 }], etaSec: null, etaAt: now };
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
  /** Files currently being written (path → host), for partial cleanup. */
  partials: Map<string, string | null>;
  /** Throughput tracker for the current stage (see updateRate). */
  rate: RateTracker;
}

interface RateTracker {
  /** (clock, bytesDone) samples covering the last RATE_WINDOW_MS. */
  samples: { at: number; bytes: number }[];
  /** Last smoothed ETA, so the estimate counts down instead of jumping. */
  etaSec: number | null;
  /** Clock of the last ETA update. */
  etaAt: number;
}

const PROGRESS_INTERVAL_MS = 100;
/**
 * Files up to this size are carried several at a time: each one costs a few
 * network round trips (open, write, close) however small it is, so a tree of
 * tiny assets over a slow link would otherwise crawl at one file per RTT.
 * Larger files run alone — they already keep a window of requests in flight,
 * and running several would multiply the memory held in that window.
 */
const SMALL_FILE_BYTES = 4 * 1024 * 1024;
const FILE_CONCURRENCY = 8;
const DIR_CONCURRENCY = 8;
/** Throughput is the mean over this much history — one slow or bursty
 *  second must not swing the estimate. */
const RATE_WINDOW_MS = 20_000;
/** The ETA eases toward the current estimate with this time constant. */
const ETA_TAU_MS = 8_000;

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
      partials: new Map(),
      rate: freshRate(0),
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
    if (job.snapshot.status === 'running') {
      // Say so at once: the stop itself lands when the in-flight requests
      // drain (or a verify hash returns), and the UI should not look stuck.
      job.snapshot.cancelRequested = true;
      this.emit(job, true);
      job.aborter.abort();
    }
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
    snap.startedAt = snap.stageStartedAt = this.now();
    snap.phase = 'listing';
    this.emit(job, true);
    let staging: string | null = null;
    try {
      const src = await this.env.connection(job.req.src.hostId);
      const dest = await this.env.connection(job.req.dest.hostId);
      const manifest = await this.buildManifest(job, src, dest);
      snap.bytesTotal = manifest.files.reduce((a, f) => a + f.size, 0);
      snap.fileCount = manifest.files.length;
      this.startStage(job, 0);

      if (snap.stages === 2) {
        staging = await this.env.makeStagingDir();
        const relay = await this.env.connection(null);
        await this.copyStage(job, manifest, {
          from: src, fromDir: job.req.src.dir, fromKey: 'srcRel',
          to: relay, toDir: staging, toHostId: null, mode: 'download',
        });
        this.startStage(job, 1);
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

      if (job.req.op === 'move' && manifest.moveRoots.length) {
        snap.phase = 'finalizing';
        this.emit(job, true);
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
        // Siblings that were in flight when one file failed are half-written.
        await this.removePartial(job);
      }
    } finally {
      if (staging) await this.env.removeStaging(staging).catch(() => {});
      snap.finishedAt = this.now();
      snap.bytesPerSec = null;
      snap.etaSec = null;
      this.emit(job, true);
    }
  }

  /** A copy stage begins: fresh byte counter, clock and throughput tracker. */
  private startStage(job: Job, stage: 0 | 1): void {
    const snap = job.snapshot;
    const now = this.now();
    snap.stage = stage;
    snap.bytesDone = 0;
    snap.stageStartedAt = now;
    snap.phase = 'copying';
    snap.bytesPerSec = null;
    snap.etaSec = null;
    job.rate = freshRate(now);
    this.emit(job, true);
  }

  /**
   * Carry every manifest file across one leg. One side of a leg is always the
   * Pear machine, so each file is a single `download` (remote source) or
   * `uploadFile` (remote dest) driven by the remote side's transport. Small
   * files go FILE_CONCURRENCY at a time; a big one waits for the pool to
   * drain and then runs by itself.
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
    await this.makeDirs(job, leg.to, leg.toDir, manifest.dirs);

    // The first failure stops everything else in flight; a user cancel does
    // the same through the job's own aborter.
    const stop = new Aborter();
    const onCancel = (): void => stop.abort();
    job.aborter.addEventListener('abort', onCancel);
    let failure: unknown = null;
    const fail = (err: unknown): void => {
      failure ??= err;
      stop.abort();
    };

    let completedBytes = 0;
    let completedCount = 0;
    const inflight = new Map<ManifestFile, number>();
    const refresh = (): void => {
      let sum = completedBytes;
      for (const bytes of inflight.values()) sum += bytes;
      snap.bytesDone = sum;
    };

    const carry = async (file: ManifestFile): Promise<void> => {
      const fromPath = joinPath(leg.fromDir, file[leg.fromKey]);
      const toPath = joinPath(leg.toDir, file.destRel);
      inflight.set(file, 0);
      job.partials.set(toPath, leg.toHostId);
      snap.currentName = file.destRel;
      snap.fileIndex = Math.min(completedCount + 1, manifest.files.length);
      snap.phase = 'copying';
      try {
        const opts: TransferOpts = {
          signal: stop,
          onProgress: (p) => {
            inflight.set(file, Math.min(p.bytes, file.size));
            refresh();
            this.emit(job);
          },
          onPhase: (phase) => {
            snap.phase = phase;
            this.emit(job, true);
          },
        };
        if (leg.mode === 'download') await leg.from.download(fromPath, toPath, opts);
        else await leg.to.uploadFile(fromPath, toPath, opts);
        if (job.req.verify) {
          // Hashing re-reads the whole file on both ends; it cannot be
          // interrupted, but a cancel that lands during it still wins.
          this.checkCanceled(job);
          snap.phase = 'verifying';
          this.emit(job, true);
          const [srcHash, destHash] = await Promise.all([
            leg.from.hash(fromPath),
            leg.to.hash(toPath),
          ]);
          this.checkCanceled(job);
          if (srcHash !== destHash) {
            // Drop the corrupt file before failing the job.
            await this.removeAt(leg.toHostId, toPath);
            job.partials.delete(toPath);
            throw new Error(`checksum mismatch: ${file.destRel}`);
          }
          snap.phase = 'copying';
        }
        job.partials.delete(toPath);
        inflight.delete(file);
        completedBytes += file.size;
        completedCount++;
        snap.fileIndex = Math.min(completedCount + 1, manifest.files.length);
        refresh();
        // Forced: a throttled emit here could swallow this file's 100%.
        this.emit(job, true);
      } catch (err) {
        inflight.delete(file);
        throw err;
      }
    };

    const active = new Set<Promise<void>>();
    const launch = (file: ManifestFile): Promise<void> => {
      const p: Promise<void> = carry(file)
        .catch(fail)
        .finally(() => active.delete(p));
      active.add(p);
      return p;
    };
    try {
      for (const file of manifest.files) {
        if (failure) break;
        this.checkCanceled(job);
        if (file.size > SMALL_FILE_BYTES) {
          await Promise.all(active);
          if (failure) break;
          await launch(file);
        } else {
          while (active.size >= FILE_CONCURRENCY) await Promise.race(active);
          launch(file);
        }
      }
    } catch (err) {
      fail(err);
    } finally {
      await Promise.all(active);
      job.aborter.removeEventListener('abort', onCancel);
    }
    if (failure) throw failure;
  }

  /** Create the manifest's directories, parents before children, several
   *  per round trip. Existing directories are fine. */
  private async makeDirs(job: Job, to: SshTransport, toDir: string, dirs: string[]): Promise<void> {
    const byDepth = new Map<number, string[]>();
    for (const dir of dirs) {
      const depth = dir.split('/').length;
      const list = byDepth.get(depth);
      if (list) list.push(dir);
      else byDepth.set(depth, [dir]);
    }
    for (const depth of [...byDepth.keys()].sort((a, b) => a - b)) {
      const batch = byDepth.get(depth)!;
      for (let i = 0; i < batch.length; i += DIR_CONCURRENCY) {
        this.checkCanceled(job);
        await Promise.all(
          batch.slice(i, i + DIR_CONCURRENCY).map((dir) => to.mkdir(joinPath(toDir, dir)).catch(() => {})),
        );
      }
    }
  }

  private checkCanceled(job: Job): void {
    if (job.aborter.aborted) throw new Error('canceled');
  }

  private async removePartial(job: Job): Promise<void> {
    const partials = [...job.partials];
    job.partials.clear();
    await Promise.all(partials.map(([path, hostId]) => this.removeAt(hostId, path)));
  }

  /** Best-effort removal of a half-written file. */
  private async removeAt(hostId: string | null, path: string): Promise<void> {
    try {
      const t = await this.env.connection(hostId);
      await t.remove(path);
    } catch {
      // the file may never have been created
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
    if (job.snapshot.status === 'running') this.updateRate(job, now);
    this.events.onUpdate({ ...job.snapshot });
  }

  /**
   * Throughput for the current stage: the mean over the last RATE_WINDOW_MS
   * (a 100 ms burst or stall barely moves it), and an ETA that eases toward
   * the current estimate while counting down between samples — so it reads
   * like a clock, not a slot machine.
   */
  private updateRate(job: Job, now: number): void {
    const snap = job.snapshot;
    const r = job.rate;
    const last = r.samples[r.samples.length - 1];
    if (last && now - last.at < PROGRESS_INTERVAL_MS) return;
    r.samples.push({ at: now, bytes: snap.bytesDone });
    while (r.samples.length > 2 && now - r.samples[1].at >= RATE_WINDOW_MS) r.samples.shift();
    const first = r.samples[0];
    const spanSec = (now - first.at) / 1000;
    if (spanSec <= 0) return;
    const rate = Math.max(0, (snap.bytesDone - first.bytes) / spanSec);
    snap.bytesPerSec = Math.round(rate);
    const remaining = snap.bytesTotal - snap.bytesDone;
    if (remaining <= 0) {
      r.etaSec = 0;
    } else if (rate > 0) {
      const raw = remaining / rate;
      if (r.etaSec === null) {
        r.etaSec = raw;
      } else {
        // Count down the time that passed, then ease toward the fresh estimate.
        const dtMs = now - r.etaAt;
        const counted = Math.max(0, r.etaSec - dtMs / 1000);
        const alpha = 1 - Math.exp(-dtMs / ETA_TAU_MS);
        r.etaSec = counted + (raw - counted) * alpha;
      }
    }
    r.etaAt = now;
    snap.etaSec = r.etaSec === null ? null : Math.ceil(r.etaSec);
  }
}
