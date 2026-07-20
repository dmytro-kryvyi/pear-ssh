import type { HostConfig, HostFacets, OrchAction, TermSize } from '../types';
import type { ShellChannel, SshTransport, SshTransportFactory, TransferOpts } from './transport';
import { SubHostTransport } from './subhost';
import { detectFacets, fetchOrchestration, performAction } from '../orchestration/orchestration';
import { uuid } from '../uuid';

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
    if (depth > 4) throw new Error('Host chain too deep or cyclic');

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
    } else if (config.via) {
      const jumpCfg = this.resolveHost?.(config.via);
      if (!jumpCfg) throw new Error('Jump host not found — was it removed?');
      // Unlike sub-hosts, a via-host authenticates itself end-to-end; any
      // password on its connect card is its own, never the jump host's.
      const jump = await this.connection(jumpCfg, depth + 1);
      conn = this.createTransport(config, jump);
    } else {
      conn = this.createTransport(config);
    }
    await conn.connect();
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

  async openTerminal(config: HostConfig, size: TermSize): Promise<TerminalHandle> {
    const conn = await this.connection(config);
    const channel = await conn.shell(size);
    const id = uuid();
    this.terminals.set(id, { id, hostId: config.id, channel });

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

  disconnectHost(hostId: string): void {
    this.connections.get(hostId)?.dispose();
  }

  disposeAll(): void {
    for (const conn of this.connections.values()) conn.dispose();
    this.connections.clear();
    this.terminals.clear();
  }
}
