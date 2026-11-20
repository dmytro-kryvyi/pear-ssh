// Host → host without touching a disk in between: the tar stream one host
// produces is re-addressed entry by entry (renamed roots, unwanted entries
// dropped) and written straight into `tar -x` on the other host. Pure — the
// Pear machine only shuffles bytes between two channels.

import type { PipeChannel } from '../ssh/transport';
import { PipeWriter } from './stream-util';
import { TarReader, TarWriter, type TarEntry, type TarEntryType } from './tar';

/** Hold the source back above this much not-yet-forwarded data. */
const RELAY_HIGH = 4 * 1024 * 1024;
const RELAY_LOW = 1024 * 1024;

export interface TarRelayOpts {
  /** Directories to create at the destination before any file (archive paths). */
  dirs: string[];
  /** Modification time stamped on those directories. */
  dirMtimeSec: number;
  /** Destination archive path for a source entry; null drops it. */
  map(path: string, type: TarEntryType): string | null;
  onEntry(destPath: string, phase: 'start' | 'done'): void;
  /** Payload bytes of the file in flight forwarded so far. */
  onProgress(destPath: string, bytes: number): void;
}

/**
 * Resolves once the source has closed and everything it sent was handed to
 * the destination (whose stdin is then ended). Rejects on a truncated source
 * stream or when the destination stops accepting data; either way the other
 * side is closed.
 */
export function relayTar(
  src: PipeChannel,
  dest: PipeChannel,
  opts: TarRelayOpts,
): Promise<{ atEnd: boolean; code: number | null }> {
  return new Promise((resolve, reject) => {
    const reader = new TarReader();
    const writer = new TarWriter();
    const out = new PipeWriter(dest);
    let chain: Promise<void> = Promise.resolve();
    let pending = 0;
    let paused = false;
    let failure: Error | null = null;
    /** Destination path of the entry being forwarded; null while dropping one. */
    let current: { path: string; type: TarEntryType; sent: number } | null = null;

    const fail = (err: unknown): void => {
      if (failure) return;
      failure = err instanceof Error ? err : new Error(String(err));
      src.close();
    };
    const enqueue = (step: () => Promise<void>): void => {
      chain = chain.then(() => (failure ? undefined : step())).catch(fail);
    };
    const forward = (bytes: Uint8Array, after?: () => void): void => {
      pending += bytes.length;
      if (!paused && pending > RELAY_HIGH) {
        paused = true;
        src.pause();
      }
      enqueue(async () => {
        await out.write(bytes);
        pending -= bytes.length;
        if (paused && pending < RELAY_LOW) {
          paused = false;
          src.resume();
        }
        after?.();
      });
    };

    for (const d of opts.dirs) {
      forward(
        writer.header({ path: d, type: 'dir', size: 0, mode: 0o755, mtimeSec: opts.dirMtimeSec }),
      );
    }

    reader.onEntry((entry: TarEntry) => {
      current = null;
      // Directories were sent up front from the manifest.
      if (entry.type === 'dir') return;
      const path = opts.map(entry.path, entry.type);
      if (path === null) return;
      let linkpath = entry.linkpath;
      if (entry.type === 'hardlink') {
        const target = entry.linkpath ? opts.map(entry.linkpath, 'file') : null;
        if (target === null) return;
        linkpath = target;
      }
      const mine = { path, type: entry.type, sent: 0 };
      current = mine;
      forward(writer.header({ ...entry, path, linkpath }), () => opts.onEntry(path, 'start'));
    });
    reader.onData((piece) => {
      const mine = current;
      if (!mine) return;
      // The reader hands out views into the channel's buffers.
      const copy = piece.slice();
      forward(copy, () => {
        mine.sent += copy.length;
        opts.onProgress(mine.path, mine.sent);
      });
    });
    reader.onEntryEnd((entry) => {
      const mine = current;
      if (!mine) return;
      current = null;
      forward(writer.padding(entry.size), () => opts.onEntry(mine.path, 'done'));
    });

    src.onData((chunk) => {
      if (failure) return;
      try {
        reader.push(chunk);
      } catch (err) {
        fail(err);
      }
    });
    src.onClose((code) => {
      void chain.then(async () => {
        if (failure) return reject(failure);
        try {
          reader.end();
          await out.write(writer.end());
          out.end();
        } catch (err) {
          dest.close();
          return reject(err);
        }
        resolve({ atEnd: reader.atEnd, code });
      });
    });
  });
}
