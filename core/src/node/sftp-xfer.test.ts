import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Server, utils, type Connection, type SFTPWrapper } from 'ssh2';
import type { HostConfig } from '../types';
import { SshConnection } from './connection';
import { isAbortError } from './sftp-xfer';

const { STATUS_CODE, OPEN_MODE } = utils.sftp;

/** Simulated network round trip: every reply waits this long. */
const RTT_MS = 20;
/** The server answers READ with at most this much, so short reads happen. */
const READ_CAP = 16 * 1024;

/**
 * An in-memory SFTP server: files are Buffers, every request is answered
 * after RTT_MS. Stop-and-wait would need (size / chunk) round trips; the
 * pipelined client should finish in a handful.
 */
class FakeSftpHost {
  readonly files = new Map<string, Buffer>();
  readonly handles = new Map<string, string>();
  readonly openModes: number[] = [];
  writes = 0;
  /** When set, the connection is dropped after this many WRITE requests. */
  dropAfterWrites: number | null = null;
  /** mtime (seconds) per path, as set by FSETSTAT or seeded by a test. */
  mtimes = new Map<string, number>();
  openFlags: number[] = [];
  private nextHandle = 0;

  attach(client: Connection, sftp: SFTPWrapper): void {
    const later = (fn: () => void): void => void setTimeout(fn, RTT_MS);
    const attrsOf = (buf: Buffer, path?: string) => ({
      mode: 0o100644,
      uid: 0,
      gid: 0,
      size: buf.length,
      atime: 0,
      mtime: (path && this.mtimes.get(path)) || 0,
    });
    sftp.on('OPEN', (reqid, filename, flags, attrs) => {
      if (flags & OPEN_MODE.WRITE) {
        // Truncate only when asked: a resumed upload reopens without TRUNC.
        if (flags & OPEN_MODE.TRUNC || !this.files.has(filename)) {
          this.files.set(filename, Buffer.alloc(0));
        }
        this.openModes.push(attrs.mode);
        this.openFlags.push(flags);
      } else if (!this.files.has(filename)) {
        return later(() => sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE));
      }
      const handle = Buffer.from(String(++this.nextHandle));
      this.handles.set(handle.toString(), filename);
      later(() => sftp.handle(reqid, handle));
    });
    sftp.on('WRITE', (reqid, handle, offset, data) => {
      const path = this.handles.get(handle.toString())!;
      const cur = this.files.get(path) ?? Buffer.alloc(0);
      const grown = cur.length >= offset + data.length ? cur : Buffer.concat([cur, Buffer.alloc(offset + data.length - cur.length)]);
      data.copy(grown, offset);
      this.files.set(path, grown);
      this.writes++;
      if (this.dropAfterWrites !== null && this.writes >= this.dropAfterWrites) {
        client.end();
        return;
      }
      later(() => sftp.status(reqid, STATUS_CODE.OK));
    });
    sftp.on('READ', (reqid, handle, offset, len) => {
      const buf = this.files.get(this.handles.get(handle.toString())!)!;
      if (offset >= buf.length) return later(() => sftp.status(reqid, STATUS_CODE.EOF));
      const slice = buf.subarray(offset, Math.min(buf.length, offset + Math.min(len, READ_CAP)));
      later(() => sftp.data(reqid, slice));
    });
    sftp.on('FSTAT', (reqid, handle) => {
      const path = this.handles.get(handle.toString())!;
      later(() => sftp.attrs(reqid, attrsOf(this.files.get(path)!, path)));
    });
    sftp.on('FSETSTAT', (reqid, handle, attrs) => {
      const path = this.handles.get(handle.toString())!;
      if (attrs.mtime !== undefined) this.mtimes.set(path, attrs.mtime);
      later(() => sftp.status(reqid, STATUS_CODE.OK));
    });
    const statPath = (reqid: number, path: string): void => {
      const buf = this.files.get(path);
      later(() => (buf ? sftp.attrs(reqid, attrsOf(buf)) : sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE)));
    };
    sftp.on('LSTAT', statPath);
    sftp.on('STAT', statPath);
    sftp.on('CLOSE', (reqid, handle) => {
      this.handles.delete(handle.toString());
      later(() => sftp.status(reqid, STATUS_CODE.OK));
    });
    sftp.on('REMOVE', (reqid, path) => {
      this.files.delete(path);
      later(() => sftp.status(reqid, STATUS_CODE.OK));
    });
  }
}

let server: Server;
let port: number;
let remote: FakeSftpHost;
let dir: string;

before(async () => {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
  });
  remote = new FakeSftpHost();
  server = new Server({ hostKeys: [privateKey] }, (client) => {
    client.on('error', () => {});
    client.on('authentication', (ctx) => ctx.accept());
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept();
        session.on('sftp', (acceptSftp) => remote.attach(client, acceptSftp()));
      });
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      port = (server.address() as { port: number }).port;
      resolve();
    });
  });
  dir = await mkdtemp(join(tmpdir(), 'pear-sftp-xfer-'));
});

after(async () => {
  server.close();
  await rm(dir, { recursive: true, force: true });
});

async function connect(): Promise<SshConnection> {
  const host: HostConfig = {
    id: 'loop',
    name: 'loopback',
    host: '127.0.0.1',
    port,
    user: 'tester',
    kind: 'plain',
    auth: { agent: false, password: 'pw' },
  };
  const conn = new SshConnection(host);
  await conn.connect();
  return conn;
}

function aborter(): { signal: AbortSignal; abort: () => void } {
  const ac = new AbortController();
  return { signal: ac.signal, abort: () => ac.abort() };
}

test('upload pipelines requests: 4 MB in a few round trips, byte-exact, monotonic progress', async () => {
  const conn = await connect();
  try {
    const data = randomBytes(4 * 1024 * 1024);
    const local = join(dir, 'up.bin');
    await writeFile(local, data);
    const seen: number[] = [];
    const started = Date.now();
    await conn.uploadFile(local, '/remote/up.bin', {
      onProgress: (p) => {
        assert.equal(p.total, data.length);
        seen.push(p.bytes);
      },
    });
    const elapsed = Date.now() - started;
    assert.ok(remote.files.get('/remote/up.bin')!.equals(data), 'remote content differs');
    assert.ok(seen.length > 0);
    assert.equal(seen.at(-1), data.length);
    for (let i = 1; i < seen.length; i++) assert.ok(seen[i] >= seen[i - 1], 'progress went backwards');
    // Stop-and-wait at ~32 KB per RTT_MS would need > 2.5 s for 4 MB.
    assert.ok(elapsed < 1000, `took ${elapsed} ms — not pipelined?`);
    assert.equal(remote.handles.size, 0, 'remote handle left open');
  } finally {
    conn.dispose();
  }
});

test('upload keeps the source permission bits', async () => {
  const conn = await connect();
  try {
    const local = join(dir, 'secret.txt');
    await writeFile(local, 'shh');
    await chmod(local, 0o600);
    remote.openModes.length = 0;
    await conn.uploadFile(local, '/remote/secret.txt');
    assert.equal(remote.openModes[0] & 0o777, 0o600);
  } finally {
    conn.dispose();
  }
});

test('modification times travel with the file in both directions', async () => {
  const conn = await connect();
  try {
    const local = join(dir, 'dated.txt');
    await writeFile(local, 'old news');
    await utimes(local, new Date(1_600_000_000_000), new Date(1_600_000_000_000));
    await conn.uploadFile(local, '/remote/dated.txt');
    assert.equal(remote.mtimes.get('/remote/dated.txt'), 1_600_000_000);

    remote.files.set('/remote/older.txt', Buffer.from('older'));
    remote.mtimes.set('/remote/older.txt', 1_500_000_000);
    const back = join(dir, 'older.txt');
    await conn.download('/remote/older.txt', back);
    assert.equal(Math.floor((await stat(back)).mtimeMs / 1000), 1_500_000_000);
  } finally {
    conn.dispose();
  }
});

test('a transfer resumes from an offset without touching what is already there', async () => {
  const conn = await connect();
  try {
    const data = randomBytes(2 * 1024 * 1024 + 77);
    const half = 1024 * 1024;
    // Upload: the remote holds the first half already.
    const local = join(dir, 'resume-up.bin');
    await writeFile(local, data);
    remote.files.set('/remote/resume-up.bin', Buffer.from(data.subarray(0, half)));
    remote.writes = 0;
    const seen: number[] = [];
    await conn.uploadFile(local, '/remote/resume-up.bin', { startOffset: half, onProgress: (p) => seen.push(p.bytes) });
    assert.ok(remote.files.get('/remote/resume-up.bin')!.equals(data));
    assert.ok(seen[0] > half, 'progress starts after the part already there');
    assert.equal(seen.at(-1), data.length);
    assert.equal(remote.openFlags.at(-1)! & OPEN_MODE.TRUNC, 0, 'reopened without truncating');

    // Download: the local file holds the first half already.
    remote.files.set('/remote/resume-down.bin', data);
    const back = join(dir, 'resume-down.bin');
    await writeFile(back, data.subarray(0, half));
    await conn.download('/remote/resume-down.bin', back, { startOffset: half });
    assert.ok((await readFile(back)).equals(data));
  } finally {
    conn.dispose();
  }
});

test('abort stops an upload promptly, closes the handle, leaves the partial for cleanup', async () => {
  const conn = await connect();
  try {
    const data = randomBytes(16 * 1024 * 1024);
    const local = join(dir, 'abort.bin');
    await writeFile(local, data);
    const { signal, abort } = aborter();
    let abortedAt = 0;
    const err = await conn
      .uploadFile(local, '/remote/abort.bin', {
        signal,
        onProgress: () => {
          if (!abortedAt) {
            abortedAt = Date.now();
            abort();
          }
        },
      })
      .then(
        () => null,
        (e: unknown) => e,
      );
    assert.ok(err instanceof Error && isAbortError(err), `expected AbortError, got ${String(err)}`);
    assert.ok(Date.now() - abortedAt < 500, 'abort took too long to settle');
    assert.ok(remote.files.get('/remote/abort.bin')!.length < data.length, 'whole file was sent despite abort');
    assert.equal(remote.handles.size, 0, 'remote handle left open after abort');
    // The engine's partial cleanup runs remove() on the same session afterwards.
    await conn.remove('/remote/abort.bin');
    assert.equal(remote.files.has('/remote/abort.bin'), false);
  } finally {
    conn.dispose();
  }
});

test('download pipelines reads, survives short reads, byte-exact', async () => {
  const conn = await connect();
  try {
    const data = randomBytes(3 * 1024 * 1024 + 123);
    remote.files.set('/remote/down.bin', data);
    const local = join(dir, 'down.bin');
    const seen: number[] = [];
    const started = Date.now();
    await conn.download('/remote/down.bin', local, {
      onProgress: (p) => {
        assert.equal(p.total, data.length);
        seen.push(p.bytes);
      },
    });
    const elapsed = Date.now() - started;
    assert.ok((await readFile(local)).equals(data), 'downloaded content differs');
    assert.equal(seen.at(-1), data.length);
    for (let i = 1; i < seen.length; i++) assert.ok(seen[i] >= seen[i - 1]);
    // ~200 capped reads of 16 KB at RTT_MS each would be 4 s stop-and-wait.
    assert.ok(elapsed < 1000, `took ${elapsed} ms — not pipelined?`);
    assert.equal(remote.handles.size, 0);
  } finally {
    conn.dispose();
  }
});

test('zero-byte files transfer both ways and report 0/0', async () => {
  const conn = await connect();
  try {
    const local = join(dir, 'empty');
    await writeFile(local, '');
    const ups: number[] = [];
    await conn.uploadFile(local, '/remote/empty', { onProgress: (p) => ups.push(p.total) });
    assert.equal(remote.files.get('/remote/empty')!.length, 0);
    assert.deepEqual(ups, [0]);
    const downs: number[] = [];
    await conn.download('/remote/empty', join(dir, 'empty2'), { onProgress: (p) => downs.push(p.total) });
    assert.equal((await readFile(join(dir, 'empty2'))).length, 0);
    assert.deepEqual(downs, [0]);
  } finally {
    conn.dispose();
  }
});

test('a session dropped mid-transfer rejects instead of hanging', async () => {
  const conn = await connect();
  try {
    const local = join(dir, 'drop.bin');
    await writeFile(local, randomBytes(2 * 1024 * 1024));
    remote.writes = 0;
    remote.dropAfterWrites = 5;
    const started = Date.now();
    await assert.rejects(conn.uploadFile(local, '/remote/drop.bin'));
    assert.ok(Date.now() - started < 3000, 'took too long to notice the dropped session');
  } finally {
    remote.dropAfterWrites = null;
    conn.dispose();
  }
});
