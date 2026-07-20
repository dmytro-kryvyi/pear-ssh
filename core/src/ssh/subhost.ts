import type { DirListing, FileEntry, SubHostTarget, TermSize } from '../types';
import type { ExecResult, ShellChannel, SshTransport, TransferOpts } from './transport';
import { kindOf, modeString } from './mode';
import { shq } from '../shq';
import { uuid } from '../uuid';

// A sub-host is a container reachable only through its parent host: a Docker
// container (entered with `docker exec`) or a Proxmox LXC CT (`pct exec` /
// `pct enter`, run on the PVE node). QEMU VMs are not sub-hosts — they have no
// exec tunnel; they get a serial console or are promoted to real SSH hosts.

/** Non-interactive command inside the target, to be run on the parent. */
export function subExec(target: SubHostTarget, command: string): string {
  return target.type === 'docker'
    ? `docker exec ${shq(target.ref)} /bin/sh -c ${shq(command)}`
    : `pct exec ${shq(target.ref)} -- /bin/sh -c ${shq(command)}`;
}

/** Interactive shell inside the target (run on the parent in a PTY). */
export function subShellCommand(target: SubHostTarget): string {
  return target.type === 'docker'
    ? `docker exec -it -e TERM=xterm-256color ${shq(target.ref)} ` +
        `/bin/sh -c 'command -v bash >/dev/null 2>&1 && exec bash -l; exec sh -l'`
    : `pct enter ${shq(target.ref)}`;
}

/** One round trip: confirms the target is running and has a shell. */
export function probeCommand(target: SubHostTarget): string {
  return subExec(target, 'whoami 2>/dev/null || id -un 2>/dev/null || echo root');
}

/** Translate docker/pct stderr into a message a user can act on. */
export function probeError(target: SubHostTarget, result: ExecResult): string {
  const err = result.stderr.trim();
  // Some runtimes/shims report exec failures on stdout — match against both,
  // but keep display text to stderr (stdout may hold unrelated chatter).
  const text = err || result.stdout.trim();
  const label = target.type === 'docker' ? `Container '${target.ref}'` : `CT ${target.ref}`;
  if (/no such container/i.test(text)) return `${label} not found`;
  if (/configuration file .* does not exist/i.test(text)) return `${label} not found`;
  if (/is not running|not running/i.test(text)) return `${label} is not running`;
  // Exec-into-image failures across runtime generations: classic runc prefixes
  // "OCI runtime exec failed"; newer containerd/crun drop it and say only
  // 'exec: "/bin/sh": stat /bin/sh: no such file or directory' or
  // 'not found in $PATH'.
  if (
    /executable file not found|OCI runtime exec failed|not found in \$PATH|exec.*no such file or directory/i.test(
      text,
    )
  ) {
    return `${label} has no shell (distroless image?)`;
  }
  if (/(docker|pct): (command )?not found|command not found: (docker|pct)/i.test(text)) {
    return `${target.type === 'docker' ? 'docker' : 'pct'} not available on the parent host`;
  }
  // A silent 126/127 is the shell convention for "cannot exec" — with docker
  // and the container confirmed present, that means no shell in the image.
  if (!err && (result.code === 126 || result.code === 127)) {
    return `${label} has no shell to enter (distroless image?) — exit ${result.code}`;
  }
  return `Cannot enter ${label}: ${err || `exit ${result.code}`}`;
}

/**
 * Parse the `pwd` + per-entry `stat -c '%f %s %Y %n'` output of the sub-host
 * listing command. First line is the resolved directory; each following line
 * is "<hex st_mode> <size> <mtime> <name>". Names may contain spaces (the
 * name is everything after the third field); names with newlines are a
 * documented limitation of the exec-based listing.
 */
export function parseStatListing(stdout: string): DirListing {
  const lines = stdout.split('\n');
  const path = (lines[0] ?? '').trim() || '/';
  const entries: FileEntry[] = [];
  for (const line of lines.slice(1)) {
    const m = line.match(/^([0-9a-fA-F]+) (\d+) (\d+) (.+)$/);
    if (!m) continue;
    const mode = parseInt(m[1], 16);
    entries.push({
      name: m[4],
      kind: kindOf(mode),
      size: Number(m[2]),
      mtimeMs: Number(m[3]) * 1000,
      mode: modeString(mode),
    });
  }
  return { path, entries };
}

function must(result: ExecResult, what: string): string {
  if (result.code !== 0) {
    throw new Error(`${what} failed: ${result.stderr.trim() || `exit ${result.code}`}`);
  }
  return result.stdout;
}

/** Last path segment, without pulling in node:path (this layer is pure). */
function basenameOf(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  return trimmed.slice(trimmed.lastIndexOf('/') + 1);
}

/**
 * An SshTransport that lives *inside* a container on another host: every
 * operation is rewritten to run through the parent transport. Shells run in a
 * parent-side PTY (`docker exec -it` / `pct enter`), file content moves via
 * the parent's SFTP plus `docker cp` / `pct pull|push` staging through the
 * parent's /tmp (binary-safe, no ARG_MAX limits), and directory listings are
 * parsed from an in-container `stat` loop. Because shellCommand re-wraps too,
 * sub-hosts nest (docker inside an LXC CT).
 */
export class SubHostTransport implements SshTransport {
  private connected = false;
  private closedCbs: (() => void)[] = [];
  private channels = new Set<ShellChannel>();

  constructor(
    private readonly parent: SshTransport,
    private readonly target: SubHostTarget,
  ) {
    parent.onClose(() => this.teardown());
  }

  get isConnected(): boolean {
    return this.connected && this.parent.isConnected;
  }

  async connect(): Promise<void> {
    const result = await this.parent.exec(probeCommand(this.target));
    if (result.code !== 0) throw new Error(probeError(this.target, result));
    this.connected = true;
  }

  onClose(cb: () => void): void {
    this.closedCbs.push(cb);
  }

  /** Detach from the target. The parent connection is never touched. */
  dispose(): void {
    this.teardown();
  }

  private teardown(): void {
    if (!this.connected) return;
    this.connected = false;
    for (const ch of this.channels) ch.close();
    this.channels.clear();
    for (const cb of this.closedCbs) cb();
  }

  async shell(size: TermSize): Promise<ShellChannel> {
    return this.track(await this.parent.shellCommand(subShellCommand(this.target), size));
  }

  async shellCommand(command: string, size: TermSize): Promise<ShellChannel> {
    return this.track(await this.parent.shellCommand(subExecPty(this.target, command), size));
  }

  private track(channel: ShellChannel): ShellChannel {
    this.channels.add(channel);
    channel.onClose(() => this.channels.delete(channel));
    return channel;
  }

  exec(command: string): Promise<ExecResult> {
    return this.parent.exec(subExec(this.target, command));
  }

  async listDir(path: string): Promise<DirListing> {
    const enter =
      path === '~' || path === '' ? 'cd 2>/dev/null || cd /' : `cd -- ${shq(path)}`;
    const cmd =
      `${enter} && pwd && ls -A | while IFS= read -r f; do stat -c '%f %s %Y %n' -- "$f"; done`;
    const result = await this.exec(cmd);
    if (result.code !== 0) {
      const err = result.stderr.trim();
      if (/stat: (command )?not found|applet not found/i.test(err)) {
        throw new Error('Container lacks basic shell utilities (stat)');
      }
      throw new Error(err || `listing failed: exit ${result.code}`);
    }
    return parseStatListing(result.stdout);
  }

  async readFile(path: string, maxBytes = 5 * 1024 * 1024): Promise<string> {
    const size = Number(must(await this.exec(`stat -c %s -- ${shq(path)}`), 'stat').trim());
    if (size > maxBytes) {
      throw new Error(`File is ${(size / 1024 / 1024).toFixed(1)} MB — too large to edit`);
    }
    return this.staged((tmp) => this.pull(path, tmp).then(() => this.parent.readFile(tmp)));
  }

  async writeFile(path: string, content: string): Promise<void> {
    await this.staged(async (tmp) => {
      await this.parent.writeFile(tmp, content);
      await this.push(tmp, path);
    });
  }

  async upload(localPath: string, remoteDir: string): Promise<string> {
    const tmp = await this.parent.upload(localPath, '/tmp');
    try {
      const dest = `${remoteDir.replace(/\/$/, '')}/${basenameOf(tmp)}`;
      await this.push(tmp, dest);
      return dest;
    } finally {
      await this.parent.exec(`rm -f ${shq(tmp)}`);
    }
  }

  async stat(path: string): Promise<FileEntry | null> {
    const result = await this.exec(`stat -c '%f %s %Y' -- ${shq(path)}`);
    if (result.code !== 0) return null;
    const m = result.stdout.trim().match(/^([0-9a-fA-F]+) (\d+) (\d+)$/);
    if (!m) return null;
    const mode = parseInt(m[1], 16);
    return {
      name: basenameOf(path),
      kind: kindOf(mode),
      size: Number(m[2]),
      mtimeMs: Number(m[3]) * 1000,
      mode: modeString(mode),
    };
  }

  async mkdir(path: string): Promise<void> {
    must(await this.exec(`mkdir -p -- ${shq(path)}`), 'mkdir');
  }

  async remove(path: string, recursive = false): Promise<void> {
    if (recursive) {
      must(await this.exec(`rm -rf -- ${shq(path)}`), 'delete');
      return;
    }
    const entry = await this.stat(path);
    if (!entry) return;
    const cmd = entry.kind === 'dir' ? `rmdir -- ${shq(path)}` : `rm -f -- ${shq(path)}`;
    must(await this.exec(cmd), 'delete');
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    must(await this.exec(`mv -f -- ${shq(oldPath)} ${shq(newPath)}`), 'move');
  }

  async copy(src: string, dest: string): Promise<void> {
    must(await this.exec(`cp -a -- ${shq(src)} ${shq(dest)}`), 'copy');
  }

  /**
   * Byte progress covers only the parent→Pear SFTP leg (the network-dominant
   * one); the container-side docker cp / pct pull is a single opaque step.
   */
  async download(remotePath: string, localPath: string, opts?: TransferOpts): Promise<void> {
    await this.staged(async (tmp) => {
      await this.pull(remotePath, tmp);
      await this.parent.download(tmp, localPath, opts);
    });
  }

  async uploadFile(localPath: string, remotePath: string, opts?: TransferOpts): Promise<void> {
    await this.staged(async (tmp) => {
      await this.parent.uploadFile(localPath, tmp, opts);
      await this.push(tmp, remotePath);
    });
  }

  /** Run `fn` with a fresh staging path in the parent's /tmp, always cleaned. */
  private async staged<T>(fn: (tmp: string) => Promise<T>): Promise<T> {
    const tmp = `/tmp/.pear-${uuid()}`;
    try {
      return await fn(tmp);
    } finally {
      await this.parent.exec(`rm -f ${shq(tmp)}`);
    }
  }

  /** Copy target:path -> parent tmp. */
  private async pull(path: string, tmp: string): Promise<void> {
    const cmd =
      this.target.type === 'docker'
        ? `docker cp ${shq(`${this.target.ref}:${path}`)} ${shq(tmp)}`
        : `pct pull ${shq(this.target.ref)} ${shq(path)} ${shq(tmp)}`;
    must(await this.parent.exec(cmd), 'copy out of container');
  }

  /** Copy parent tmp -> target:path. */
  private async push(tmp: string, path: string): Promise<void> {
    const cmd =
      this.target.type === 'docker'
        ? `docker cp ${shq(tmp)} ${shq(`${this.target.ref}:${path}`)}`
        : `pct push ${shq(this.target.ref)} ${shq(tmp)} ${shq(path)}`;
    must(await this.parent.exec(cmd), 'copy into container');
  }
}

/** Interactive (PTY) variant of subExec, for shellCommand nesting. */
function subExecPty(target: SubHostTarget, command: string): string {
  return target.type === 'docker'
    ? `docker exec -it -e TERM=xterm-256color ${shq(target.ref)} /bin/sh -c ${shq(command)}`
    : `pct exec ${shq(target.ref)} -- /bin/sh -c ${shq(command)}`;
}
