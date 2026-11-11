import { promises as fsp } from 'node:fs';
import type { SFTPWrapper } from 'ssh2';
import type { AbortSignalLike, TransferOpts, TransferProgress } from '../ssh/transport';

/**
 * Pipelined SFTP file transfer.
 *
 * ssh2's `createWriteStream` / `createReadStream` are stop-and-wait: one
 * request (≤ 64 KB) goes out, and the next waits for its reply. Throughput is
 * then one chunk per network round trip whatever the bandwidth — on a 20 ms
 * link that is ~3 MB/s, and a host reached through a jump (Proxmox VM) has a
 * longer round trip still. `fastPut`/`fastGet` do pipeline, but they take no
 * abort signal: the only way to stop one is to destroy the SFTP session,
 * which every other transfer and directory listing on the host shares.
 *
 * So this keeps a window of requests in flight itself, over the plain
 * open/read/write/close primitives, and stops issuing the moment the signal
 * fires. Progress reports bytes the server has acknowledged.
 */

const DEFAULT_CHUNK = 32 * 1024;
const MIN_CHUNK = 4 * 1024;
/** OpenSSH accepts up to 256 KB per request; ssh2 splits anything larger
 *  into sequential requests, which would quietly reintroduce the stall. */
const MAX_CHUNK = 256 * 1024;
/** Bytes outstanding per file; ssh2's own fastPut default is 2 MB. */
const WINDOW_BYTES = 4 * 1024 * 1024;
const MIN_INFLIGHT = 8;
/** A dead session never answers CLOSE; don't let cleanup hang on it. */
const CLOSE_TIMEOUT_MS = 10_000;

export class TransferAbortError extends Error {
  override readonly name = 'AbortError';
  constructor() {
    super('Transfer canceled');
  }
}

export const isAbortError = (err: unknown): boolean =>
  err instanceof TransferAbortError || (err instanceof Error && err.name === 'AbortError');

/**
 * ssh2 keeps the limits it negotiated with the server private. Use them when
 * they look sane (OpenSSH: ~254 KB, others: ~31 KB), else fall back to 32 KB
 * — the stop-and-wait size, but pipelined.
 */
function chunkSizes(sftp: SFTPWrapper): { read: number; write: number } {
  const s = sftp as unknown as { _maxReadLen?: unknown; _maxWriteLen?: unknown };
  const clamp = (v: unknown): number =>
    typeof v === 'number' && Number.isFinite(v) && v >= MIN_CHUNK
      ? Math.min(MAX_CHUNK, Math.floor(v))
      : DEFAULT_CHUNK;
  return { read: clamp(s._maxReadLen), write: clamp(s._maxWriteLen) };
}

const inflightFor = (chunk: number): number =>
  Math.max(MIN_INFLIGHT, Math.ceil(WINDOW_BYTES / chunk));

interface Piece {
  off: number;
  len: number;
}

interface DriveOpts {
  sftp: SFTPWrapper;
  total: number;
  chunk: number;
  inflight: number;
  signal?: AbortSignalLike;
  onProgress?: (p: TransferProgress) => void;
  /** Carry one piece; resolves with the bytes actually carried. Fewer than
   *  asked re-queues the remainder (short SFTP reads are legal). */
  step: (piece: Piece) => Promise<number>;
}

/**
 * The window driver: keeps `inflight` pieces outstanding, in order of issue,
 * until every byte is accounted for. The first failure — or the abort signal,
 * or the SFTP session closing underneath us — stops new pieces; what is
 * already in flight drains, then the promise settles.
 */
function drive(o: DriveOpts): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let next = 0;
    let active = 0;
    let done = 0;
    let settled = false;
    let failed: Error | null = null;
    const retry: Piece[] = [];

    const settle = (err: Error | null): void => {
      if (settled) return;
      settled = true;
      o.signal?.removeEventListener('abort', onAbort);
      o.sftp.removeListener('close', onClose);
      if (err) reject(err);
      else resolve();
    };
    const onAbort = (): void => {
      failed ??= new TransferAbortError();
      if (active === 0) settle(failed);
    };
    // Outstanding requests may never call back once the session is gone.
    const onClose = (): void => settle(failed ?? new Error('SFTP session closed during transfer'));

    const take = (): Piece | null => {
      const again = retry.shift();
      if (again) return again;
      if (next >= o.total) return null;
      const len = Math.min(o.chunk, o.total - next);
      const piece = { off: next, len };
      next += len;
      return piece;
    };

    const pump = (): void => {
      while (!failed && active < o.inflight) {
        const piece = take();
        if (!piece) break;
        active++;
        o.step(piece)
          .then(
            (n) => {
              done += n;
              if (n < piece.len) retry.push({ off: piece.off + n, len: piece.len - n });
              o.onProgress?.({ bytes: done, total: o.total });
            },
            (err: unknown) => {
              failed ??= err instanceof Error ? err : new Error(String(err));
            },
          )
          .finally(() => {
            active--;
            pump();
          });
      }
      if (active === 0 && !settled) {
        if (!failed && o.total === 0) o.onProgress?.({ bytes: 0, total: 0 });
        settle(failed);
      }
    };

    if (o.signal?.aborted) return settle(new TransferAbortError());
    o.signal?.addEventListener('abort', onAbort);
    o.sftp.on('close', onClose);
    pump();
  });
}

function openRemote(
  sftp: SFTPWrapper,
  path: string,
  flags: 'r' | 'w',
  mode?: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const cb = (err: Error | undefined, handle: Buffer): void =>
      err ? reject(err) : resolve(handle);
    if (mode === undefined) sftp.open(path, flags, cb);
    else sftp.open(path, flags, mode, cb);
  });
}

function fstatRemote(sftp: SFTPWrapper, handle: Buffer): Promise<{ size: number }> {
  return new Promise((resolve, reject) => {
    sftp.fstat(handle, (err, stats) => (err ? reject(err) : resolve(stats)));
  });
}

/** Close a handle, giving up (quietly) when the session no longer answers. */
function closeRemote(sftp: SFTPWrapper, handle: Buffer, sessionGone: () => boolean): Promise<void> {
  if (sessionGone()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, CLOSE_TIMEOUT_MS);
    sftp.close(handle, (err) => {
      clearTimeout(timer);
      if (err && !sessionGone()) reject(err);
      else resolve();
    });
  });
}

/** Track whether the SFTP session died while we were using it. */
function sessionWatch(sftp: SFTPWrapper): { gone: () => boolean; dispose: () => void } {
  let gone = false;
  const onClose = (): void => {
    gone = true;
  };
  sftp.on('close', onClose);
  return { gone: () => gone, dispose: () => sftp.removeListener('close', onClose) };
}

/**
 * Upload a local file to an exact remote path, pipelined. The remote file is
 * created with the source's permission bits.
 */
export async function sftpPut(
  sftp: SFTPWrapper,
  localPath: string,
  remotePath: string,
  opts?: TransferOpts,
): Promise<void> {
  const st = await fsp.stat(localPath);
  if (!st.isFile()) throw new Error(`${localPath}: not a regular file`);
  const total = st.size;
  const { write: chunk } = chunkSizes(sftp);
  const watch = sessionWatch(sftp);
  const fh = await fsp.open(localPath, 'r');
  try {
    const handle = await openRemote(sftp, remotePath, 'w', st.mode & 0o777);
    let primary: unknown = null;
    try {
      await drive({
        sftp,
        total,
        chunk,
        inflight: inflightFor(chunk),
        signal: opts?.signal,
        onProgress: opts?.onProgress,
        step: async ({ off, len }) => {
          const buf = Buffer.allocUnsafe(len);
          const { bytesRead } = await fh.read(buf, 0, len, off);
          if (bytesRead !== len) throw new Error(`${localPath}: file changed during transfer`);
          await new Promise<void>((resolve, reject) => {
            sftp.write(handle, buf, 0, len, off, (err) => (err ? reject(err) : resolve()));
          });
          return len;
        },
      });
    } catch (err) {
      primary = err;
      throw err;
    } finally {
      // Close before the caller's partial-file cleanup runs; a close failure
      // only matters when the transfer itself succeeded.
      try {
        await closeRemote(sftp, handle, watch.gone);
      } catch (err) {
        if (primary === null) throw err;
      }
    }
  } finally {
    watch.dispose();
    await fh.close();
  }
}

/** Download a remote file to an exact local path, pipelined. */
export async function sftpGet(
  sftp: SFTPWrapper,
  remotePath: string,
  localPath: string,
  opts?: TransferOpts,
): Promise<void> {
  const watch = sessionWatch(sftp);
  try {
    const handle = await openRemote(sftp, remotePath, 'r');
    let primary: unknown = null;
    try {
      const total = (await fstatRemote(sftp, handle)).size;
      const { read: chunk } = chunkSizes(sftp);
      const fh = await fsp.open(localPath, 'w');
      try {
        await drive({
          sftp,
          total,
          chunk,
          inflight: inflightFor(chunk),
          signal: opts?.signal,
          onProgress: opts?.onProgress,
          step: async ({ off, len }) => {
            const buf = Buffer.allocUnsafe(len);
            const got = await new Promise<number>((resolve, reject) => {
              sftp.read(handle, buf, 0, len, off, (err, bytesRead) =>
                err ? reject(err) : resolve(bytesRead),
              );
            });
            // EOF before the size fstat reported: the file shrank under us.
            if (got === 0) throw new Error(`${remotePath}: file changed during transfer`);
            await fh.write(buf, 0, got, off);
            return got;
          },
        });
      } finally {
        await fh.close();
      }
    } catch (err) {
      primary = err;
      throw err;
    } finally {
      try {
        await closeRemote(sftp, handle, watch.gone);
      } catch (err) {
        if (primary === null) throw err;
      }
    }
  } finally {
    watch.dispose();
  }
}
