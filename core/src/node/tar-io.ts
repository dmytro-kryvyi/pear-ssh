// The Node side of tar-streamed transfers: pack a local tree into a
// PipeChannel for `tar -x` on the host, or unpack what `tar -c` on the host
// streams back. Content never sits in memory beyond a few read pieces, and
// both directions honour the pipe's backpressure.

import { createHash } from 'node:crypto';
import { createGunzip, createGzip } from 'node:zlib';
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
async function prefixHash(path: string, bytes: number): Promise<string> {
  const hash = createHash('sha256');
  const fh = await fs.open(path, 'r');
  try {
    const buf = Buffer.allocUnsafe(READ_PIECE);
    let left = bytes;
    while (left > 0) {
      const { bytesRead } = await fh.read(buf, 0, Math.min(READ_PIECE, left), bytes - left);
      if (bytesRead === 0) break;
      hash.update(buf.subarray(0, bytesRead));
      left -= bytesRead;
    }
  } finally {
    await fh.close();
  }
  return hash.digest('hex');
}

async function sendFile(
  localPath: string,
  pipe: PipeChannel,
  opts: { onProgress(bytes: number): void },
): Promise<{ mode: number; mtimeSec: number }> {
  const out = new PipeWriter(pipe);
  const fh = await fs.open(localPath, 'r');
  try {
    const st = await fh.stat();
    const buffer = Buffer.allocUnsafe(READ_PIECE);
    let sent = 0;
    for (;;) {
      const { bytesRead } = await fh.read(buffer, 0, READ_PIECE, sent);
      if (bytesRead === 0) break;
      await out.write(Uint8Array.prototype.slice.call(buffer, 0, bytesRead) as Uint8Array);
      sent += bytesRead;
      opts.onProgress(sent);
    }
    if (sent === 0) opts.onProgress(0);
    out.end();
    return { mode: st.mode & 0o7777, mtimeSec: Math.floor(st.mtimeMs / 1000) };
  } finally {
    await fh.close();
  }
}

function receiveFile(
  pipe: PipeChannel,
  localPath: string,
  opts: { mtimeMs?: number; onProgress(bytes: number): void },
): Promise<{ code: number | null; bytes: number }> {
  return new Promise((resolve, reject) => {
    let chain: Promise<void> = Promise.resolve();
    let handle: fs.FileHandle | null = null;
    let failure: Error | null = null;
    let pending = 0;
    let paused = false;
    let bytes = 0;
    const fail = (err: unknown): void => {
      if (failure) return;
      failure = err instanceof Error ? err : new Error(String(err));
      pipe.close();
    };
    const enqueue = (step: () => Promise<void>): void => {
      chain = chain.then(() => (failure ? undefined : step())).catch(fail);
    };
    enqueue(async () => {
      handle = await fs.open(localPath, 'w');
    });
    pipe.onData((chunk) => {
      const copy = Uint8Array.prototype.slice.call(chunk) as Uint8Array;
      pending += copy.length;
      if (!paused && pending > UNPACK_HIGH) {
        paused = true;
        pipe.pause();
      }
      enqueue(async () => {
        await handle!.write(copy);
        pending -= copy.length;
        bytes += copy.length;
        if (paused && pending < UNPACK_LOW) {
          paused = false;
          pipe.resume();
        }
        opts.onProgress(bytes);
      });
    });
    pipe.onClose((code) => {
      void chain.then(async () => {
        await handle?.close().catch(() => {});
        if (failure) return reject(failure);
        if (code === 0 && opts.mtimeMs) {
          const t = new Date(opts.mtimeMs);
          await fs.utimes(localPath, t, t).catch(() => {});
        }
        if (bytes === 0) opts.onProgress(0);
        resolve({ code, bytes });
      });
    });
  });
}

/**
 * Writes are gzip-compressed on their way into the pipe. Level 1: on a link
 * worth compressing for, the cheap setting already wins most of the size.
 */
function gzip(pipe: PipeChannel): PipeChannel {
  const gz = createGzip({ level: 1 });
  gz.on('data', (chunk: Buffer) => {
    if (!pipe.write(chunk)) gz.pause();
  });
  pipe.onDrain(() => gz.resume());
  gz.on('end', () => pipe.end());
  gz.on('error', () => pipe.close());
  // Once the far side is gone nothing more may be written into the stream.
  pipe.onClose(() => gz.destroy());
  return {
    write: (chunk) => (gz.destroyed ? false : gz.write(chunk)),
    onDrain: (cb) => void gz.on('drain', cb),
    end: () => {
      if (!gz.destroyed) gz.end();
    },
    pause: () => pipe.pause(),
    resume: () => pipe.resume(),
    onData: (cb) => pipe.onData(cb),
    onStderr: (cb) => pipe.onStderr(cb),
    onClose: (cb) => pipe.onClose(cb),
    close: () => pipe.close(),
  };
}

/** Reads come out gunzipped; the close is reported after the last byte did. */
function gunzip(pipe: PipeChannel): PipeChannel {
  const gz = createGunzip();
  let finished = false;
  const done: (() => void)[] = [];
  const finish = (): void => {
    if (finished) return;
    finished = true;
    for (const cb of done) cb();
  };
  gz.on('end', finish);
  // A cut or corrupt stream: what was decoded so far stands, and the tar
  // reader downstream reports the truncation.
  gz.on('error', finish);
  gz.on('close', finish);
  pipe.onData((chunk) => {
    if (!finished && !gz.write(chunk)) pipe.pause();
  });
  gz.on('drain', () => pipe.resume());
  return {
    write: (chunk) => pipe.write(chunk),
    onDrain: (cb) => pipe.onDrain(cb),
    end: () => pipe.end(),
    pause: () => void gz.pause(),
    resume: () => void gz.resume(),
    onData: (cb) => void gz.on('data', cb),
    onStderr: (cb) => pipe.onStderr(cb),
    onClose: (cb) =>
      pipe.onClose((code) => {
        const report = (): void => cb(code);
        if (finished) return report();
        done.push(report);
        gz.end();
        // Nothing reading the decoded side yet must not hold the close back.
        gz.resume();
      }),
    close: () => pipe.close(),
  };
}

export const nodeTarIo: TarIo = { pack, unpack, prefixHash, sendFile, receiveFile, gzip, gunzip };

export type { TarEntry };
