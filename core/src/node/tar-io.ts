// The Node side of tar-streamed transfers: pack a local tree into a
// PipeChannel for `tar -x` on the host, or unpack what `tar -c` on the host
// streams back. Content never sits in memory beyond a few read pieces, and
// both directions honour the pipe's backpressure.

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import type { PipeChannel } from '../ssh/transport';
import type { TarIo, TarPackInput, TarPackOpts, TarUnpackOpts } from '../transfers/engine';
import { TarReader, TarWriter, type TarEntry } from '../transfers/tar';
import { PipeWriter } from '../transfers/stream-util';

const READ_PIECE = 256 * 1024;
/** Pause the remote sender above this much unwritten payload, resume below. */
const UNPACK_HIGH = 4 * 1024 * 1024;
const UNPACK_LOW = 1024 * 1024;

async function pack(
  dir: string,
  input: TarPackInput,
  pipe: PipeChannel,
  opts: TarPackOpts,
): Promise<void> {
  const writer = new TarWriter();
  const out = new PipeWriter(pipe);
  const now = Math.floor(Date.now() / 1000);
  for (const d of input.dirs) {
    await out.write(writer.header({ path: d, type: 'dir', size: 0, mode: 0o755, mtimeSec: now }));
  }
  const buffer = Buffer.allocUnsafe(READ_PIECE);
  for (let i = 0; i < input.files.length; i++) {
    const file = input.files[i];
    const abs = join(dir, file.src);
    opts.onEntry(i, 'start');
    const st = await fs.lstat(abs);
    const mtimeSec = Math.floor(st.mtimeMs / 1000);
    if (st.isSymbolicLink()) {
      const target = await fs.readlink(abs);
      await out.write(
        writer.header({
          path: file.entry,
          type: 'symlink',
          size: 0,
          mode: 0o777,
          mtimeSec,
          linkpath: target,
        }),
      );
      opts.onEntry(i, 'done');
      continue;
    }
    if (!st.isFile()) throw new Error(`${abs}: not a regular file`);
    const fh = await fs.open(abs, 'r');
    try {
      // The header must match the bytes that follow it, so the size comes
      // from the open handle, not from the listing taken earlier.
      const size = (await fh.stat()).size;
      await out.write(
        writer.header({ path: file.entry, type: 'file', size, mode: st.mode & 0o7777, mtimeSec }),
      );
      const hash = opts.hash ? createHash('sha256') : null;
      let sent = 0;
      while (sent < size) {
        const want = Math.min(READ_PIECE, size - sent);
        const { bytesRead } = await fh.read(buffer, 0, want, sent);
        if (bytesRead === 0) {
          // Shrunk under us: keep the stream well-formed, then fail the job.
          await out.write(new Uint8Array(size - sent));
          await out.write(writer.padding(size));
          throw new Error(`${abs}: file changed during transfer`);
        }
        const piece = Uint8Array.prototype.slice.call(buffer, 0, bytesRead) as Uint8Array;
        hash?.update(piece);
        await out.write(piece);
        sent += bytesRead;
        opts.onProgress(i, sent);
      }
      await out.write(writer.padding(size));
      opts.onEntry(i, 'done', hash?.digest('hex'));
    } finally {
      await fh.close();
    }
  }
  await out.write(writer.end());
  out.end();
}

interface OpenFile {
  localRel: string;
  handle: fs.FileHandle;
  hash: ReturnType<typeof createHash> | null;
  mtimeSec: number;
  written: number;
}

function unpack(
  pipe: PipeChannel,
  dir: string,
  opts: TarUnpackOpts,
): Promise<{ atEnd: boolean; code: number | null }> {
  return new Promise((resolve, reject) => {
    const reader = new TarReader();
    let chain: Promise<void> = Promise.resolve();
    let pending = 0;
    let paused = false;
    let failure: Error | null = null;
    let current: OpenFile | null = null;
    let exit: { code: number | null } | null = null;

    const fail = (err: unknown): void => {
      if (failure) return;
      failure = err instanceof Error ? err : new Error(String(err));
      pipe.close();
    };
    // Every filesystem step runs in order, after the previous one; the
    // callbacks below only enqueue.
    const enqueue = (step: () => Promise<void>): void => {
      chain = chain.then(() => (failure ? undefined : step())).catch(fail);
    };
    const settle = (): void => {
      void chain.then(() => {
        if (failure) return reject(failure);
        try {
          reader.end();
        } catch (err) {
          return reject(err);
        }
        resolve({ atEnd: reader.atEnd, code: exit?.code ?? null });
      });
    };

    reader.onEntry((entry) => {
      const localRel =
        entry.type === 'hardlink' ? opts.map(entry.path, 'file') : opts.map(entry.path, entry.type);
      if (localRel === null) return; // skipped: its payload is drained by the reader
      const abs = join(dir, localRel);
      enqueue(async () => {
        switch (entry.type) {
          case 'dir':
            await fs.mkdir(abs, { recursive: true });
            await fs.chmod(abs, entry.mode & 0o7777 || 0o755).catch(() => {});
            return;
          case 'symlink':
            await fs.mkdir(dirname(abs), { recursive: true });
            await fs.rm(abs, { force: true });
            await fs.symlink(entry.linkpath ?? '', abs);
            opts.onEntry(localRel, 'done');
            return;
          case 'hardlink': {
            const targetRel = entry.linkpath ? opts.map(entry.linkpath, 'file') : null;
            if (targetRel === null) return;
            await fs.mkdir(dirname(abs), { recursive: true });
            await fs.rm(abs, { force: true });
            const target = join(dir, targetRel);
            await fs.link(target, abs).catch(() => fs.copyFile(target, abs));
            opts.onEntry(localRel, 'done', opts.hash ? await fileSha256(abs) : undefined);
            return;
          }
          case 'file': {
            opts.onEntry(localRel, 'start');
            await fs.mkdir(dirname(abs), { recursive: true });
            const handle = await fs.open(abs, 'w', entry.mode & 0o7777 || 0o644);
            current = {
              localRel,
              handle,
              hash: opts.hash ? createHash('sha256') : null,
              mtimeSec: entry.mtimeSec,
              written: 0,
            };
          }
        }
      });
    });
    reader.onData((piece) => {
      // The reader may hand us a view into the socket's buffer; copy before
      // the write is queued behind earlier ones.
      const copy = Uint8Array.prototype.slice.call(piece) as Uint8Array;
      pending += copy.length;
      if (!paused && pending > UNPACK_HIGH) {
        paused = true;
        pipe.pause();
      }
      enqueue(async () => {
        pending -= copy.length;
        if (paused && pending < UNPACK_LOW) {
          paused = false;
          pipe.resume();
        }
        if (!current) return;
        await current.handle.write(copy);
        current.hash?.update(copy);
        current.written += copy.length;
        opts.onProgress(current.localRel, current.written);
      });
    });
    reader.onEntryEnd((entry) => {
      if (entry.type !== 'file') return;
      enqueue(async () => {
        const open = current;
        current = null;
        if (!open) return;
        await open.handle.close();
        if (open.mtimeSec > 0) {
          const t = new Date(open.mtimeSec * 1000);
          await fs.utimes(join(dir, open.localRel), t, t).catch(() => {});
        }
        opts.onEntry(open.localRel, 'done', open.hash?.digest('hex'));
      });
    });

    pipe.onData((chunk) => {
      try {
        reader.push(chunk);
      } catch (err) {
        fail(err);
      }
    });
    pipe.onClose((code) => {
      exit = { code };
      enqueue(async () => {
        if (current) {
          await current.handle.close().catch(() => {});
          current = null;
        }
      });
      settle();
    });
  });
}

async function fileSha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  const fh = await fs.open(path, 'r');
  try {
    const buf = Buffer.allocUnsafe(READ_PIECE);
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, READ_PIECE, null);
      if (bytesRead === 0) break;
      hash.update(buf.subarray(0, bytesRead));
    }
  } finally {
    await fh.close();
  }
  return hash.digest('hex');
}

/** The TarIo the Node-hosted engine (desktop, pear-server) injects. */
export const nodeTarIo: TarIo = { pack, unpack };

export type { TarEntry };
