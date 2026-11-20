import type { AbortSignalLike, PipeChannel, SshTransport, TransferOpts } from '../ssh/transport';
import { shq } from '../shq';
import { uuid } from '../uuid';
import { isMacMeta } from './mac-meta';
import { parseWalk, walkCommand, type WalkedTree } from './remote-walk';
import {
  PipeWriter,
  batchHashCommand,
  collectPipe,
  encodeNulList,
  parseHashLines,
} from './stream-util';
import { TAR_MAX_OCTAL_SIZE, type TarEntryType } from './tar';
import { relayTar } from './tar-relay';

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

/**
 * What to do when a selected name already exists at the destination: keep
 * both (`rename`), replace it wholesale (`overwrite`), leave it (`skip`), or
 * `update` — merge into it, skipping files whose size and modification time
 * already match and resuming large partial ones.
 */
export type ConflictPolicy = 'rename' | 'overwrite' | 'skip' | 'update';
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
  /** Set by retry(): destination names an earlier attempt settled on. */
  destNames?: Record<string, string>;
}

/** What a running job is doing right now, finer than its stage. */
export type TransferPhase =
  | 'listing'
  | 'comparing'
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
  /** Files left alone because the destination already had them (update). */
  filesSkipped?: number;
  /** Smoothed files per second of the current stage; null until measurable. */
  filesPerSec?: number | null;
  /** A host→host job streaming straight from one host into the other (one
   *  stage, nothing staged on the Pear machine). */
  direct?: boolean;
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
  /** SHA-256 of the first `bytes` bytes of a file on the Pear machine. */
  prefixHash(path: string, bytes: number): Promise<string>;
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
  /** Source modification time; 0 when the listing did not carry one. */
  mtimeMs: number;
}

interface Manifest {
  /** Dest-relative directories to create, parents before children. */
  dirs: string[];
  files: ManifestFile[];
  /** Top-level source names to delete after a successful move. */
  moveRoots: string[];
  /** Top-level source name → destination name (differs after a rename). */
  renames: Map<string, string>;
  /** Files left out because the destination already has them (update). */
  skipped: number;
  /** destRel → bytes already at the destination of a large, shorter copy. */
  partials: Map<string, number>;
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
  /** Large partials worth keeping when the job fails: a retry resumes them. */
  keep: Set<string>;
  /** Destination names settled by the manifest, for retry(). */
  renames: Map<string, string> | null;
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
/**
 * Files from this size up travel one by one even next to a tar stream: the
 * windowed SFTP path is as fast for them, shows each file's progress, and can
 * resume a partial copy.
 */
const RESUME_MIN_BYTES = 32 * 1024 * 1024;
/** Same size and mtimes this close = the same file (FAT keeps 2 s steps). */
const MTIME_SLACK_MS = 2_000;
const PREFIX_HASH_TIMEOUT_MS = 10 * 60_000;
/** Prints tar's version line (for its flavour) and exits 0 iff tar exists. */
export const TAR_PROBE = 'tar --version 2>&1 | head -n 1; command -v tar >/dev/null 2>&1';
/** One `find` over a big tree may take a while on a slow disk. */
const WALK_TIMEOUT_MS = 120_000;

/** gnu and bsd tar read a NUL-separated file list from stdin; busybox does not. */
type TarFlavor = 'gnu' | 'bsd' | 'busybox';

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
      keep: new Set(),
      renames: null,
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

  /**
   * Run a failed or canceled job again as an update: what already arrived is
   * skipped, a large partial file is resumed, the rest is carried. Returns
   * the new job's id; the old one leaves the list.
   */
  retry(id: string): string {
    const job = this.jobs.get(id);
    if (!job) throw new Error('That transfer is no longer in the list');
    const { status } = job.snapshot;
    if (status !== 'error' && status !== 'canceled') throw new Error('Only a stopped transfer can be retried');
    this.jobs.delete(id);
    this.lastEmit.delete(id);
    // Without settled names the first attempt never got to copying, and its
    // own conflict policy still applies.
    const req: TransferRequest = job.renames
      ? { ...job.req, conflict: 'update', destNames: Object.fromEntries(job.renames) }
      : job.req;
    return this.start(req);
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
      job.renames = manifest.renames;
      snap.filesSkipped = manifest.skipped;
      snap.bytesTotal = manifest.files.reduce((a, f) => a + f.size, 0);
      snap.fileCount = manifest.files.length;
      const direct = snap.stages === 2 && (await this.canDirect(manifest, src, dest, job.req.src.dir));
      if (direct) {
        snap.stages = 1;
        snap.direct = true;
      }
      this.startStage(job, 0, manifest);

      if (direct) {
        await this.directStage(job, manifest, src, dest);
      } else if (snap.stages === 2) {
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
        // Siblings that were in flight when one file failed are half-written;
        // a large one stays, so a retry can pick it up where it stopped.
        await this.removePartial(job, job.keep);
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
    const remote = leg.mode === 'upload' ? leg.to : leg.from;
    // Many small files go as one tar stream; large ones stay on the per-file
    // path (see RESUME_MIN_BYTES) unless the host's tar cannot be handed a
    // file list, in which case a download takes everything in the stream.
    const small = manifest.files.filter((f) => f.size < RESUME_MIN_BYTES);
    let streamed: ManifestFile[] | null = null;
    if (await this.useTar({ ...manifest, files: small }, leg)) {
      const split = leg.mode === 'upload' || (await this.canTar(remote)) !== 'busybox';
      if (split) streamed = small;
      else if (manifest.files.every((f) => f.size <= TAR_MAX_OCTAL_SIZE)) streamed = manifest.files;
    }
    let rest = manifest.files;
    if (streamed) {
      await this.tarStage(job, { ...manifest, files: streamed }, leg);
      const inStream = new Set(streamed);
      rest = manifest.files.filter((f) => !inStream.has(f));
      job.prog.tar = false;
      if (!rest.length) return;
      snap.phase = 'copying';
    } else {
      await this.makeDirs(job, leg.to, leg.toDir, manifest.dirs);
    }

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

    let completedBytes = streamed ? snap.bytesDone : 0;
    let completedCount = streamed ? streamed.length : 0;
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
        const resumable = file.size >= RESUME_MIN_BYTES && remote.canResume === true;
        if (resumable) job.keep.add(toPath);
        const have = resumable ? manifest.partials.get(file.destRel) : undefined;
        const startOffset = have ? await this.resumeOffset(job, leg, fromPath, toPath, have) : 0;
        if (startOffset) {
          inflight.set(file, startOffset);
          refresh();
        }
        const opts: TransferOpts = {
          signal: stop,
          startOffset: startOffset || undefined,
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
        job.keep.delete(toPath);
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
      for (const file of rest) {
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

  /**
   * How much of a large file is already at the destination and can be
   * trusted: the destination's `have` bytes must hash the same as the
   * source's first `have` bytes. 0 = start over.
   */
  private async resumeOffset(
    job: Job,
    leg: Leg,
    fromPath: string,
    toPath: string,
    have: number,
  ): Promise<number> {
    const tar = this.env.tar;
    if (!tar) return 0;
    try {
      const remote = leg.mode === 'upload' ? leg.to : leg.from;
      const remotePath = leg.mode === 'upload' ? toPath : fromPath;
      const localPath = leg.mode === 'upload' ? fromPath : toPath;
      const p = shq(remotePath);
      const [far, near] = await Promise.all([
        remote.exec(
          `(head -c ${have} -- ${p} | sha256sum) 2>/dev/null || (head -c ${have} -- ${p} | shasum -a 256)`,
          { timeoutMs: PREFIX_HASH_TIMEOUT_MS },
        ),
        tar.prefixHash(localPath, have),
      ]);
      this.checkCanceled(job);
      const farHash = far.stdout.trim().split(/\s+/)[0]?.toLowerCase();
      return far.code === 0 && farHash === near ? have : 0;
    } catch {
      this.checkCanceled(job);
      return 0;
    }
  }

  // ---- tar legs ---------------------------------------------------------------

  /** Per transport: can it stream, does the route carry stdin, which tar is there. */
  private tarProbe = new WeakMap<SshTransport, Promise<TarFlavor | null>>();

  private canTar(t: SshTransport): Promise<TarFlavor | null> {
    const cached = this.tarProbe.get(t);
    if (cached) return cached;
    const probe = (async (): Promise<TarFlavor | null> => {
      if (!t.execPipe) return null;
      try {
        const pipe = await t.execPipe(TAR_PROBE);
        pipe.end();
        const timer = setTimeout(() => pipe.close(), TAR_PROBE_MS);
        const { code, stdout } = await collectPipe(pipe);
        clearTimeout(timer);
        if (code !== 0) return null;
        if (/GNU tar/i.test(stdout)) return 'gnu';
        if (/bsdtar|libarchive/i.test(stdout)) return 'bsd';
        return 'busybox';
      } catch {
        return null;
      }
    })();
    this.tarProbe.set(t, probe);
    return probe;
  }

  /** Roots mode: tar walks the selected entries itself (any tar). */
  private createCommand(dir: string, names: string[]): string {
    return `tar -c -f - -C ${shq(dir)} ${names.map((n) => shq('./' + n)).join(' ')}`;
  }

  /** List mode: exactly the files named on stdin, NUL-separated (gnu, bsd). */
  private listCommand(dir: string): string {
    return `tar -c -f - -C ${shq(dir)} --no-recursion --null -T -`;
  }

  private async useTar(manifest: Manifest, leg: Leg): Promise<boolean> {
    if (!this.env.tar || manifest.files.length < TAR_MIN_FILES) return false;
    const unsafe = (s: string): boolean => s.includes('\n');
    if (manifest.dirs.some(unsafe)) return false;
    for (const f of manifest.files) {
      if (f.size > TAR_MAX_OCTAL_SIZE || unsafe(f.srcRel) || unsafe(f.destRel)) return false;
    }
    const flavor = await this.canTar(leg.mode === 'upload' ? leg.to : leg.from);
    if (!flavor) return false;
    if (leg.mode === 'download' && flavor === 'busybox') {
      if (this.createCommand(leg.fromDir, manifest.moveRoots).length > TAR_CMD_MAX) return false;
    }
    return true;
  }

  /**
   * Carry the whole leg as one tar stream. Upload: the Pear machine packs,
   * `tar -x` on the host unpacks. Download: `tar -c` on the host packs —
   * exactly the manifest's files when its tar reads a list from stdin, else
   * the selected top-level entries — and the Pear machine unpacks what the
   * manifest wants (renamed roots, skipped metadata), dropping the rest.
   */
  private async tarStage(job: Job, manifest: Manifest, leg: Leg): Promise<void> {
    const snap = job.snapshot;
    job.prog.tar = true;
    const remote = leg.mode === 'upload' ? leg.to : leg.from;
    const listMode = leg.mode === 'download' && (await this.canTar(remote)) !== 'busybox';
    const command =
      leg.mode === 'upload'
        ? `tar -x -o -f - -C ${shq(leg.toDir)}`
        : listMode
          ? this.listCommand(leg.fromDir)
          : this.createCommand(leg.fromDir, manifest.moveRoots);
    // A file list carries no directory entries: make them here, so empty
    // folders exist too.
    if (listMode) await this.makeDirs(job, leg.to, leg.toDir, manifest.dirs);
    const pipe = await remote.execPipe!(command);
    let stderr = '';
    pipe.onStderr((text) => (stderr = (stderr + text).slice(-2048)));
    const closed = new Promise<number | null>((resolve) => pipe.onClose(resolve));
    if (listMode) {
      // Fed while the unpacker is already reading: tar starts streaming as
      // soon as the first names arrive. A failure here shows up as tar's exit.
      const feed = new PipeWriter(pipe);
      void feed
        .write(encodeNulList(manifest.files.map((f) => './' + f[leg.fromKey])))
        .then(() => feed.end())
        .catch(() => {});
    }
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

  // ---- host → host, direct ---------------------------------------------------

  private async canDirect(
    manifest: Manifest,
    src: SshTransport,
    dest: SshTransport,
    srcDir: string,
  ): Promise<boolean> {
    if (!manifest.files.length) return false;
    const unsafe = (s: string): boolean => s.includes('\n');
    if (manifest.dirs.some(unsafe)) return false;
    for (const f of manifest.files) {
      if (f.size > TAR_MAX_OCTAL_SIZE || unsafe(f.srcRel) || unsafe(f.destRel)) return false;
    }
    const [from, to] = await Promise.all([this.canTar(src), this.canTar(dest)]);
    if (!from || !to) return false;
    if (from === 'busybox' && this.createCommand(srcDir, manifest.moveRoots).length > TAR_CMD_MAX) {
      return false;
    }
    return true;
  }

  /**
   * One stage, no staging: `tar -c` on the source host streams through the
   * Pear machine's memory into `tar -x` on the destination host. Large files
   * ride along in the stream (nothing to resume from on a relay).
   */
  private async directStage(
    job: Job,
    manifest: Manifest,
    src: SshTransport,
    dest: SshTransport,
  ): Promise<void> {
    const snap = job.snapshot;
    const { req } = job;
    job.prog.tar = true;
    const listMode = (await this.canTar(src)) !== 'busybox';
    const srcPipe = await src.execPipe!(
      listMode ? this.listCommand(req.src.dir) : this.createCommand(req.src.dir, manifest.moveRoots),
    );
    let destPipe: PipeChannel;
    try {
      destPipe = await dest.execPipe!(`tar -x -o -f - -C ${shq(req.dest.dir)}`);
    } catch (err) {
      srcPipe.close();
      throw err;
    }
    let srcErr = '';
    let destErr = '';
    srcPipe.onStderr((t) => (srcErr = (srcErr + t).slice(-2048)));
    destPipe.onStderr((t) => (destErr = (destErr + t).slice(-2048)));
    const destClosed = new Promise<number | null>((resolve) => destPipe.onClose(resolve));
    const onCancel = (): void => {
      srcPipe.close();
      destPipe.close();
    };
    job.aborter.addEventListener('abort', onCancel);
    if (listMode) {
      const feed = new PipeWriter(srcPipe);
      void feed
        .write(encodeNulList(manifest.files.map((f) => './' + f.srcRel)))
        .then(() => feed.end())
        .catch(() => {});
    }

    const bySrc = new Map(manifest.files.map((f) => [f.srcRel, f]));
    const byDest = new Map(manifest.files.map((f) => [f.destRel, f]));
    let completedBytes = 0;
    let completedCount = 0;
    const recent: { path: string; end: number }[] = [];
    const prune = (sent: number): void => {
      while (recent.length && recent[0].end <= sent - PIPE_SLACK) {
        job.partials.delete(recent.shift()!.path);
      }
    };
    try {
      snap.phase = 'copying';
      let result: { atEnd: boolean; code: number | null };
      try {
        result = await relayTar(srcPipe, destPipe, {
          dirs: manifest.dirs,
          dirMtimeSec: Math.floor(this.now() / 1000),
          map: (path) => bySrc.get(path)?.destRel ?? null,
          onEntry: (destRel, phase) => {
            const file = byDest.get(destRel);
            if (!file) return;
            const toPath = joinPath(req.dest.dir, destRel);
            if (phase === 'start') {
              job.partials.set(toPath, req.dest.hostId);
              snap.currentName = destRel;
              snap.fileIndex = Math.min(completedCount + 1, manifest.files.length);
              return;
            }
            completedBytes += file.size;
            completedCount++;
            this.fileDone(job, file);
            recent.push({ path: toPath, end: completedBytes });
            prune(completedBytes);
            snap.bytesDone = completedBytes;
            this.emit(job, true);
          },
          onProgress: (destRel, bytes) => {
            const file = byDest.get(destRel);
            snap.bytesDone = completedBytes + (file ? Math.min(bytes, file.size) : 0);
            prune(snap.bytesDone);
            this.emit(job);
          },
        });
      } catch (err) {
        this.checkCanceled(job);
        destPipe.end();
        // Whichever side quit first explains the failure.
        const destCode = await Promise.race([
          destClosed,
          new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 2_000)),
        ]);
        destPipe.close();
        if (typeof destCode === 'number' && destCode !== 0) {
          throw new Error(this.tarError('tar -x', destCode, destErr));
        }
        throw new Error(`${this.tarError('tar -c', null, srcErr)}: ${messageOf(err)}`);
      }
      const destCode = await destClosed;
      this.checkCanceled(job);
      if (destCode !== 0) throw new Error(this.tarError('tar -x', destCode, destErr));
      const missing = manifest.files.length - completedCount;
      if (missing > 0 || !result.atEnd) {
        throw new Error(
          result.code === 0
            ? `${missing} file(s) were not in the stream from the source host`
            : this.tarError('tar -c', result.code, srcErr),
        );
      }
      for (const [path, hostId] of job.partials) if (hostId === req.dest.hostId) job.partials.delete(path);
      if (req.verify) {
        snap.phase = 'verifying';
        snap.currentName = null;
        this.emit(job, true);
        const [a, b] = await Promise.all([
          this.remoteHashes(job, src, req.src.dir, manifest.files.map((f) => f.srcRel)),
          this.remoteHashes(job, dest, req.dest.dir, manifest.files.map((f) => f.destRel)),
        ]);
        const bad = manifest.files.filter((f) => {
          const want = a.get(f.srcRel);
          // A symlink has nothing of its own to hash on either side.
          return want !== undefined && want !== b.get(f.destRel);
        });
        await this.failMismatched(job, req.dest.hostId, req.dest.dir, bad.map((f) => f.destRel));
        snap.phase = 'copying';
      }
    } finally {
      job.aborter.removeEventListener('abort', onCancel);
    }
  }

  /** SHA-256 of every named file under `dir` on a host, in one batch. */
  private async remoteHashes(
    job: Job,
    t: SshTransport,
    dir: string,
    names: string[],
  ): Promise<Map<string, string>> {
    const pipe = await t.execPipe!(batchHashCommand(dir, shq));
    let stderr = '';
    pipe.onStderr((text) => (stderr = (stderr + text).slice(-2048)));
    const onCancel = (): void => pipe.close();
    job.aborter.addEventListener('abort', onCancel);
    try {
      const output = collectPipe(pipe);
      const writer = new PipeWriter(pipe);
      await writer.write(encodeNulList(names)).catch(() => {});
      writer.end();
      const { stdout } = await output;
      this.checkCanceled(job);
      let hashes = parseHashLines(stdout);
      if (hashes.size === 0 && /not found|No such/i.test(stderr)) {
        // No xargs or no checksum tool on the host: one file at a time.
        hashes = new Map();
        for (const name of names) {
          this.checkCanceled(job);
          hashes.set(name, await t.hash(joinPath(dir, name)));
        }
      }
      return hashes;
    } finally {
      job.aborter.removeEventListener('abort', onCancel);
    }
  }

  /** Remove the files whose checksums disagreed and fail the job naming them. */
  private async failMismatched(
    job: Job,
    hostId: string | null,
    dir: string,
    bad: string[],
  ): Promise<void> {
    if (!bad.length) return;
    await Promise.all(bad.map((rel) => this.removeAt(hostId, joinPath(dir, rel))));
    const more = bad.length > 3 ? ` (+${bad.length - 3} more)` : '';
    throw new Error(`checksum mismatch: ${bad.slice(0, 3).join(', ')}${more}`);
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
    const remoteHashes = await this.remoteHashes(
      job,
      remote,
      remoteDir,
      manifest.files.map((f) => f[remoteKey]),
    );
    const bad: string[] = [];
    for (const f of manifest.files) {
      // Symlinks carry no digest (the host would hash their target instead).
      const mine = local.get(f.destRel);
      if (mine !== undefined && mine !== remoteHashes.get(f[remoteKey])) bad.push(f.destRel);
    }
    await this.failMismatched(job, leg.toHostId, leg.toDir, bad);
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

  private async removePartial(job: Job, keep?: Set<string>): Promise<void> {
    const partials = [...job.partials].filter(([path]) => !keep?.has(path));
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
    const manifest: Manifest = {
      dirs: [],
      files: [],
      moveRoots: [],
      renames: new Map(),
      skipped: 0,
      partials: new Map(),
    };
    for (const name of req.names) {
      this.checkCanceled(job);
      const srcPath = joinPath(req.src.dir, name);
      const st = await src.stat(srcPath);
      if (!st) throw new Error(`${srcPath}: no such file or directory`);

      let destName = req.destNames?.[name] ?? name;
      /** What the destination already holds under this root (update only). */
      let have: Map<string, { size: number; mtimeMs: number }> | null = null;
      const existing = await dest.stat(joinPath(req.dest.dir, destName));
      if (existing) {
        if (req.conflict === 'skip') continue;
        const sameShape = (existing.kind === 'dir') === (st.kind === 'dir');
        if (req.conflict === 'update' && sameShape) {
          if (existing.kind === 'dir') {
            job.snapshot.phase = 'comparing';
            this.emit(job, true);
            have = await this.listDest(job, dest, destName);
          } else {
            have = new Map([[destName, { size: existing.size, mtimeMs: existing.mtimeMs }]]);
          }
        } else if (req.conflict === 'overwrite' || req.conflict === 'update') {
          await dest.remove(joinPath(req.dest.dir, destName), true);
        } else {
          destName = await this.uniqueName(dest, req.dest.dir, name);
        }
      }
      manifest.moveRoots.push(name);
      manifest.renames.set(name, destName);
      const firstFile = manifest.files.length;

      if (st.kind === 'dir') {
        manifest.dirs.push(destName);
        const fast = req.src.hostId === null ? null : await this.fastWalk(job, src, req.src.dir, [name]);
        if (fast) {
          const rename = (rel: string): string => destName + rel.slice(name.length);
          for (const d of fast.dirs) if (d !== name) manifest.dirs.push(rename(d));
          for (const f of fast.files) {
            manifest.files.push({ srcRel: f.rel, destRel: rename(f.rel), size: f.size, mtimeMs: f.mtimeMs });
          }
        } else {
          await this.walkDir(job, src, srcPath, name, destName, manifest);
        }
      } else {
        manifest.files.push({ srcRel: name, destRel: destName, size: st.size, mtimeMs: st.mtimeMs });
      }
      if (have) this.dropUnchanged(manifest, firstFile, have);
    }
    return manifest;
  }

  /**
   * Update: leave out the files the destination already has (same size, same
   * modification time) and note large shorter copies as resumable.
   */
  private dropUnchanged(
    manifest: Manifest,
    from: number,
    have: Map<string, { size: number; mtimeMs: number }>,
  ): void {
    const kept: ManifestFile[] = [];
    for (const f of manifest.files.slice(from)) {
      const d = have.get(f.destRel);
      if (d && d.size === f.size && f.mtimeMs > 0 && Math.abs(d.mtimeMs - f.mtimeMs) <= MTIME_SLACK_MS) {
        manifest.skipped++;
        continue;
      }
      if (d && d.size > 0 && d.size < f.size && f.size >= RESUME_MIN_BYTES) {
        manifest.partials.set(f.destRel, d.size);
      }
      kept.push(f);
    }
    manifest.files.splice(from, manifest.files.length - from, ...kept);
  }

  /** Every file under dest.dir/name: relative path → size and mtime. */
  private async listDest(
    job: Job,
    dest: SshTransport,
    name: string,
  ): Promise<Map<string, { size: number; mtimeMs: number }>> {
    const { req } = job;
    const out = new Map<string, { size: number; mtimeMs: number }>();
    const fast = req.dest.hostId === null ? null : await this.fastWalk(job, dest, req.dest.dir, [name], false);
    if (fast) {
      for (const f of fast.files) out.set(f.rel, { size: f.size, mtimeMs: f.mtimeMs });
      return out;
    }
    const walk = async (rel: string): Promise<void> => {
      this.checkCanceled(job);
      const listing = await dest.listDir(joinPath(req.dest.dir, rel));
      for (const entry of listing.entries) {
        const child = rel + '/' + entry.name;
        if (entry.kind === 'dir') await walk(child);
        else out.set(child, { size: entry.size, mtimeMs: entry.mtimeMs });
      }
    };
    await walk(name);
    return out;
  }

  /**
   * A whole tree in one round trip (see remote-walk.ts); null when the host
   * cannot answer in that form, and the caller lists directory by directory.
   */
  private async fastWalk(
    job: Job,
    t: SshTransport,
    dir: string,
    names: string[],
    skipMac = job.req.skipMacMeta ?? true,
  ): Promise<WalkedTree | null> {
    try {
      const result = await t.exec(walkCommand(dir, names), { timeoutMs: WALK_TIMEOUT_MS });
      this.checkCanceled(job);
      if (result.code !== 0) return null;
      return parseWalk(result.stdout, names, { skipMacMeta: skipMac });
    } catch (err) {
      this.checkCanceled(job);
      return null;
    }
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
        manifest.files.push({ srcRel, destRel, size: entry.size, mtimeMs: entry.mtimeMs });
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
