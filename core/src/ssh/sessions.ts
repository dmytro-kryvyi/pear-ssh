import { HostKeyError } from './known-hosts';
import type { HostConfig, HostFacets, OrchAction, TermSize } from '../types';
import type { ShellChannel, SshTransport, SshTransportFactory, TransferOpts } from './transport';
import { SubHostTransport } from './subhost';
import {
  detectFacets,
  fetchOrchestration,
  fetchStats,
  performAction,
} from '../orchestration/orchestration';
import { fetchServiceTasks, fetchTaskLogs, type TaskLogsOptions } from '../orchestration/tasks';
import { fetchVitals } from '../monitor/vitals';
import { fetchDockerDf } from '../monitor/docker-df';
import { uuid } from '../uuid';
import { shq } from '../shq';

export interface TerminalHandle {
  id: string;
  hostId: string;
}

interface TerminalSession {
  id: string;
  hostId: string;
  channel: ShellChannel;
}

/**
 * Owns SSH connections (one per host) and the terminal channels on top of
 * them. Emits terminal output/exit through the callbacks given at
 * construction — the embedder decides how to transport them (IPC, WebSocket)
 * and which SshTransport implementation to build them on.
 */
export class SessionManager {
  private connections = new Map<string, SshTransport>();
  private terminals = new Map<string, TerminalSession>();
  private dialing = new Map<string, Promise<SshTransport>>();
  /** Bumped by disposeAll so dials that were in flight across it don't leak. */
  private epoch = 0;

  constructor(
    private readonly events: {
      onTermData: (termId: string, data: string) => void;
      onTermExit: (termId: string) => void;
      onHostDisconnected: (hostId: string) => void;
    },
    private readonly createTransport: SshTransportFactory,
    /** Looks up host configs by id — needed to resolve sub-host parents. */
    private readonly resolveHost?: (id: string) => HostConfig | undefined,
  ) {}

  async connection(config: HostConfig, depth = 0): Promise<SshTransport> {
    const existing = this.connections.get(config.id);
    if (existing?.isConnected) return existing;
    // A UI connecting to a host fires several calls at once (files, orch,
    // vitals). Without this each would dial its own connection — multiplying
    // auth attempts, and leaking every connection but the last one stored.
    // Keyed by credentials too: a retry with a freshly typed password must
    // not ride along on a dial that is already failing without it.
    const key = `${config.id}\0${config.auth?.password ?? ''}`;
    const inFlight = this.dialing.get(key);
    if (inFlight) return inFlight;
    const dial = this.connect(config, depth).finally(() => this.dialing.delete(key));
    this.dialing.set(key, dial);
    return dial;
  }

  private async connect(config: HostConfig, depth: number): Promise<SshTransport> {
    if (depth > 4) throw new Error('Host chain too deep or cyclic');

    const epoch = this.epoch;
    let conn: SshTransport;
    if (config.parentId && config.target) {
      const parentCfg = this.resolveHost?.(config.parentId);
      if (!parentCfg) throw new Error('Parent host not found — was it removed?');
      // A password typed on the sub-host's connect card authenticates the
      // parent (the sub-host itself has no auth of its own).
      const parentConnected = this.connections.get(parentCfg.id)?.isConnected ?? false;
      const effective =
        config.auth?.password && !parentConnected
          ? { ...parentCfg, auth: { ...parentCfg.auth, password: config.auth.password } }
          : parentCfg;
      const parent = await this.connection(effective, depth + 1);
      conn = new SubHostTransport(parent, config.target);
      await conn.connect();
    } else if (config.via) {
      const jumpCfg = this.resolveHost?.(config.via);
      if (!jumpCfg) throw new Error('Jump host not found — was it removed?');
      // Unlike sub-hosts, a via-host authenticates itself end-to-end; any
      // password on its connect card is its own, never the jump host's.
      const jump = await this.connection(jumpCfg, depth + 1);
      conn = await this.dialEndpoints(config, jump);
    } else {
      conn = await this.dialEndpoints(config);
    }
    if (epoch !== this.epoch) {
      // disposeAll ran while we were dialing: nobody will ever dispose this
      // connection, so it must not outlive the call.
      conn.dispose();
      throw new Error('Connection cancelled: sessions were shut down');
    }
    conn.onClose(() => {
      this.connections.delete(config.id);
      for (const [id, t] of this.terminals) {
        if (t.hostId === config.id) {
          this.terminals.delete(id);
          this.events.onTermExit(id);
        }
      }
      this.events.onHostDisconnected(config.id);
    });
    this.connections.set(config.id, conn);
    return conn;
  }

  /**
   * Dial a host's endpoints in order and keep the first that answers.
   * Sequential on purpose: parallel dialing multiplies auth attempts
   * (fail2ban counters, hardware-key touch prompts). Non-final endpoints get
   * a short budget so a dead first address doesn't stall the whole connect.
   */
  private async dialEndpoints(config: HostConfig, jump?: SshTransport): Promise<SshTransport> {
    const endpoints = config.endpoints?.length
      ? config.endpoints
      : [{ id: 'primary', addr: config.host, port: config.port }];
    const failures: string[] = [];
    let lastError: unknown;
    for (let i = 0; i < endpoints.length; i++) {
      const ep = endpoints[i];
      const isLast = i === endpoints.length - 1;
      const effective: HostConfig = {
        ...config,
        host: ep.addr,
        port: ep.port,
        readyTimeoutMs: config.readyTimeoutMs ?? (isLast ? 15_000 : 5_000),
      };
      const conn = this.createTransport(effective, jump);
      try {
        await conn.connect();
        return conn;
      } catch (err) {
        conn.dispose();
        // The endpoint answered — it just isn't (yet) trusted. That is a
        // question for the user, not a reason to try the next address.
        if (err instanceof HostKeyError) throw err;
        lastError = err;
        const label = ep.label ? `${ep.label} (${ep.addr}:${ep.port})` : `${ep.addr}:${ep.port}`;
        failures.push(`${label} — ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // A single address keeps its raw error; multiple get the aggregate.
    if (endpoints.length === 1) throw lastError;
    throw new Error('All endpoints failed:\n' + failures.join('\n'));
  }

  async openTerminal(
    config: HostConfig,
    size: TermSize,
    opts?: { cwd?: string },
  ): Promise<TerminalHandle> {
    const conn = await this.connection(config);
    const channel = await conn.shell(size);
    const id = uuid();
    this.terminals.set(id, { id, hostId: config.id, channel });
    const bootstrap = terminalBootstrap(config, opts?.cwd);
    if (bootstrap) channel.write(bootstrap + '\n');

    channel.onData((chunk) => this.events.onTermData(id, chunk));
    channel.onClose(() => {
      if (this.terminals.delete(id)) this.events.onTermExit(id);
    });

    return { id, hostId: config.id };
  }

  writeTerminal(termId: string, data: string): void {
    this.terminals.get(termId)?.channel.write(data);
  }

  resizeTerminal(termId: string, size: TermSize): void {
    this.terminals.get(termId)?.channel.resize(size);
  }

  closeTerminal(termId: string): void {
    this.terminals.get(termId)?.channel.close();
  }

  async exec(config: HostConfig, command: string) {
    const conn = await this.connection(config);
    return conn.exec(command);
  }

  async listDir(config: HostConfig, path: string) {
    const conn = await this.connection(config);
    return conn.listDir(path);
  }

  async readFile(config: HostConfig, path: string, maxBytes?: number) {
    const conn = await this.connection(config);
    return conn.readFile(path, maxBytes);
  }

  async writeFile(config: HostConfig, path: string, content: string) {
    const conn = await this.connection(config);
    return conn.writeFile(path, content);
  }

  async upload(config: HostConfig, localPath: string, remoteDir: string) {
    const conn = await this.connection(config);
    return conn.upload(localPath, remoteDir);
  }

  async stat(config: HostConfig, path: string) {
    const conn = await this.connection(config);
    return conn.stat(path);
  }

  async mkdir(config: HostConfig, path: string) {
    const conn = await this.connection(config);
    return conn.mkdir(path);
  }

  async remove(config: HostConfig, path: string, recursive?: boolean) {
    const conn = await this.connection(config);
    return conn.remove(path, recursive);
  }

  async rename(config: HostConfig, oldPath: string, newPath: string) {
    const conn = await this.connection(config);
    return conn.rename(oldPath, newPath);
  }

  async copy(config: HostConfig, src: string, dest: string) {
    const conn = await this.connection(config);
    return conn.copy(src, dest);
  }

  async download(config: HostConfig, remotePath: string, localPath: string, opts?: TransferOpts) {
    const conn = await this.connection(config);
    return conn.download(remotePath, localPath, opts);
  }

  async uploadFile(config: HostConfig, localPath: string, remotePath: string, opts?: TransferOpts) {
    const conn = await this.connection(config);
    return conn.uploadFile(localPath, remotePath, opts);
  }

  private execBinder(config: HostConfig) {
    return (command: string) => this.exec(config, command);
  }

  detectOrchFacets(config: HostConfig): Promise<HostFacets> {
    return detectFacets(this.execBinder(config));
  }

  orchestration(config: HostConfig, facets: HostFacets) {
    return fetchOrchestration(this.execBinder(config), facets);
  }

  orchAction(config: HostConfig, action: OrchAction) {
    return performAction(this.execBinder(config), action);
  }

  serviceTasks(config: HostConfig, service: string) {
    return fetchServiceTasks(this.execBinder(config), service);
  }

  taskLogs(config: HostConfig, taskId: string, opts?: TaskLogsOptions) {
    return fetchTaskLogs(this.execBinder(config), taskId, opts);
  }

  vitals(config: HostConfig) {
    return fetchVitals(this.execBinder(config));
  }

  dockerDf(config: HostConfig) {
    return fetchDockerDf(this.execBinder(config));
  }

  containerStats(config: HostConfig) {
    return fetchStats(this.execBinder(config));
  }

  isConnected(hostId: string): boolean {
    return this.connections.get(hostId)?.isConnected ?? false;
  }

  disconnectHost(hostId: string): void {
    this.connections.get(hostId)?.dispose();
  }

  disposeAll(): void {
    this.epoch++;
    for (const conn of this.connections.values()) conn.dispose();
    this.connections.clear();
    this.terminals.clear();
  }
}

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The single line written into every new terminal for a host: exported env,
 * cd to the working directory, then the startup commands in order. Written
 * into the PTY (visible and transparent) rather than sent as ssh2 env, which
 * sshds silently drop unless AcceptEnv allows each name.
 */
export function terminalBootstrap(config: HostConfig, cwdOverride?: string): string {
  const parts: string[] = [];
  const env = (config.env ?? []).filter((e) => ENV_KEY.test(e.k));
  if (env.length) parts.push('export ' + env.map((e) => `${e.k}=${shq(e.v)}`).join(' '));
  const cwd = cwdOverride ?? config.cwd;
  if (cwd) parts.push(`cd ${shq(cwd)}`);
  parts.push(...(config.startup ?? []).map((c) => c.trim()).filter(Boolean));
  return parts.join('; ');
}
