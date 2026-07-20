import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { basename, isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';
import type { DirListing, FileEntry, TermSize } from '../types';
import type { ExecResult, ShellChannel, SshTransport, TransferOpts } from '../ssh/transport';
import { kindOf, modeString } from '../ssh/mode';
import { byteCounter, toAbortSignal } from './connection';
import type { IPty } from '@lydell/node-pty';

// node-pty is a native module; loaded lazily so a missing/mismatched binary
// only breaks opening local terminals, not exec/files or the app itself.
function loadPty(): typeof import('@lydell/node-pty') {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('@lydell/node-pty');
  } catch (err) {
    throw new Error(
      `Local terminals need the node-pty native module (${(err as Error).message}). ` +
        'Try reinstalling dependencies (npm install).',
    );
  }
}

function defaultShell(): string {
  if (process.platform === 'win32') return process.env['COMSPEC'] ?? 'cmd.exe';
  return process.env['SHELL'] ?? '/bin/bash';
}

/** Adapts a node-pty process to the platform-neutral ShellChannel. */
class PtyChannel implements ShellChannel {
  constructor(private readonly pty: IPty) {}

  write(data: string): void {
    this.pty.write(data);
  }

  resize(size: TermSize): void {
    this.pty.resize(size.cols, size.rows);
  }

  close(): void {
    this.pty.kill();
  }

  onData(cb: (chunk: string) => void): void {
    this.pty.onData(cb);
  }

  onClose(cb: () => void): void {
    this.pty.onExit(() => cb());
  }
}

/**
 * SshTransport for the machine Pear itself runs on — no SSH at all. Shells
 * are local PTYs (node-pty), exec runs through the user's shell, and the
 * "remote" filesystem is just node:fs. Paths follow SFTP semantics: '~' and
 * relative paths resolve against the home directory.
 */
export class LocalConnection implements SshTransport {
  private connected = false;
  private readonly closeCbs: Array<() => void> = [];
  private readonly ptys = new Set<IPty>();

  async connect(): Promise<void> {
    this.connected = true;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  onClose(cb: () => void): void {
    this.closeCbs.push(cb);
  }

  async shell(size: TermSize): Promise<ShellChannel> {
    return this.spawnPty(defaultShell(), [], size);
  }

  async shellCommand(command: string, size: TermSize): Promise<ShellChannel> {
    const posix = process.platform !== 'win32';
    const shell = posix ? '/bin/sh' : (process.env['COMSPEC'] ?? 'cmd.exe');
    return this.spawnPty(shell, posix ? ['-c', command] : ['/c', command], size);
  }

  private spawnPty(file: string, args: string[], size: TermSize): ShellChannel {
    const pty = loadPty().spawn(file, args, {
      name: 'xterm-256color',
      cols: size.cols,
      rows: size.rows,
      cwd: homedir(),
      env: process.env as Record<string, string>,
    });
    this.ptys.add(pty);
    pty.onExit(() => this.ptys.delete(pty));
    return new PtyChannel(pty);
  }

  exec(command: string): Promise<ExecResult> {
    return new Promise((resolve, reject) => {
      const posix = process.platform !== 'win32';
      const shell = posix ? '/bin/sh' : (process.env['COMSPEC'] ?? 'cmd.exe');
      const child = spawn(shell, posix ? ['-c', command] : ['/c', command], {
        cwd: homedir(),
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
      child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
      child.on('error', reject);
      child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
    });
  }

  /** '~' and relative paths resolve against home, matching SFTP realpath. */
  private resolvePath(path: string): string {
    if (path === '~' || path === '') return homedir();
    if (path.startsWith('~/')) return join(homedir(), path.slice(2));
    if (!isAbsolute(path)) return join(homedir(), path);
    return path;
  }

  async listDir(path: string): Promise<DirListing> {
    const resolved = await fs.realpath(this.resolvePath(path));
    const names = await fs.readdir(resolved);
    const entries: FileEntry[] = [];
    for (const name of names) {
      try {
        const st = await fs.lstat(join(resolved, name));
        entries.push({
          name,
          kind: kindOf(st.mode),
          size: st.size,
          mtimeMs: st.mtimeMs,
          mode: modeString(st.mode),
        });
      } catch {
        // deleted between readdir and lstat — skip
      }
    }
    return { path: resolved, entries };
  }

  async readFile(path: string, maxBytes = 5 * 1024 * 1024): Promise<string> {
    const resolved = this.resolvePath(path);
    const stat = await fs.stat(resolved);
    if (stat.size > maxBytes) {
      throw new Error(`File is ${(stat.size / 1024 / 1024).toFixed(1)} MB — too large to edit`);
    }
    return fs.readFile(resolved, 'utf8');
  }

  async writeFile(path: string, content: string): Promise<void> {
    await fs.writeFile(this.resolvePath(path), content, 'utf8');
  }

  async upload(localPath: string, remoteDir: string): Promise<string> {
    const destDir = this.resolvePath(remoteDir);
    const dest = join(destDir, basename(localPath));
    await fs.copyFile(localPath, dest);
    return dest;
  }

  async stat(path: string): Promise<FileEntry | null> {
    const resolved = this.resolvePath(path);
    try {
      const st = await fs.lstat(resolved);
      return {
        name: basename(resolved),
        kind: kindOf(st.mode),
        size: st.size,
        mtimeMs: st.mtimeMs,
        mode: modeString(st.mode),
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async mkdir(path: string): Promise<void> {
    await fs.mkdir(this.resolvePath(path));
  }

  async remove(path: string, recursive = false): Promise<void> {
    const resolved = this.resolvePath(path);
    const st = await this.stat(resolved);
    if (!st) return;
    if (st.kind === 'dir') await fs.rm(resolved, { recursive });
    else await fs.rm(resolved);
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const from = this.resolvePath(oldPath);
    const to = this.resolvePath(newPath);
    try {
      await fs.rename(from, to);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
      await fs.cp(from, to, { recursive: true });
      await fs.rm(from, { recursive: true });
    }
  }

  async copy(src: string, dest: string): Promise<void> {
    await fs.cp(this.resolvePath(src), this.resolvePath(dest), { recursive: true });
  }

  async download(remotePath: string, localPath: string, opts?: TransferOpts): Promise<void> {
    await this.streamCopy(this.resolvePath(remotePath), localPath, opts);
  }

  async uploadFile(localPath: string, remotePath: string, opts?: TransferOpts): Promise<void> {
    await this.streamCopy(localPath, this.resolvePath(remotePath), opts);
  }

  private async streamCopy(from: string, to: string, opts?: TransferOpts): Promise<void> {
    const total = (await fs.stat(from)).size;
    await pipeline(
      createReadStream(from),
      byteCounter((bytes) => opts?.onProgress?.({ bytes, total })),
      createWriteStream(to),
      { signal: toAbortSignal(opts?.signal) },
    );
  }

  dispose(): void {
    if (!this.connected) return;
    this.connected = false;
    for (const pty of this.ptys) pty.kill();
    this.ptys.clear();
    for (const cb of this.closeCbs) cb();
  }
}
