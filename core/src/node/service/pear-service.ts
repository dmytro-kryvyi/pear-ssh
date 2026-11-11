import { hostname, userInfo } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { ClaudeFocus, ClaudeUiRequestPayload, ClaudeUiResponse } from '../../claude/events';
import type { PermissionAnswer } from '../../claude/permission-bridge';
import { HistoryStore } from '../../history/store';
import { importShellHistory } from '../../history/import';
import { EphemeralHostRegistry } from '../../hosts/ephemeral';
import { HostGroupStore } from '../../hosts/groups';
import { HostStore, sanitizeHost, type SecretCipher } from '../../hosts/store';
import { parseGuestIp } from '../../orchestration/guest-ip';
import { primaryKind } from '../../orchestration/orchestration';
import { FsOpsRunner } from '../../fs/ops-runner';
import { planCompress, planExtract } from '../../fs/archive-ops';
import type { ArchiveFormat, ArchiveTools } from '../../fs/archive';
import type { PermsChange } from '../../fs/perms';
import { channelsOf } from '../../rpc/channels';
import { KnownHosts, type HostKeyPrompt } from '../../ssh/known-hosts';
import { SessionManager } from '../../ssh/sessions';
import { probeCommand, probeError } from '../../ssh/subhost';
import { PASSTHROUGH_POLICY, TerminalHub, type TermPolicy } from '../../ssh/term-hub';
import {
  TransferEngine,
  type ConflictPolicy,
  type TransferEndpoint,
  type TransferRequest,
} from '../../transfers/engine';
import type { HostConfig, HostGroup, OrchAction, SubHostTarget, TermSize } from '../../types';
import { uuid } from '../../uuid';
import { ClaudeChatRuntime } from '../claude/chat-runtime';
import { ClaudeExecutor } from '../claude/executor';
import { PearMcpServer } from '../claude/mcp-server';
import { claudeInstalled, launchClaudePty } from '../claude/pty';
import { provisionClaudeWorkspace } from '../claude/workspace';
import { SshConnection } from '../connection';
import { JsonFileStorage } from '../json-storage';
import { LocalConnection } from '../local';
import { PortForwardManager } from '../port-forward';
import { probeSsh } from '../probe';
import { loadSshConfigEntries } from '../ssh-config-file';
import { makeStagingDir, removeStaging, sweepStaging } from '../staging';
import { nodeTarIo } from '../tar-io';

/** Who is calling. Absent for single-client embedders (Electron). */
export interface ClientCtx {
  clientId: string;
}

export type ServiceHandler = (args: unknown[], ctx?: ClientCtx) => unknown;

export interface PearServiceFeatures {
  /** "This machine" as a host: a PTY on whatever box runs the service. */
  localHost: boolean;
  /** Offer entries from the service user's ~/.ssh/config. */
  sshConfig: boolean;
  /** The Claude CLI in a local PTY (claude.open). */
  claudePty: boolean;
}

export interface PearServiceEnv {
  /** Where hosts.json, workspaces.json, history.json and claude/ live. */
  dataDir: string;
  cipher: SecretCipher;
  /**
   * Push an event towards the UI(s). Channels are the `event` rows of the
   * channel table. `term:data` carries a third argument, the terminal's
   * cumulative output length, for embedders that replay scrollback.
   */
  emit(channel: string, ...args: unknown[]): void;
  /**
   * Deliver a UI-facing Claude tool request (read_terminal, reveal_in_app) to
   * whichever client should answer it. Return false when nobody can — the
   * tool then fails at once instead of waiting out the timeout.
   */
  sendUiRequest?(request: { id: string; payload: ClaudeUiRequestPayload }): boolean;
  /** Destination of transfers.download. Without it the call rejects. */
  downloadsDir?: string;
  features?: Partial<PearServiceFeatures>;
  termPolicy?: TermPolicy;
  /**
   * Verify SSH host keys against dataDir/known_hosts.json (trust on first
   * use). Off = ssh2's default of accepting any key — what the desktop app
   * has always done. A network-facing embedder should turn it on.
   */
  verifyHostKeys?: boolean;
  warn?(message: string): void;
}

// Main → UI round-trips for the UI-facing MCP tools. The timeout only fires
// when the UI is gone or reloading — handlers themselves are synchronous.
const UI_REQUEST_TIMEOUT_MS = 5_000;

const asString = (v: unknown): string => {
  if (typeof v !== 'string') throw new Error('Invalid argument: expected a string');
  return v;
};

/**
 * Everything behind PearApi, with no opinion about how calls arrive: the
 * Electron main process feeds it from ipcMain, pear-server from a WebSocket.
 * Embedder-specific behaviour (native dialogs, browser uploads) replaces
 * individual channels via {@link override}.
 */
const TOOLS_TTL_MS = 5 * 60_000;

export class PearService {
  readonly hosts: HostStore;
  readonly groups: HostGroupStore;
  readonly history: HistoryStore;
  readonly sessions: SessionManager;
  readonly transfers: TransferEngine;
  readonly fsOps: FsOpsRunner;
  /** Archive tool probe per host; a host's toolbox rarely changes mid-session. */
  private readonly toolsCache = new Map<string, { at: number; tools: ArchiveTools }>();
  readonly terms: TerminalHub;
  readonly features: PearServiceFeatures;

  // Session-scoped sub-hosts (jump-in targets). Anything hostId-keyed resolves
  // through both stores; pinning just moves the entry into the persistent one.
  private readonly ephemeral = new EphemeralHostRegistry();
  // SSH port forwards opened by the Claude tools (loopback listeners piped into
  // forwardOut legs). Torn down per-host on disconnect and wholesale on dispose.
  private readonly forwards: PortForwardManager;
  // Private relay transport for the transfer engine's local side — never shown
  // in the sidebar, independent of whether the user registered a local host.
  private relay: LocalConnection | null = null;

  // Claude Code integration: a loopback MCP server exposing the pear tools, and
  // a workspace dir the (user-installed, self-authenticated) claude CLI runs in.
  // Failure is non-fatal — the dock just reports tools as unavailable.
  private claudeMcp: PearMcpServer | null = null;
  private claudeChat: ClaudeChatRuntime | null = null;
  private claudeExecutor: ClaudeExecutor | null = null;

  private readonly pendingUi = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();
  private readonly handlers = new Map<string, ServiceHandler>();
  private knownHosts?: KnownHosts;

  constructor(private readonly env: PearServiceEnv) {
    this.features = { localHost: true, sshConfig: true, claudePty: true, ...env.features };
    this.hosts = new HostStore(this.file('hosts.json'), env.cipher);
    this.groups = new HostGroupStore(this.file('workspaces.json'));
    this.history = new HistoryStore(this.file('history.json'));

    if (env.verifyHostKeys) this.knownHosts = new KnownHosts(this.file('known_hosts.json'));

    this.terms = new TerminalHub(
      {
        onData: (termId, data, endSeq) => env.emit('term:data', termId, data, endSeq),
        onExit: (termId) => env.emit('term:exit', termId),
      },
      env.termPolicy ?? PASSTHROUGH_POLICY,
    );

    this.sessions = new SessionManager(
      {
        onTermData: (termId, data) => this.terms.ingest(termId, data),
        onTermExit: (termId) => this.terms.ended(termId),
        onHostDisconnected: (hostId) => {
          // Unpinned sub-hosts don't outlive their parent's connection.
          for (const childId of this.ephemeral.removeByParent(hostId)) {
            env.emit('host:disconnected', childId);
          }
          this.forwards.closeForHost(hostId); // dead tunnels must not keep listening
          this.toolsCache.delete(hostId);
          env.emit('host:disconnected', hostId);
        },
      },
      (config, jump) => {
        if (config.local) return new LocalConnection();
        if (config.via && !(jump instanceof SshConnection)) {
          throw new Error('Jump host must be a direct SSH connection');
        }
        return new SshConnection(
          config,
          jump instanceof SshConnection ? jump : undefined,
          this.knownHosts,
        );
      },
      this.resolveHost,
    );

    this.transfers = new TransferEngine(
      {
        connection: async (hostId) => {
          if (hostId === null) {
            if (!this.relay?.isConnected) {
              this.relay = new LocalConnection();
              await this.relay.connect();
            }
            return this.relay;
          }
          return this.sessions.connection(this.requireHost(hostId));
        },
        makeStagingDir,
        removeStaging,
        tar: nodeTarIo,
      },
      { onUpdate: (job) => env.emit('transfer:update', job) },
    );
    this.fsOps = new FsOpsRunner(
      { connection: (hostId) => this.sessions.connection(this.requireHost(hostId)) },
      { onUpdate: (op) => env.emit('fsop:update', op) },
    );

    this.forwards = new PortForwardManager((host) => this.sessions.connection(host));
    this.registerHandlers();
  }

  /** Background start-up work: stale staging sweep, Claude MCP integration. */
  async start(): Promise<void> {
    void sweepStaging();
    await this.startClaudeIntegration();
  }

  // ---- dispatch ------------------------------------------------------------

  async invoke(channel: string, args: unknown[], ctx?: ClientCtx): Promise<unknown> {
    const handler = this.handlers.get(channel);
    if (!handler) throw new Error(`Unknown channel: ${channel}`);
    return handler(args, ctx);
  }

  /** Fire-and-forget: failures are swallowed, exactly like ipcMain.on. */
  send(channel: string, args: unknown[], ctx?: ClientCtx): void {
    const handler = this.handlers.get(channel);
    if (!handler) return;
    try {
      void Promise.resolve(handler(args, ctx)).catch(() => {});
    } catch {
      /* fire-and-forget */
    }
  }

  /** Replace one channel with embedder-specific behaviour. */
  override(channel: string, handler: ServiceHandler): void {
    if (!this.handlers.has(channel)) throw new Error(`Unknown channel: ${channel}`);
    this.handlers.set(channel, handler);
  }

  hasHandler(channel: string): boolean {
    return this.handlers.has(channel);
  }

  // ---- shared helpers embedders build on -------------------------------------

  /**
   * Connect-time lookup: the single chokepoint where stored ciphertext becomes
   * plaintext auth. Every connection-opening path resolves through here; the
   * result is never returned to a UI.
   */
  readonly resolveHost = (id: string): HostConfig | undefined => {
    const h = this.hosts.get(id) ?? this.ephemeral.get(id);
    return h && this.hosts.decryptAuth(h);
  };

  requireHost(id: unknown): HostConfig {
    const host = this.resolveHost(asString(id));
    if (!host) throw new Error(`Unknown host: ${String(id)}`);
    return host;
  }

  /**
   * Queue uploads of files that already sit on this machine's disk. One
   * transfer job per source directory (usually exactly one). Returns job ids.
   */
  async startLocalUpload(
    hostId: string,
    remoteDir: string,
    absPaths: string[],
    conflict: ConflictPolicy,
    verify: boolean,
  ): Promise<string[]> {
    this.requireHost(hostId);
    const byDir = new Map<string, string[]>();
    for (const localPath of absPaths) {
      const dir = dirname(localPath);
      byDir.set(dir, [...(byDir.get(dir) ?? []), basename(localPath)]);
    }
    const ids: string[] = [];
    for (const [dir, names] of byDir) {
      ids.push(
        await this.transfers.start({
          src: { hostId: null, dir },
          dest: this.normalizeEndpoint({ hostId, dir: remoteDir }),
          names,
          op: 'copy',
          conflict,
          verify,
        }),
      );
    }
    return ids;
  }

  /** Fail every in-flight UI round-trip (the answering UI went away). */
  rejectPendingUi(reason: string): void {
    for (const [, p] of this.pendingUi) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
    this.pendingUi.clear();
  }

  async dispose(): Promise<void> {
    this.rejectPendingUi('Pear is shutting down');
    for (const job of this.transfers.list()) this.transfers.cancel(job.id);
    this.forwards.disposeAll();
    for (const t of this.terms.list()) if (t.kind === 'claude') this.terms.close(t.termId);
    this.sessions.disposeAll();
    this.relay?.dispose();
    this.relay = null;
    this.terms.disposeAll();
    this.claudeChat?.dispose();
    this.claudeChat = null;
    await this.claudeMcp?.stop();
    this.claudeMcp = null;
  }

  // ---- internals -------------------------------------------------------------

  private file(name: string): JsonFileStorage {
    return new JsonFileStorage(join(this.env.dataDir, name));
  }

  private claudeDir(): string {
    return join(this.env.dataDir, 'claude');
  }

  /**
   * Configs that arrive as objects (Claude tool callbacks) are sanitized views
   * with the ciphertext stripped — re-resolve by id to get connectable auth.
   */
  private withSecrets(h: HostConfig): HostConfig {
    return this.resolveHost(h.id) ?? h;
  }

  /** Endpoints on a registered local host collapse to the relay side, so a
   *  local-host pane gets a 1-stage transfer instead of a pointless relay hop. */
  private normalizeEndpoint(ep: TransferEndpoint): TransferEndpoint {
    if (ep.hostId === null) return ep;
    const host = this.requireHost(ep.hostId);
    return host.local ? { hostId: null, dir: ep.dir } : ep;
  }

  /** Remove a host and every descendant sub-host, persisted or ephemeral. */
  private removeHostTree(id: string): void {
    for (const child of this.hosts.list().filter((h) => h.parentId === id)) {
      this.removeHostTree(child.id);
    }
    for (const childId of this.ephemeral.removeByParent(id)) {
      this.sessions.disconnectHost(childId);
    }
    this.sessions.disconnectHost(id);
    if (this.ephemeral.get(id)) this.ephemeral.remove(id);
    else this.hosts.remove(id);
  }

  private claudeUiRequest(payload: ClaudeUiRequestPayload): Promise<unknown> {
    const id = uuid();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingUi.delete(id);
        reject(new Error('Pear UI did not respond (window busy or reloading)'));
      }, UI_REQUEST_TIMEOUT_MS);
      this.pendingUi.set(id, { resolve, reject, timer });
      if (!this.env.sendUiRequest?.({ id, payload })) {
        clearTimeout(timer);
        this.pendingUi.delete(id);
        reject(new Error('No Pear window or client is connected to answer'));
      }
    });
  }

  private async startClaudeIntegration(): Promise<void> {
    try {
      const executor = new ClaudeExecutor({
        hosts: () => [...this.hosts.listSanitized(), ...this.ephemeral.list().map(sanitizeHost)],
        isConnected: (id) => this.sessions.isConnected(id),
        // Configs flowing back in from the executor are sanitized views — put
        // the decrypted auth back before they reach a connection.
        exec: (host, command) => this.sessions.exec(this.withSecrets(host), command),
        readFile: (host, path, maxBytes) =>
          this.sessions.readFile(this.withSecrets(host), path, maxBytes),
        writeFile: (host, path, content) =>
          this.sessions.writeFile(this.withSecrets(host), path, content),
        listDir: (host, path) => this.sessions.listDir(this.withSecrets(host), path),
        uiRequest: (payload) => this.claudeUiRequest(payload),
        startTransfer: (req) =>
          this.transfers.start({
            ...req,
            src: this.normalizeEndpoint(req.src),
            dest: this.normalizeEndpoint(req.dest),
          }),
        transferList: () => this.transfers.list(),
        openForward: (host, remotePort, remoteHost, localPort) =>
          this.forwards.open(this.withSecrets(host), remotePort, remoteHost, localPort),
        listForwards: () => this.forwards.list(),
        closeForward: (id) => this.forwards.close(id),
      });
      this.claudeExecutor = executor;
      this.claudeChat = new ClaudeChatRuntime({
        dir: this.claudeDir(),
        storage: this.file('claude-sessions.json'),
        emit: (event) => this.env.emit('claude:event', event),
        executor,
      });
      this.claudeMcp = new PearMcpServer(executor, this.claudeChat.bridge);
      const info = await this.claudeMcp.start();
      await provisionClaudeWorkspace({ dir: this.claudeDir(), url: info.url, token: info.token });
    } catch (err) {
      this.claudeMcp = null;
      (this.env.warn ?? console.warn)(
        `[claude] MCP integration unavailable: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async archiveTools(host: HostConfig): Promise<ArchiveTools> {
    const cached = this.toolsCache.get(host.id);
    if (cached && Date.now() - cached.at < TOOLS_TTL_MS) return cached.tools;
    const tools = await this.sessions.archiveTools(host);
    this.toolsCache.set(host.id, { at: Date.now(), tools });
    return tools;
  }

  private registerHandlers(): void {
    const on = (channel: string, handler: ServiceHandler): void => {
      this.handlers.set(channel, handler);
    };
    const { hosts, groups, history, sessions, transfers, ephemeral, terms } = this;

    on('hosts:list', () => hosts.listSanitized());
    on('hosts:upsert', ([host]) => hosts.upsert(host as Omit<HostConfig, 'id'> & { id?: string }));
    on('hosts:remove', ([id]) => {
      this.removeHostTree(asString(id));
      groups.removeHostRefs(asString(id));
    });
    on('hosts:addLocal', () => {
      if (!this.features.localHost) {
        throw new Error('The local host is disabled on this Pear server');
      }
      const existing = hosts.list().find((h) => h.local);
      if (existing) return sanitizeHost(existing);
      return hosts.upsert({
        name: hostname(),
        host: 'localhost',
        port: 0,
        user: userInfo().username,
        kind: 'plain',
        local: true,
      });
    });
    on('hosts:sshConfigEntries', () => (this.features.sshConfig ? loadSshConfigEntries() : []));
    // Never rejects — untested addresses are routine, not exceptional.
    on('hosts:probe', ([endpoint, timeoutMs]) => {
      const ep = endpoint as { addr: string; port: number };
      return probeSsh(ep.addr, ep.port, timeoutMs as number | undefined);
    });

    on('hostgroups:list', () => groups.list());
    on('hostgroups:upsert', ([group]) =>
      groups.upsert(group as Omit<HostGroup, 'id'> & { id?: string }),
    );
    on('hostgroups:remove', ([id]) => groups.remove(asString(id)));
    on('hostgroups:setMembership', ([hostId, groupId, member]) =>
      groups.setMembership(asString(hostId), asString(groupId), member === true),
    );

    on('term:open', async ([hostId, size, rawOpts], ctx) => {
      const host = this.requireHost(hostId);
      const opts = rawOpts as { password?: string; cwd?: string } | undefined;
      const config = opts?.password
        ? { ...host, auth: { ...host.auth, password: opts.password } }
        : host;
      const handle = await sessions.openTerminal(config, size as TermSize, { cwd: opts?.cwd });
      const id = handle.id;
      terms.track(
        id,
        { hostId: host.id, kind: 'shell', size: size as TermSize },
        {
          write: (data) => sessions.writeTerminal(id, data),
          resize: (s) => sessions.resizeTerminal(id, s),
          close: () => sessions.closeTerminal(id),
        },
      );
      if (ctx) terms.attach(id, ctx.clientId);
      return id;
    });
    on('term:write', ([termId, data]) => terms.write(asString(termId), asString(data)));
    on('term:resize', ([termId, size]) => terms.resize(asString(termId), size as TermSize));
    on('term:close', ([termId]) => terms.close(asString(termId)));

    on('claude:open', ([size], ctx) => {
      if (!this.features.claudePty) {
        throw new Error('The Claude terminal is disabled on this Pear server');
      }
      // Claude PTYs are local channels outside SessionManager (no host
      // attached); the hub gives them the same term:* streaming channels.
      const channel = launchClaudePty(this.claudeDir(), size as TermSize);
      const id = uuid();
      terms.track(id, { hostId: null, kind: 'claude', size: size as TermSize }, channel);
      channel.onData((data) => terms.ingest(id, data));
      channel.onClose(() => terms.ended(id));
      if (ctx) terms.attach(id, ctx.clientId);
      return id;
    });
    on('claude:status', async () => ({
      installed: await claudeInstalled(),
      mcpReady: this.claudeMcp !== null,
    }));
    on('claude:chatSend', ([text]) => {
      if (!this.claudeChat) throw new Error('Claude integration unavailable');
      this.claudeChat.send(asString(text));
    });
    on('claude:chatInterrupt', () => this.claudeChat?.interrupt());
    on('claude:chatAnswer', ([requestId, answer]) =>
      this.claudeChat?.answer(asString(requestId), answer as PermissionAnswer),
    );
    on('claude:chatAutoApprove', ([flag]) => this.claudeChat?.setAutoApprove(flag === true));
    on('claude:chatModel', ([model]) =>
      this.claudeChat?.setModel(typeof model === 'string' && model ? model : null),
    );
    on('claude:chatSessions', () => this.claudeChat?.sessions() ?? []);
    on('claude:chatResume', ([sessionId]) => this.claudeChat?.resume(asString(sessionId)) ?? []);
    on('claude:chatNew', () => this.claudeChat?.newSession());
    on(
      'claude:chatState',
      () =>
        this.claudeChat?.snapshot() ?? {
          sessionId: null,
          events: [],
          busy: false,
          model: null,
          autoApprove: false,
        },
    );
    on('claude:uiResponse', ([response]) => {
      const r = response as ClaudeUiResponse;
      const p = this.pendingUi.get(r.id);
      if (!p) return; // stale reply after timeout or reload
      this.pendingUi.delete(r.id);
      clearTimeout(p.timer);
      if (r.ok) p.resolve(r.value);
      else p.reject(new Error(r.error));
    });
    on('claude:focus', ([raw]) => {
      const focus = raw as ClaudeFocus | null;
      this.claudeExecutor?.setFocus(
        focus && typeof focus.hostId === 'string'
          ? {
              hostId: focus.hostId,
              ...(typeof focus.path === 'string' ? { path: focus.path } : {}),
            }
          : null,
      );
    });

    on('fs:list', ([hostId, path, password]) => {
      const host = this.requireHost(hostId);
      const config =
        typeof password === 'string' && password
          ? { ...host, auth: { ...host.auth, password } }
          : host;
      return sessions.listDir(config, asString(path));
    });
    on('fs:stat', ([hostId, path]) => sessions.stat(this.requireHost(hostId), asString(path)));
    on('fs:mkdir', ([hostId, path]) => sessions.mkdir(this.requireHost(hostId), asString(path)));
    on('fs:remove', ([hostId, path, recursive]) =>
      sessions.remove(this.requireHost(hostId), asString(path), recursive as boolean | undefined),
    );
    on('fs:rename', ([hostId, oldPath, newPath]) =>
      sessions.rename(this.requireHost(hostId), asString(oldPath), asString(newPath)),
    );
    on('fs:copy', ([hostId, src, dest]) =>
      sessions.copy(this.requireHost(hostId), asString(src), asString(dest)),
    );
    on('fs:read', ([hostId, path]) => sessions.readFile(this.requireHost(hostId), asString(path)));
    on('fs:write', ([hostId, path, content]) =>
      sessions.writeFile(this.requireHost(hostId), asString(path), asString(content)),
    );
    // Picking files is the embedder's job (native dialog, browser input).
    on('fs:upload', () => {
      throw new Error('File upload is not available in this environment');
    });
    on('fs:info', ([hostId, path, deep]) =>
      sessions.fileInfo(this.requireHost(hostId), asString(path), deep === true),
    );
    on('fs:setPerms', ([hostId, path, change]) =>
      sessions.setPerms(this.requireHost(hostId), asString(path), change as PermsChange),
    );

    on('ops:tools', ([hostId]) => this.archiveTools(this.requireHost(hostId)));
    on('ops:extract', async ([hostId, archivePath, destDir]) => {
      const host = this.requireHost(hostId);
      const plan = planExtract(
        await this.archiveTools(host),
        asString(archivePath),
        asString(destDir),
      );
      return this.fsOps.start({ hostId: host.id, ...plan });
    });
    on('ops:compress', async ([hostId, dir, names, archiveName, format]) => {
      const host = this.requireHost(hostId);
      const plan = planCompress(
        await this.archiveTools(host),
        asString(dir),
        (names as unknown[]).map(asString),
        asString(archiveName),
        asString(format) as ArchiveFormat,
      );
      return this.fsOps.start({ hostId: host.id, ...plan });
    });
    on('ops:cancel', ([id]) => this.fsOps.cancel(asString(id)));
    on('ops:list', () => this.fsOps.list());
    on('ops:clearFinished', () => this.fsOps.clearFinished());

    on('orch:get', async ([hostId]) => {
      const host = this.requireHost(hostId);
      // Detect every run each time — a host's facet set can change (a container
      // engine starts, a node joins a swarm). Persist the primary kind so the
      // sidebar glyph is right even before the panel is opened.
      const facets = await sessions.detectOrchFacets(host);
      const kind = primaryKind(facets);
      if (kind !== host.kind && !host.kindManual) {
        // Never upsert an ephemeral sub-host into the persistent store — and
        // upsert the *stored* record, not the decrypted connect-time view.
        const stored = hosts.get(host.id);
        if (stored) hosts.upsert({ ...stored, kind });
        else ephemeral.update({ ...(ephemeral.get(host.id) ?? host), kind });
      }
      return sessions.orchestration(host, facets);
    });
    on('orch:action', ([hostId, action]) =>
      sessions.orchAction(this.requireHost(hostId), action as OrchAction),
    );
    on('orch:serviceTasks', ([hostId, service]) =>
      sessions.serviceTasks(this.requireHost(hostId), asString(service)),
    );
    on('orch:taskLogs', ([hostId, taskId, opts]) =>
      sessions.taskLogs(
        this.requireHost(hostId),
        asString(taskId),
        opts as { tail?: number; since?: string } | undefined,
      ),
    );

    // Poll-tick handlers: a dropped link makes them fail routinely. They throw
    // like everything else here; embedders whose transport logs rejections
    // (Electron) wrap them in an envelope.
    on('monitor:sample', ([hostId]) => sessions.vitals(this.requireHost(hostId)));
    on('monitor:dockerDf', ([hostId]) => sessions.dockerDf(this.requireHost(hostId)));
    on('monitor:stats', async ([hostId]) =>
      Object.fromEntries(await sessions.containerStats(this.requireHost(hostId))),
    );

    on('subhosts:list', () => ephemeral.list().map(sanitizeHost));
    on('subhosts:jumpIn', async ([parentId, rawTarget, name]) => {
      const parent = this.requireHost(parentId);
      const target = rawTarget as SubHostTarget;
      const probe = await sessions.exec(parent, probeCommand(target));
      if (probe.code !== 0) throw new Error(probeError(target, probe));
      const user = probe.stdout.trim().split('\n').pop()?.trim() || 'root';
      return ephemeral.add({
        name: asString(name),
        host: parent.host,
        port: parent.port,
        user,
        kind: 'plain',
        parentId: parent.id,
        target,
      });
    });
    on('subhosts:pin', ([id]) => {
      const cfg = ephemeral.get(asString(id));
      if (!cfg) throw new Error(`Unknown sub-host: ${String(id)}`);
      const saved = hosts.upsert(cfg);
      ephemeral.remove(cfg.id);
      return saved;
    });
    on('subhosts:unpin', ([id]) => {
      const cfg = hosts.get(asString(id));
      if (!cfg?.parentId && !cfg?.via) throw new Error(`Not a pinned sub-host: ${String(id)}`);
      hosts.remove(cfg.id);
      groups.removeHostRefs(cfg.id);
      return sanitizeHost(ephemeral.add(cfg));
    });
    on('subhosts:jumpInVm', async ([parentId, vmid, name]) => {
      const parent = this.requireHost(parentId);
      const result = await sessions.exec(
        parent,
        `qm guest cmd ${Number(vmid)} network-get-interfaces`,
      );
      if (result.code !== 0) {
        throw new Error('Guest agent not responding — is qemu-guest-agent installed and running?');
      }
      const ip = parseGuestIp(result.stdout);
      if (!ip) throw new Error('Guest agent reported no usable IP address');
      return ephemeral.add({
        name: asString(name),
        host: ip,
        port: 22,
        user: 'root',
        kind: 'plain',
        via: parent.id,
      });
    });

    on('hostkeys:trust', ([prompt]) => {
      if (!this.knownHosts) throw new Error('Host keys are not verified here');
      const p = prompt as HostKeyPrompt;
      this.knownHosts.trust({
        host: asString(p?.host),
        port: Number(p?.port),
        keyType: String(p?.keyType ?? 'unknown'),
        fingerprint: asString(p?.fingerprint),
      });
    });
    on('hostkeys:forget', ([host, port]) => this.knownHosts?.forget(asString(host), Number(port)));

    on('history:list', () => history.list());
    on('history:record', ([hostId, command]) =>
      history.record(asString(hostId), asString(command)),
    );
    on('history:clear', ([hostId]) => history.clear(hostId as string | undefined));
    // Only ever reached because the UI's "scan remote shell history" setting
    // is on — the service never scans a host by itself.
    on('history:import', async ([hostId]) => {
      const host = this.requireHost(hostId);
      const { files, commands } = await importShellHistory((path, maxBytes) =>
        sessions.readFile(host, path, maxBytes),
      );
      return { added: history.importCommands(host.id, commands), files };
    });

    on('transfers:start', ([raw]) => {
      const req = raw as TransferRequest;
      return transfers.start({
        ...req,
        src: this.normalizeEndpoint(req.src),
        dest: this.normalizeEndpoint(req.dest),
      });
    });
    on('transfers:download', ([srcHostId, srcDir, names, conflict, verify, skipMacMeta]) => {
      if (!this.env.downloadsDir) {
        throw new Error('Downloads are not available in this environment');
      }
      return transfers.start({
        src: this.normalizeEndpoint({ hostId: asString(srcHostId), dir: asString(srcDir) }),
        dest: { hostId: null, dir: this.env.downloadsDir },
        names: names as string[],
        op: 'copy',
        conflict: conflict as ConflictPolicy,
        verify: verify === true,
        skipMacMeta: skipMacMeta !== false,
      });
    });
    on('transfers:cancel', ([id]) => transfers.cancel(asString(id)));
    on('transfers:list', () => transfers.list());
    on('transfers:clearFinished', () => transfers.clearFinished());
    on('transfers:setMaxParallel', ([n]) => transfers.setMaxParallel(Number(n)));

    // The table is the contract: a wire channel nobody serves is a bug here,
    // not a runtime surprise in some client.
    for (const channel of [...channelsOf('invoke'), ...channelsOf('send')]) {
      if (!this.handlers.has(channel)) throw new Error(`No handler for channel ${channel}`);
    }
  }
}
