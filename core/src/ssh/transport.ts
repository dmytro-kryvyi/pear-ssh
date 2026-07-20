import type { DirListing, FileEntry, HostConfig, TermSize } from '../types';

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * An interactive PTY channel. `onData` carries stdout and stderr merged —
 * a terminal renders both into the same stream anyway.
 */
export interface ShellChannel {
  write(data: string): void;
  resize(size: TermSize): void;
  close(): void;
  onData(cb: (chunk: string) => void): void;
  onClose(cb: () => void): void;
}

export interface TransferProgress {
  bytes: number;
  total: number;
}

/**
 * Structural stand-in for AbortSignal: the pure layer compiles without DOM or
 * Node ambient types, while real AbortSignals from either satisfy it.
 */
export interface AbortSignalLike {
  readonly aborted: boolean;
  addEventListener(type: 'abort', listener: () => void): void;
  removeEventListener(type: 'abort', listener: () => void): void;
}

export interface TransferOpts {
  onProgress?: (p: TransferProgress) => void;
  signal?: AbortSignalLike;
}

/**
 * One authenticated connection to a host, with shell/exec/SFTP multiplexed
 * over it. Implemented by ssh2 on Node (`@pear/core/node`) and, in future, by
 * a native SSH plugin on Android — SessionManager and everything above it are
 * written against this interface alone.
 */
export interface SshTransport {
  readonly isConnected: boolean;
  connect(): Promise<void>;
  onClose(cb: () => void): void;
  shell(size: TermSize): Promise<ShellChannel>;
  /**
   * Run a specific command in a fresh PTY — like shell(), but running the
   * given command instead of the login shell. The channel closes when the
   * command exits.
   */
  shellCommand(command: string, size: TermSize): Promise<ShellChannel>;
  exec(command: string): Promise<ExecResult>;
  listDir(path: string): Promise<DirListing>;
  readFile(path: string, maxBytes?: number): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  upload(localPath: string, remoteDir: string): Promise<string>;
  /** lstat of a single path; null when it does not exist. */
  stat(path: string): Promise<FileEntry | null>;
  /** Create a directory (parents included where the backend allows). */
  mkdir(path: string): Promise<void>;
  /** Delete a path; directories require `recursive` unless empty. */
  remove(path: string, recursive?: boolean): Promise<void>;
  /** Same-host move. Overwrites an existing destination. */
  rename(oldPath: string, newPath: string): Promise<void>;
  /** Same-host recursive copy, attributes preserved. */
  copy(src: string, dest: string): Promise<void>;
  /** Stream a remote file to a path on the Pear machine. */
  download(remotePath: string, localPath: string, opts?: TransferOpts): Promise<void>;
  /** Stream a Pear-machine file to an exact remote path. */
  uploadFile(localPath: string, remotePath: string, opts?: TransferOpts): Promise<void>;
  dispose(): void;
}

/**
 * Constructs (but does not connect) a transport for a host. When the config
 * has `via`, the already-connected jump transport is passed so the
 * implementation can tunnel through it (ProxyJump).
 */
export type SshTransportFactory = (config: HostConfig, jump?: SshTransport) => SshTransport;
