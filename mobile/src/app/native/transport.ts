import type {
  DirListing,
  ExecResult,
  FileEntry,
  HostAuth,
  HostConfig,
  ShellChannel,
  SshTransport,
  TermSize,
} from '@pear/core';
import type { SshEventHub } from './event-hub';
import type { PearSshPlugin, SshAuthSpec, SshConnectSpec } from './pear-ssh';

/** What the TOFU sheet shows; `knownFingerprint` set = key CHANGED (danger). */
export interface HostKeyPrompt {
  host: string;
  port: number;
  keyType: string;
  fingerprint: string;
  knownFingerprint?: string;
}

/** UI hook that answers host-key prompts. Resolve true to trust. */
export interface HostKeyGate {
  confirm(prompt: HostKeyPrompt): Promise<boolean>;
}

export interface TransportDeps {
  plugin: PearSshPlugin;
  hub: SshEventHub;
  gate: HostKeyGate;
}

/** Capacitor bridge rejections carry the SshError code + details. */
function codeOf(e: unknown): string | undefined {
  return (e as { code?: string })?.code;
}

function dataOf(e: unknown): Record<string, string> {
  const raw = (e as { data?: Record<string, string> })?.data ?? (e as Record<string, string>);
  return typeof raw === 'object' && raw !== null ? raw : {};
}

function toError(e: unknown): Error {
  if (e instanceof Error) return e;
  const message = (e as { message?: string })?.message;
  return new Error(message ?? String(e));
}

/**
 * Map core HostAuth (already decrypted by the host store) onto the plugin's
 * AuthSpec. Android has no ssh-agent and no ~/.ssh, so the legacy heuristic
 * chain reduces to: explicit method, else key text, else password.
 */
export function toAuthSpec(auth: HostAuth | undefined): SshAuthSpec {
  const a = auth ?? {};
  if (a.method === 'agent') {
    throw new Error('SSH agent auth is not available on Android — use a key or password');
  }
  if (a.method === 'password') return { method: 'password', password: a.password };
  if (a.method === 'key' || a.privateKey || !a.password) {
    return { method: 'key', privateKey: a.privateKey, passphrase: a.passphrase };
  }
  return { method: 'password', password: a.password };
}

/** ShellChannel over one plugin PTY channel, events routed via the hub. */
class CapShellChannel implements ShellChannel {
  private readonly dataCbs: ((chunk: string) => void)[] = [];
  private readonly closeCbs: (() => void)[] = [];
  /** Chunks that arrive before the first onData registration. */
  private early: string[] | null = [];
  private earlyExit = false;

  constructor(
    private readonly channelId: string,
    private readonly deps: TransportDeps,
  ) {
    deps.hub.bindChannel(
      channelId,
      (chunk) => {
        if (this.early) this.early.push(chunk);
        else for (const cb of this.dataCbs) cb(chunk);
      },
      () => {
        if (this.early) this.earlyExit = true;
        else for (const cb of this.closeCbs) cb();
      },
    );
  }

  write(data: string): void {
    void this.deps.plugin.shellWrite({ channelId: this.channelId, data });
  }

  resize(size: TermSize): void {
    void this.deps.plugin.shellResize({
      channelId: this.channelId,
      cols: size.cols,
      rows: size.rows,
    });
  }

  close(): void {
    void this.deps.plugin.shellClose({ channelId: this.channelId });
  }

  onData(cb: (chunk: string) => void): void {
    this.dataCbs.push(cb);
    if (this.early) {
      const buffered = this.early;
      this.early = null;
      for (const chunk of buffered) for (const dataCb of this.dataCbs) dataCb(chunk);
      if (this.earlyExit) for (const closeCb of this.closeCbs) closeCb();
    }
  }

  onClose(cb: () => void): void {
    this.closeCbs.push(cb);
  }
}

/**
 * SshTransport over the PearSsh Capacitor plugin — the Android counterpart
 * of the desktop's ssh2 SshConnection. One instance = one endpoint dial
 * (SessionManager.dialEndpoints owns failover). Handles the TOFU dance:
 * UNKNOWN_HOST_KEY / HOST_KEY_CHANGED rejections route through the
 * HostKeyGate (UI sheet) and retry with the confirmed fingerprint.
 *
 * `jump` (via/ProxyJump) is not supported until M5 — the plugin dials
 * directly.
 */
export class CapacitorSshTransport implements SshTransport {
  private sessionId?: string;
  private connected = false;
  private readonly closeCbs: (() => void)[] = [];

  constructor(
    readonly config: HostConfig,
    private readonly deps: TransportDeps,
    jump?: SshTransport,
  ) {
    if (jump) throw new Error('via/jump hosts are not supported on Android yet (M5)');
  }

  async connect(): Promise<void> {
    const cfg = this.config;
    const spec: SshConnectSpec = {
      host: cfg.host,
      port: cfg.port,
      user: cfg.user,
      auth: toAuthSpec(cfg.auth),
      timeoutMs: cfg.readyTimeoutMs ?? 15_000,
    };
    try {
      await this.dial(spec);
    } catch (e) {
      const code = codeOf(e);
      if (code !== 'UNKNOWN_HOST_KEY' && code !== 'HOST_KEY_CHANGED') throw toError(e);
      const details = dataOf(e);
      const changed = code === 'HOST_KEY_CHANGED';
      const trusted = await this.deps.gate.confirm({
        host: cfg.host,
        port: cfg.port,
        keyType: details['keyType'] ?? '',
        fingerprint: details['fingerprint'] ?? '',
        knownFingerprint: changed ? (details['knownFingerprint'] ?? '') : undefined,
      });
      if (!trusted) throw new Error(`Host key for ${cfg.host} was not trusted`);
      if (changed) {
        await this.deps.plugin.forgetHostKey({ host: cfg.host, port: cfg.port });
      }
      await this.dial({ ...spec, trustFingerprint: details['fingerprint'] });
    }
    const sessionId = this.sessionId!;
    this.connected = true;
    this.deps.hub.bindSession(sessionId, () => {
      this.connected = false;
      for (const cb of this.closeCbs) cb();
    });
  }

  private async dial(spec: SshConnectSpec): Promise<void> {
    try {
      const { sessionId } = await this.deps.plugin.connect(spec);
      this.sessionId = sessionId;
    } catch (e) {
      throw codeOf(e) ? e : toError(e);
    }
  }

  get isConnected(): boolean {
    return this.connected;
  }

  onClose(cb: () => void): void {
    this.closeCbs.push(cb);
  }

  private get session(): string {
    if (!this.sessionId || !this.connected) throw new Error('Not connected');
    return this.sessionId;
  }

  async shell(size: TermSize): Promise<ShellChannel> {
    const { channelId } = await this.deps.plugin.shellOpen({
      sessionId: this.session,
      cols: size.cols,
      rows: size.rows,
    });
    return new CapShellChannel(channelId, this.deps);
  }

  async shellCommand(command: string, size: TermSize): Promise<ShellChannel> {
    const { channelId } = await this.deps.plugin.shellOpen({
      sessionId: this.session,
      command,
      cols: size.cols,
      rows: size.rows,
    });
    return new CapShellChannel(channelId, this.deps);
  }

  async exec(command: string): Promise<ExecResult> {
    return this.deps.plugin.exec({ sessionId: this.session, command });
  }

  async listDir(path: string): Promise<DirListing> {
    const result = await this.deps.plugin.sftpList({ sessionId: this.session, path });
    return { path: result.path, entries: result.entries as FileEntry[] };
  }

  async readFile(path: string, maxBytes?: number): Promise<string> {
    const { content } = await this.deps.plugin.sftpRead({
      sessionId: this.session,
      path,
      maxBytes,
    });
    return content;
  }

  async writeFile(path: string, content: string): Promise<void> {
    await this.deps.plugin.sftpWrite({ sessionId: this.session, path, content });
  }

  async stat(path: string): Promise<FileEntry | null> {
    const result = await this.deps.plugin.sftpStat({ sessionId: this.session, path });
    return result.exists ? ((result.entry ?? null) as FileEntry | null) : null;
  }

  async mkdir(path: string): Promise<void> {
    await this.deps.plugin.sftpMkdir({ sessionId: this.session, path });
  }

  async remove(path: string, recursive?: boolean): Promise<void> {
    await this.deps.plugin.sftpRemove({ sessionId: this.session, path, recursive });
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    await this.deps.plugin.sftpRename({ sessionId: this.session, oldPath, newPath });
  }

  async copy(src: string, dest: string): Promise<void> {
    await this.deps.plugin.sftpCopy({ sessionId: this.session, src, dest });
  }

  async hash(path: string): Promise<string> {
    const { hash } = await this.deps.plugin.sftpHash({ sessionId: this.session, path });
    return hash;
  }

  async upload(): Promise<string> {
    throw new Error('File transfers arrive in M6');
  }

  async download(): Promise<void> {
    throw new Error('File transfers arrive in M6');
  }

  async uploadFile(): Promise<void> {
    throw new Error('File transfers arrive in M6');
  }

  dispose(): void {
    const id = this.sessionId;
    this.connected = false;
    if (id) {
      this.deps.hub.unbindSession(id);
      void this.deps.plugin.disconnect({ sessionId: id });
    }
  }
}
