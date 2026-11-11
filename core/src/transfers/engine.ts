import type { AbortSignalLike, PipeChannel, SshTransport, TransferOpts } from '../ssh/transport';
import { shq } from '../shq';
import { uuid } from '../uuid';
import { isMacMeta } from './mac-meta';
import {
  PipeWriter,
  batchHashCommand,
  collectPipe,
  encodeNulList,
  parseHashLines,
} from './stream-util';
import { TAR_MAX_OCTAL_SIZE, type TarEntryType } from './tar';

// The pure tsconfig carries no platform lib; timers exist wherever this runs.
declare function setTimeout(handler: () => void, timeout?: number): unknown;
declare function clearTimeout(handle: unknown): void;

// Moves files between hosts without ever holding content in memory: same-host
// operations never come here (the UI calls rename/copy directly); everything
// else is streamed through the transports, cross-host via a staging directory
// on the Pear machine (the local relay) — download stage, then upload stage.
//
// A leg with many files runs as one tar stream when the remote side can
// stream (`execPipe`) and has `tar`: the Pear machine packs the tree and the
// host unpacks it, or the host packs and the Pear machine unpacks, with no
// per-file round trips. Tar legs carry symlinks as links and restore mtimes;
// the per-file SFTP path (small transfers, hosts without tar) follows links
// and leaves mtimes at the time of copy.

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
  /** Leave `__MACOSX`, `.DS_Store` and `._*` inside walked folders behind
   *  (default true). Explicitly selected names are always carried. */
  skipMacMeta?: boolean;
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
  /** Files finished within the current stage. */
  filesDone?: number;
  /** Smoothed files per second of the current stage; null until measurable. */
  filesPerSec?: number | null;
  /** cancel() was called on a running job; `canceled` follows once it stops. */
  cancelRequested?: boolean;
}

export interface TransferEnv {
  /** Resolve a transport; null is the local relay (the Pear machine). */
  connection(hostId: string | null): Promise<SshTransport>;
  /** Fresh unique staging directory on the Pear machine. */
  makeStagingDir(): Promise<string>;
  removeStaging(dir: string): Promise<void>;
  /** Tar packing/unpacking on the Pear machine; absent = per-file copies only. */
  tar?: TarIo;
}

export interface TarPackInput {
  /** Archive paths of directories to create first (parents before children). */
  dirs: string[];
  /** `src` is relative to the pack dir; `entry` is the archive path. */
  files: { src: string; entry: string; size: number }[];
}

export interface TarPackOpts {
  /** Compute a SHA-256 per regular file while reading and report it on
   *  'done'; symlinks report none. */
  hash?: boolean;
  onEntry(index: number, phase: 'start' | 'done', sha256?: string): void;
  /** Payload bytes of file `index` written so far. */
  onProgress(index: number, bytes: number): void;
}

export interface TarUnpackOpts {
  hash?: boolean;
  /** Where an archive path lands, relative to the unpack dir; null skips it. */
  map(path: string, type: TarEntryType): string | null;
  onEntry(localRel: string, phase: 'start' | 'done', sha256?: string): void;
  onProgress(localRel: string, bytes: number): void;
}

/**
 * The platform's side of a tar leg. `pack` resolves once the end-of-archive
 * marker has been written and stdin closed; it rejects if the pipe closes
 * first. `unpack` resolves once the pipe has closed and every file is on
 * disk; it rejects on a truncated stream or a write failure.
 */
export interface TarIo {
  pack(dir: string, input: TarPackInput, pipe: PipeChannel, opts: TarPackOpts): Promise<void>;
  unpack(
    pipe: PipeChannel,
    dir: string,
    opts: TarUnpackOpts,
  ): Promise<{ atEnd: boolean; code: number | null }>;
}

export interface TransferEvents {
  onUpdate(job: TransferJobSnapshot): void;
}

function freshRate(now: number): RateTracker {
  return { samples: [{ at: now, bytes: 0, files: 0, big: false }], etaSec: null, etaAt: now, bestBps: 0 };
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

interface Leg {
  from: SshTransport;
  fromDir: string;
  fromKey: 'srcRel' | 'destRel';
  to: SshTransport;
  toDir: string;
  toHostId: string | null;
  mode: 'download' | 'upload';
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
  /** Top-level source name → destination name (differs after a rename). */
  renames: Map<string, string>;
}

/** What is left in the current stage, for the two-term ETA. */
interface StageProgress {
  smallLeft: number;
  smallBytesLeft: number;
  bigBytesLeft: number;
  /** Bytes already carried of the big file in flight (per-file path). */
  bigInFlight: number | null;
  /** The stage runs as one tar stream: bandwidth-bound, bytes-only ETA. */
  tar: boolean;
}

interface Job {
  snapshot: TransferJobSnapshot;
  req: TransferRequest;
  aborter: Aborter;
  /** Files currently being written (path → host), for partial cleanup. */
  partials: Map<string, string | null>;
  /** Throughput tracker for the current stage (see updateRate). */
  rate: RateTracker;
  prog: StageProgress;
}

interface RateTracker {
  /** (clock, bytesDone, filesDone, big file in flight) samples covering the
   *  last RATE_WINDOW_MS. */
  samples: { at: number; bytes: number; files: number; big: boolean }[];
  /** Last smoothed ETA, so the estimate counts down instead of jumping. */
  etaSec: number | null;
  /** Clock of the last ETA update. */
  etaAt: number;
  /** Best byte rate seen while a big file was streaming: the link's speed. */
  bestBps: number;
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
/** A leg with at least this many files goes as one tar stream when it can. */
const TAR_MIN_FILES = 32;
/** Entries whose payload ended within this many bytes of what was sent may
 *  not have reached the host when the stream was cut (window + buffers). */
const PIPE_SLACK = 8 * 1024 * 1024;
/** A `tar -c` command line longer than this (many top-level names) is not
 *  risked against ARG_MAX. */
const TAR_CMD_MAX = 64 * 1024;
const TAR_PROBE_MS = 10_000;

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
      prog: { smallLeft: 0, smallBytesLeft: 0, bigBytesLeft: 0, bigInFlight: null, tar: false },
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
      this.startStage(job, 0, manifest);

      if (snap.stages === 2) {
        staging = await this.env.makeStagingDir();
        const relay = await this.env.connection(null);
        await this.copyStage(job, manifest, {
          from: src, fromDir: job.req.src.dir, fromKey: 'srcRel',
          to: relay, toDir: staging, toHostId: null, mode: 'download',
        });
        this.startStage(job, 1, manifest);
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
      snap.filesPerSec = null;
      snap.etaSec = null;
      this.emit(job, true);
    }
  }

  /** A copy stage begins: fresh byte counter, clock and throughput tracker. */
  private startStage(job: Job, stage: 0 | 1, manifest: Manifest): void {
    const snap = job.snapshot;
    const now = this.now();
    snap.stage = stage;
    snap.bytesDone = 0;
    snap.filesDone = 0;
    snap.stageStartedAt = now;
    snap.phase = 'copying';
    snap.bytesPerSec = null;
    snap.filesPerSec = null;
    snap.etaSec = null;
    job.rate = freshRate(now);
    const prog: StageProgress = {
      smallLeft: 0,
      smallBytesLeft: 0,
      bigBytesLeft: 0,
      bigInFlight: null,
      tar: false,
    };
    for (const f of manifest.files) {
      if (f.size > SMALL_FILE_BYTES) prog.bigBytesLeft += f.size;
      else {
        prog.smallLeft++;
        prog.smallBytesLeft += f.size;
      }
    }
    job.prog = prog;
    this.emit(job, true);
  }

  /** Bookkeeping when a file of the current stage is complete. */
  private fileDone(job: Job, file: ManifestFile): void {
    const prog = job.prog;
    if (file.size > SMALL_FILE_BYTES) {
      prog.bigBytesLeft -= file.size;
      prog.bigInFlight = null;
    } else {
      prog.smallLeft--;
      prog.smallBytesLeft -= file.size;
    }
    job.snapshot.filesDone = (job.snapshot.filesDone ?? 0) + 1;
  }

  /**
   * Carry every manifest file across one leg. One side of a leg is always the
   * Pear machine, so each file is a single `download` (remote source) or
   * `uploadFile` (remote dest) driven by the remote side's transport. Small
   * files go FILE_CONCURRENCY at a time; a big one waits for the pool to
   * drain and then runs by itself.
   */
  private async copyStage(job: Job, manifest: Manifest, leg: Leg): Promise<void> {
    const snap = job.snapshot;
    if (await this.useTar(manifest, leg)) {
      await this.tarStage(job, manifest, leg);
      return;
    }
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
      const big = file.size > SMALL_FILE_BYTES;
      if (big) job.prog.bigInFlight = 0;
      try {
        const opts: TransferOpts = {
          signal: stop,
          onProgress: (p) => {
            const bytes = Math.min(p.bytes, file.size);
            inflight.set(file, bytes);
            if (big) job.prog.bigInFlight = bytes;
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
        this.fileDone(job, file);
        snap.fileIndex = Math.min(completedCount + 1, manifest.files.length);
        refresh();
        // Forced: a throttled emit here could swallow this file's 100%.
        this.emit(job, true);
      } catch (err) {
        inflight.delete(file);
        if (big) job.prog.bigInFlight = null;
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

  // ---- tar legs ---------------------------------------------------------------

  /** Per transport: can it stream, does the route carry stdin, is tar there. */
  private tarProbe = new WeakMap<SshTransport, Promise<boolean>>();

  private canTar(t: SshTransport): Promise<boolean> {
    const cached = this.tarProbe.get(t);
    if (cached) return cached;
    const probe = (async (): Promise<boolean> => {
      if (!t.execPipe) return false;
      try {
        const pipe = await t.execPipe('command -v tar >/dev/null 2>&1');
        pipe.end();
        const code = await new Promise<number | null>((resolve) => {
          const timer = setTimeout(() => {
            pipe.close();
            resolve(null);
          }, TAR_PROBE_MS);
          pipe.onClose((c) => {
            clearTimeout(timer);
            resolve(c);
          });
        });
        return code === 0;
      } catch {
        return false;
      }
    })();
    this.tarProbe.set(t, probe);
    return probe;
  }

  private createCommand(dir: string, names: string[]): string {
    return `tar -c -f - -C ${shq(dir)} ${names.map((n) => shq('./' + n)).join(' ')}`;
  }

  private async useTar(manifest: Manifest, leg: Leg): Promise<boolean> {
    if (!this.env.tar || manifest.files.length < TAR_MIN_FILES) return false;
    const unsafe = (s: string): boolean => s.includes('\n');
    if (manifest.dirs.some(unsafe)) return false;
    for (const f of manifest.files) {
      if (f.size > TAR_MAX_OCTAL_SIZE || unsafe(f.srcRel) || unsafe(f.destRel)) return false;
    }
    if (leg.mode === 'download') {
      if (this.createCommand(leg.fromDir, manifest.moveRoots).length > TAR_CMD_MAX) return false;
    }
    return this.canTar(leg.mode === 'upload' ? leg.to : leg.from);
  }

  /**
   * Carry the whole leg as one tar stream. Upload: the Pear machine packs,
   * `tar -x` on the host unpacks. Download: `tar -c` on the host packs the
   * selected top-level entries, the Pear machine unpacks what the manifest
   * wants (renamed roots, skipped metadata) and drops the rest.
   */
  private async tarStage(job: Job, manifest: Manifest, leg: Leg): Promise<void> {
    const snap = job.snapshot;
    job.prog.tar = true;
    const remote = leg.mode === 'upload' ? leg.to : leg.from;
    const command =
      leg.mode === 'upload'
        ? `tar -x -o -f - -C ${shq(leg.toDir)}`
        : this.createCommand(leg.fromDir, manifest.moveRoots);
    const pipe = await remote.execPipe!(command);
    let stderr = '';
    pipe.onStderr((text) => (stderr = (stderr + text).slice(-2048)));
    const closed = new Promise<number | null>((resolve) => pipe.onClose(resolve));
    const onCancel = (): void => pipe.close();
    job.aborter.addEventListener('abort', onCancel);
    const hashes = new Map<string, string>();
    const toolName = leg.mode === 'upload' ? 'tar -x' : 'tar -c';
    try {
      snap.phase = 'copying';
      if (leg.mode === 'upload') {
        try {
          await this.tarUpload(job, manifest, leg, pipe, hashes);
        } catch (err) {
          // The far side quitting mid-stream is reported by its exit, not by
          // the write that found the pipe closed.
          this.checkCanceled(job);
          const code = await closed;
          if (code !== 0) throw new Error(this.tarError(toolName, code, stderr));
          throw err;
        }
        const code = await closed;
        this.checkCanceled(job);
        if (code !== 0) throw new Error(this.tarError(toolName, code, stderr));
      } else {
        const complete = await this.tarDownload(job, manifest, leg, pipe, hashes).catch((err) => {
          this.checkCanceled(job);
          throw new Error(`${this.tarError(toolName, null, stderr)}: ${messageOf(err)}`);
        });
        this.checkCanceled(job);
        // The stream is the arbiter: a non-zero exit with every file complete
        // is a warning ("file changed as we read it"); a missing file with
        // exit 0 is not fine either.
        if (!complete.allFiles) {
          throw new Error(
            complete.code === 0
              ? `${complete.missing} file(s) were not in the stream from the host`
              : this.tarError(toolName, complete.code, stderr),
          );
        }
      }
      for (const [path] of job.partials) if (job.partials.get(path) === leg.toHostId) job.partials.delete(path);
      if (job.req.verify) await this.verifyTar(job, manifest, leg, hashes);
    } finally {
      job.aborter.removeEventListener('abort', onCancel);
    }
  }

  private tarError(tool: string, code: number | null, stderr: string): string {
    const last = stderr
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .pop();
    const exit = code === null ? 'ended without a status' : `exit ${code}`;
    return last ? `${tool} ${exit}: ${last}` : `${tool} ${exit}`;
  }

  private async tarUpload(
    job: Job,
    manifest: Manifest,
    leg: Leg,
    pipe: PipeChannel,
    hashes: Map<string, string>,
  ): Promise<void> {
    const snap = job.snapshot;
    const files = manifest.files.map((f) => ({ src: f[leg.fromKey], entry: f.destRel, size: f.size }));
    let completedBytes = 0;
    let completedCount = 0;
    // Entries that ended within PIPE_SLACK of what has been sent may still be
    // in the pipe's buffers; they stay partials until the stream moves on.
    const recent: { path: string; end: number }[] = [];
    const prune = (sent: number): void => {
      while (recent.length && recent[0].end <= sent - PIPE_SLACK) {
        job.partials.delete(recent.shift()!.path);
      }
    };
    await this.env.tar!.pack(leg.fromDir, { dirs: manifest.dirs, files }, pipe, {
      hash: job.req.verify,
      onEntry: (i, phase, sha) => {
        const file = manifest.files[i];
        const toPath = joinPath(leg.toDir, file.destRel);
        if (phase === 'start') {
          job.partials.set(toPath, leg.toHostId);
          snap.currentName = file.destRel;
          snap.fileIndex = Math.min(completedCount + 1, manifest.files.length);
          return;
        }
        if (sha) hashes.set(file.destRel, sha);
        completedBytes += file.size;
        completedCount++;
        this.fileDone(job, file);
        recent.push({ path: toPath, end: completedBytes });
        prune(completedBytes);
        snap.bytesDone = completedBytes;
        this.emit(job, true);
      },
      onProgress: (i, bytes) => {
        snap.bytesDone = completedBytes + Math.min(bytes, manifest.files[i].size);
        prune(snap.bytesDone);
        this.emit(job);
      },
    });
  }

  private async tarDownload(
    job: Job,
    manifest: Manifest,
    leg: Leg,
    pipe: PipeChannel,
    hashes: Map<string, string>,
  ): Promise<{ allFiles: boolean; missing: number; code: number | null }> {
    const snap = job.snapshot;
    const bySrc = new Map(manifest.files.map((f) => [f.srcRel, f]));
    const byDest = new Map(manifest.files.map((f) => [f.destRel, f]));
    const dirs = new Set(manifest.dirs);
    const map = (path: string, type: TarEntryType): string | null => {
      const slash = path.indexOf('/');
      const top = slash < 0 ? path : path.slice(0, slash);
      const destTop = manifest.renames.get(top);
      if (destTop === undefined) return null;
      if (type === 'dir') {
        const destRel = slash < 0 ? destTop : destTop + path.slice(slash);
        return dirs.has(destRel) ? destRel : null;
      }
      const file = bySrc.get(path);
      return file && (type === 'file' || type === 'symlink' || type === 'hardlink') ? file.destRel : null;
    };
    let completedBytes = 0;
    let completedCount = 0;
    let inflight = 0;
    const result = await this.env.tar!.unpack(pipe, leg.toDir, {
      hash: job.req.verify,
      map,
      onEntry: (localRel, phase, sha) => {
        const file = byDest.get(localRel);
        if (!file) return;
        const toPath = joinPath(leg.toDir, localRel);
        if (phase === 'start') {
          job.partials.set(toPath, leg.toHostId);
          snap.currentName = localRel;
          snap.fileIndex = Math.min(completedCount + 1, manifest.files.length);
          return;
        }
        if (sha) hashes.set(localRel, sha);
        job.partials.delete(toPath);
        completedBytes += file.size;
        completedCount++;
        inflight = 0;
        this.fileDone(job, file);
        snap.bytesDone = completedBytes;
        this.emit(job, true);
      },
      onProgress: (localRel, bytes) => {
        const file = byDest.get(localRel);
        inflight = file ? Math.min(bytes, file.size) : 0;
        snap.bytesDone = completedBytes + inflight;
        this.emit(job);
      },
    });
    const missing = manifest.files.length - completedCount;
    return { allFiles: missing === 0 && result.atEnd, missing, code: result.code };
  }

  /**
   * Verify a tar leg: the Pear machine hashed every file as it streamed, the
   * host hashes its copies in one batch, and the two lists must agree.
   */
  private async verifyTar(
    job: Job,
    manifest: Manifest,
    leg: Leg,
    local: Map<string, string>,
  ): Promise<void> {
    const snap = job.snapshot;
    snap.phase = 'verifying';
    snap.currentName = null;
    this.emit(job, true);
    const remote = leg.mode === 'upload' ? leg.to : leg.from;
    const remoteDir = leg.mode === 'upload' ? leg.toDir : leg.fromDir;
    const remoteKey = leg.mode === 'upload' ? 'destRel' : leg.fromKey;
    const names = manifest.files.map((f) => f[remoteKey]);
    const pipe = await remote.execPipe!(batchHashCommand(remoteDir, shq));
    let stderr = '';
    pipe.onStderr((text) => (stderr = (stderr + text).slice(-2048)));
    const onCancel = (): void => pipe.close();
    job.aborter.addEventListener('abort', onCancel);
    let remoteHashes: Map<string, string>;
    try {
      const output = collectPipe(pipe);
      const writer = new PipeWriter(pipe);
      await writer.write(encodeNulList(names)).catch(() => {});
      writer.end();
      const { stdout } = await output;
      this.checkCanceled(job);
      remoteHashes = parseHashLines(stdout);
      if (remoteHashes.size === 0 && /not found|No such/i.test(stderr)) {
        // No xargs or no checksum tool on the host: one file at a time.
        remoteHashes = new Map();
        for (const name of names) {
          this.checkCanceled(job);
          remoteHashes.set(name, await remote.hash(joinPath(remoteDir, name)));
        }
      }
    } finally {
      job.aborter.removeEventListener('abort', onCancel);
    }
    const bad: string[] = [];
    for (const f of manifest.files) {
      // Symlinks carry no digest (the host would hash their target instead).
      const mine = local.get(f.destRel);
      if (mine !== undefined && mine !== remoteHashes.get(f[remoteKey])) bad.push(f.destRel);
    }
    if (bad.length) {
      await Promise.all(bad.map((rel) => this.removeAt(leg.toHostId, joinPath(leg.toDir, rel))));
      const more = bad.length > 3 ? ` (+${bad.length - 3} more)` : '';
      throw new Error(`checksum mismatch: ${bad.slice(0, 3).join(', ')}${more}`);
    }
    snap.phase = 'copying';
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
    const manifest: Manifest = { dirs: [], files: [], moveRoots: [], renames: new Map() };
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
      manifest.renames.set(name, destName);

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
    const skipMac = job.req.skipMacMeta ?? true;
    for (const entry of listing.entries) {
      if (skipMac && isMacMeta(entry.name, entry.kind)) continue;
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
   *
   * The per-file path pays a few round trips per file however small it is,
   * so its ETA has two terms: small files left at the measured files/s, and
   * big bytes left at the link speed (the best rate seen while a big file
   * streamed; until one has, the current byte rate). A tar leg is one stream
   * and bandwidth-bound: bytes left over the byte rate.
   */
  private updateRate(job: Job, now: number): void {
    const snap = job.snapshot;
    const r = job.rate;
    const prog = job.prog;
    const last = r.samples[r.samples.length - 1];
    if (last && now - last.at < PROGRESS_INTERVAL_MS) return;
    const big = prog.bigInFlight !== null;
    r.samples.push({ at: now, bytes: snap.bytesDone, files: snap.filesDone ?? 0, big });
    while (r.samples.length > 2 && now - r.samples[1].at >= RATE_WINDOW_MS) r.samples.shift();
    const first = r.samples[0];
    const spanSec = (now - first.at) / 1000;
    if (spanSec <= 0) return;
    const rate = Math.max(0, (snap.bytesDone - first.bytes) / spanSec);
    const filesRate = Math.max(0, ((snap.filesDone ?? 0) - first.files) / spanSec);
    snap.bytesPerSec = Math.round(rate);
    snap.filesPerSec = Math.round(filesRate * 10) / 10;
    if (big && first.big && rate > r.bestBps) r.bestBps = rate;

    const remaining = snap.bytesTotal - snap.bytesDone;
    let raw: number | null = null;
    if (remaining <= 0 && (prog.tar || prog.smallLeft <= 0)) {
      raw = 0;
    } else if (prog.tar) {
      raw = rate > 0 ? remaining / rate : null;
    } else {
      const bps = Math.max(rate, r.bestBps);
      let secs = 0;
      if (prog.smallLeft > 0) {
        if (filesRate > 0) secs += prog.smallLeft / filesRate;
        else if (bps > 0) secs += prog.smallBytesLeft / bps;
        else secs = NaN;
      }
      const bigLeft = prog.bigBytesLeft - (prog.bigInFlight ?? 0);
      if (bigLeft > 0) secs += bps > 0 ? bigLeft / bps : NaN;
      raw = Number.isFinite(secs) ? secs : null;
    }
    if (raw !== null) {
      if (r.etaSec === null || raw === 0) {
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
