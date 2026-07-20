import { createReadStream, createWriteStream, readFileSync, promises as fsp } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { basename, join } from 'node:path';
import { homedir } from 'node:os';
import { Client, type ClientChannel, type ConnectConfig, type SFTPWrapper } from 'ssh2';
import type { DirListing, FileEntry, HostConfig, TermSize } from '../types';
import type {
  AbortSignalLike,
  ExecResult,
  ShellChannel,
  SshTransport,
  TransferOpts,
} from '../ssh/transport';
import { kindOf, modeString } from '../ssh/mode';
import { shq } from '../shq';

/** Pass-through stream that reports cumulative bytes to a callback. */
export function byteCounter(onBytes: (bytes: number) => void): Transform {
  let seen = 0;
  return new Transform({
    transform(chunk: Buffer, _enc, done) {
      seen += chunk.length;
      onBytes(seen);
      done(null, chunk);
    },
  });
}

/** Bridge the pure layer's structural signal to a real Node AbortSignal. */
export function toAbortSignal(like?: AbortSignalLike): AbortSignal | undefined {
  if (!like) return undefined;
  const ac = new AbortController();
  if (like.aborted) ac.abort();
  else like.addEventListener('abort', () => ac.abort());
  return ac.signal;
}

const DEFAULT_KEYS = ['id_ed25519', 'id_rsa', 'id_ecdsa'];

function resolveAuth(cfg: HostConfig): Partial<ConnectConfig> {
  const auth = cfg.auth ?? {};
  const out: Partial<ConnectConfig> = {};

  if (auth.agent !== false && process.env.SSH_AUTH_SOCK) {
    out.agent = process.env.SSH_AUTH_SOCK;
  }
  if (auth.privateKeyPath) {
    out.privateKey = readFileSync(auth.privateKeyPath);
    if (auth.passphrase) out.passphrase = auth.passphrase;
  } else if (!out.agent) {
    // No agent and no explicit key: fall back to the first default key on disk
    for (const name of DEFAULT_KEYS) {
      try {
        out.privateKey = readFileSync(join(homedir(), '.ssh', name));
        break;
      } catch {
        // keep looking
      }
    }
  }
  if (auth.password) {
    out.password = auth.password;
    out.tryKeyboard = true;
  }
  return out;
}

/** Adapts an ssh2 ClientChannel to the platform-neutral ShellChannel. */
class Ssh2ShellChannel implements ShellChannel {
  constructor(private readonly channel: ClientChannel) {}

  write(data: string): void {
    this.channel.write(data);
  }

  resize(size: TermSize): void {
    this.channel.setWindow(size.rows, size.cols, 0, 0);
  }

  close(): void {
    this.channel.close();
  }

  onData(cb: (chunk: string) => void): void {
    this.channel.on('data', (d: Buffer) => cb(d.toString('utf8')));
    this.channel.stderr.on('data', (d: Buffer) => cb(d.toString('utf8')));
  }

  onClose(cb: () => void): void {
    this.channel.on('close', cb);
  }
}

/**
 * ssh2-backed SshTransport. One authenticated connection to a host; shell
 * channels, exec, and SFTP all multiplex over it. With `jump` set, the TCP
 * leg is a forwardOut stream through the jump host (ProxyJump) — auth still
 * happens end-to-end against the target, so the jump never sees credentials.
 */
export class SshConnection implements SshTransport {
  private client = new Client();
  private connected = false;

  constructor(
    readonly config: HostConfig,
    private readonly jump?: SshConnection,
  ) {}

  async connect(): Promise<void> {
    const cfg = this.config;
    // Dying jumps don't always surface as a sock error fast — tear down
    // deterministically when the tunnel's carrier goes away.
    this.jump?.onClose(() => this.dispose());
    const sock = this.jump ? await this.jump.forwardOut(cfg.host, cfg.port) : undefined;
    return new Promise((resolve, reject) => {
      const onError = (err: Error) => reject(err);
      this.client
        .once('error', onError)
        .once('ready', () => {
          this.client.removeListener('error', onError);
          this.connected = true;
          resolve();
        })
        .connect({
          host: cfg.host,
          port: cfg.port,
          sock,
          username: cfg.user,
          readyTimeout: 15_000,
          keepaliveInterval: 15_000,
          ...resolveAuth(cfg),
        });
      if (cfg.auth?.password) {
        this.client.on('keyboard-interactive', (_n, _i, _l, _p, finish) =>
          finish([cfg.auth?.password ?? '']),
        );
      }
    });
  }

  /** Open a TCP connection from this host to dstHost:dstPort (tunnel leg). */
  forwardOut(dstHost: string, dstPort: number): Promise<ClientChannel> {
    return new Promise((resolve, reject) => {
      this.client.forwardOut('127.0.0.1', 0, dstHost, dstPort, (err, stream) =>
        err ? reject(err) : resolve(stream),
      );
    });
  }

  get isConnected(): boolean {
    return this.connected;
  }

  onClose(cb: () => void): void {
    this.client.on('close', () => {
      this.connected = false;
      cb();
    });
  }

  /** Open an interactive PTY shell channel. */
  shell(size: TermSize, term = 'xterm-256color'): Promise<ShellChannel> {
    return new Promise((resolve, reject) => {
      this.client.shell(
        { term, cols: size.cols, rows: size.rows },
        (err, stream) => (err ? reject(err) : resolve(new Ssh2ShellChannel(stream))),
      );
    });
  }

  /** Run a command in a fresh PTY; the channel closes when it exits. */
  shellCommand(command: string, size: TermSize, term = 'xterm-256color'): Promise<ShellChannel> {
    return new Promise((resolve, reject) => {
      this.client.exec(
        command,
        { pty: { term, cols: size.cols, rows: size.rows } },
        (err, stream) => (err ? reject(err) : resolve(new Ssh2ShellChannel(stream))),
      );
    });
  }

  /** Run a single command, collect stdout/stderr, resolve on exit. */
  exec(command: string): Promise<ExecResult> {
    return new Promise((resolve, reject) => {
      this.client.exec(command, (err, stream) => {
        if (err) return reject(err);
        let stdout = '';
        let stderr = '';
        stream
          .on('data', (d: Buffer) => (stdout += d.toString('utf8')))
          .on('close', (code: number | null) =>
            resolve({ code: code ?? -1, stdout, stderr }),
          );
        stream.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
      });
    });
  }

  sftp(): Promise<SFTPWrapper> {
    if (!this.sftpPromise) {
      this.sftpPromise = new Promise((resolve, reject) => {
        this.client.sftp((err, sftp) => {
          if (err) {
            this.sftpPromise = undefined;
            reject(err);
          } else {
            sftp.on('close', () => (this.sftpPromise = undefined));
            resolve(sftp);
          }
        });
      });
    }
    return this.sftpPromise;
  }
  private sftpPromise?: Promise<SFTPWrapper>;

  /** List a remote directory. '~' resolves to the login home directory. */
  async listDir(path: string): Promise<DirListing> {
    const sftp = await this.sftp();
    const resolved = await new Promise<string>((resolve, reject) => {
      sftp.realpath(path === '~' || path === '' ? '.' : path, (err, abs) =>
        err ? reject(err) : resolve(abs),
      );
    });
    const raw = await new Promise<Parameters<Parameters<SFTPWrapper['readdir']>[1]>[1]>(
      (resolve, reject) => {
        sftp.readdir(resolved, (err, list) => (err ? reject(err) : resolve(list)));
      },
    );
    const entries: FileEntry[] = raw.map((item) => {
      const mode = item.attrs.mode ?? 0;
      return {
        name: item.filename,
        kind: kindOf(mode),
        size: item.attrs.size ?? 0,
        mtimeMs: (item.attrs.mtime ?? 0) * 1000,
        mode: modeString(mode),
      };
    });
    return { path: resolved, entries };
  }

  /**
   * Read a remote file as UTF-8. Refuses files larger than maxBytes —
   * the editor is for configs and code, not database dumps.
   */
  async readFile(path: string, maxBytes = 5 * 1024 * 1024): Promise<string> {
    const sftp = await this.sftp();
    const stat = await new Promise<{ size: number }>((resolve, reject) => {
      sftp.stat(path, (err, stats) => (err ? reject(err) : resolve(stats)));
    });
    if (stat.size > maxBytes) {
      throw new Error(`File is ${(stat.size / 1024 / 1024).toFixed(1)} MB — too large to edit`);
    }
    return new Promise((resolve, reject) => {
      sftp.readFile(path, (err, data) =>
        err ? reject(err) : resolve(data.toString('utf8')),
      );
    });
  }

  /** Write UTF-8 content to a remote file. */
  async writeFile(path: string, content: string): Promise<void> {
    const sftp = await this.sftp();
    return new Promise((resolve, reject) => {
      sftp.writeFile(path, Buffer.from(content, 'utf8'), (err: Error | null | undefined) =>
        err ? reject(err) : resolve(),
      );
    });
  }

  /** Upload a local file into a remote directory; returns the remote path. */
  async upload(localPath: string, remoteDir: string): Promise<string> {
    const remotePath = `${remoteDir.replace(/\/$/, '')}/${basename(localPath)}`;
    await this.uploadFile(localPath, remotePath);
    return remotePath;
  }

  async stat(path: string): Promise<FileEntry | null> {
    const sftp = await this.sftp();
    return new Promise((resolve, reject) => {
      sftp.lstat(path, (err, stats) => {
        // SFTP status 2 = no such file
        if (err) {
          return (err as Error & { code?: number }).code === 2 ? resolve(null) : reject(err);
        }
        const mode = stats.mode ?? 0;
        resolve({
          name: basename(path),
          kind: kindOf(mode),
          size: stats.size ?? 0,
          mtimeMs: (stats.mtime ?? 0) * 1000,
          mode: modeString(mode),
        });
      });
    });
  }

  async mkdir(path: string): Promise<void> {
    const sftp = await this.sftp();
    return new Promise((resolve, reject) => {
      sftp.mkdir(path, (err) => (err ? reject(err) : resolve()));
    });
  }

  async remove(path: string, recursive = false): Promise<void> {
    if (recursive) {
      return this.mustExec(`rm -rf -- ${shq(path)}`, 'delete');
    }
    const entry = await this.stat(path);
    if (!entry) return;
    const sftp = await this.sftp();
    return new Promise((resolve, reject) => {
      const done = (err: Error | null | undefined) => (err ? reject(err) : resolve());
      if (entry.kind === 'dir') sftp.rmdir(path, done);
      else sftp.unlink(path, done);
    });
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const sftp = await this.sftp();
    try {
      await new Promise<void>((resolve, reject) => {
        sftp.rename(oldPath, newPath, (err) => (err ? reject(err) : resolve()));
      });
    } catch {
      // SFTP RENAME refuses existing destinations and cross-device moves.
      await this.mustExec(`mv -f -- ${shq(oldPath)} ${shq(newPath)}`, 'move');
    }
  }

  async copy(src: string, dest: string): Promise<void> {
    await this.mustExec(`cp -a -- ${shq(src)} ${shq(dest)}`, 'copy');
  }

  async download(remotePath: string, localPath: string, opts?: TransferOpts): Promise<void> {
    const sftp = await this.sftp();
    const total = (await this.stat(remotePath))?.size ?? 0;
    const src = sftp.createReadStream(remotePath);
    const dest = createWriteStream(localPath);
    await pipeline(
      src,
      byteCounter((bytes) => opts?.onProgress?.({ bytes, total })),
      dest,
      { signal: toAbortSignal(opts?.signal) },
    );
  }

  async uploadFile(localPath: string, remotePath: string, opts?: TransferOpts): Promise<void> {
    const sftp = await this.sftp();
    const total = (await fsp.stat(localPath)).size;
    const src = createReadStream(localPath);
    const dest = sftp.createWriteStream(remotePath);
    await pipeline(
      src,
      byteCounter((bytes) => opts?.onProgress?.({ bytes, total })),
      dest,
      { signal: toAbortSignal(opts?.signal) },
    );
  }

  private async mustExec(command: string, what: string): Promise<void> {
    const result = await this.exec(command);
    if (result.code !== 0) {
      throw new Error(`${what} failed: ${result.stderr.trim() || `exit ${result.code}`}`);
    }
  }

  dispose(): void {
    this.connected = false;
    this.client.end();
  }
}
