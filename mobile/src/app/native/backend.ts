import {
  ClaudeChatRuntime,
  ClaudeExecutor,
  HistoryStore,
  HostGroupStore,
  SessionManager,
  TransferEngine,
  importShellHistory,
  primaryKind,
  type ClaudeChatEvent,
  type ClaudeFocus,
  type ClaudeSessionMeta,
  type HostConfig,
  type PearApi,
  type ProbeResult,
  type TransferJobSnapshot,
} from '@pear/core';
import { SshChatSession } from './claude/ssh-chat-session';
import { claudeWorkspaceDir, provisionSshWorkspace } from './claude/workspace';
import { SshEventHub } from './event-hub';
import { MobileHostStore } from './host-store';
import { syncStorage, type AsyncCipher, type AsyncKv } from './kv';
import { LocalFsTransport } from './local-fs';
import type { PearSshPlugin } from './pear-ssh';
import { CapacitorSshTransport, type HostKeyGate } from './transport';

export interface NativeBackendDeps {
  plugin: PearSshPlugin;
  gate: HostKeyGate;
  kv: AsyncKv;
  cipher: AsyncCipher;
}

interface Ready {
  hosts: MobileHostStore;
  groups: HostGroupStore;
  history: HistoryStore;
  sessions: SessionManager;
}

const notYet = (what: string) => () => Promise.reject(new Error(what));

const CLAUDE_HOST_KEY = 'pear.claudeHost';

/** Mobile-only extras beyond PearApi (the Claude tab's host picker). */
export interface MobileClaudeConfig {
  getClaudeHost(): Promise<string | null>;
  setClaudeHost(id: string | null): Promise<void>;
}

/** Mobile-only transfer extras: SAF flows PearApi has no shape for. */
export interface MobileTransfersConfig {
  /** SAF picker → upload the chosen documents into destDir on the host.
   *  Resolves with the job id, or null when the user cancels the picker. */
  pickAndUpload(hostId: string, destDir: string): Promise<string | null>;
}

function randomToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** A Claude setup failure with a message already written for the user. */
class ClaudeSetupError extends Error {}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Typed reject code from the plugin bridge (SshError.code), when present. */
function codeOf(e: unknown): string | undefined {
  return (e as { code?: string })?.code;
}

/**
 * The real Android backend: PearApi over core's SessionManager with
 * CapacitorSshTransport underneath — the same session/orchestration/monitor
 * logic as desktop, riding the PearSsh plugin instead of ssh2. Store loading
 * is async (Preferences), so every method awaits a shared `ready` promise;
 * construction itself stays synchronous for Angular's provider factory.
 *
 * Deliberately deferred, per docs/ANDROID.md: transfers + fs.upload (M6),
 * claude (M4), subhosts/via (M5), addLocal (never — the phone is not a host).
 */
export function createNativeBackend(
  deps: NativeBackendDeps,
): PearApi & MobileClaudeConfig & MobileTransfersConfig {
  const termData = new Set<(termId: string, data: string) => void>();
  const termExit = new Set<(termId: string) => void>();
  const hostDown = new Set<(hostId: string) => void>();
  const claudeEvents = new Set<(e: ClaudeChatEvent) => void>();
  const hub = new SshEventHub(deps.plugin);

  // ---- Claude over SSH (lazy — provisioned on first chat use) --------------
  interface ClaudeState {
    runtime: ClaudeChatRuntime;
    executor: ClaudeExecutor;
    loadTranscript(id: string): Promise<void>;
    dispose(): void;
  }
  let claudeState: Promise<ClaudeState> | null = null;

  /** Tear down a built Claude session's tunnel + server; best-effort. */
  const teardownClaude = (): void => {
    const pending = claudeState;
    claudeState = null;
    activeClaudeHostId = null;
    void pending?.then((s) => s.dispose()).catch(() => {});
  };
  let activeClaudeHostId: string | null = null;
  let claudeFocus: ClaudeFocus | null = null;
  let claudeAutoApprove = false;
  let claudeModel: string | null = null;

  const emitClaude = (e: ClaudeChatEvent) => claudeEvents.forEach((cb) => cb(e));

  const ready: Promise<Ready> = (async () => {
    const hosts = await MobileHostStore.load(deps.kv, deps.cipher);
    const groups = new HostGroupStore(await syncStorage(deps.kv, 'pear.groups'));
    const history = new HistoryStore(await syncStorage(deps.kv, 'pear.history'));
    const sessions = new SessionManager(
      {
        onTermData: (termId, data) => termData.forEach((cb) => cb(termId, data)),
        onTermExit: (termId) => termExit.forEach((cb) => cb(termId)),
        onHostDisconnected: (hostId) => {
          // The Claude runtime deliberately survives a dropped connection:
          // the detached runner keeps working on the host, and the chat
          // session re-dials + re-forwards the tunnel itself (ensureTunnel).
          // Teardown only happens on host switch or backend dispose.
          hostDown.forEach((cb) => cb(hostId));
        },
      },
      (cfg, jump) => new CapacitorSshTransport(cfg, { plugin: deps.plugin, hub, gate: deps.gate }, jump),
      (id) => hosts.get(id),
    );
    return { hosts, groups, history, sessions };
  })();

  /** Decrypted connect-time config; an override password wins for this call. */
  const cfgFor = async (hostId: string, password?: string): Promise<HostConfig> => {
    const { hosts } = await ready;
    const host = hosts.get(hostId);
    if (!host) throw new Error(`Unknown host: ${hostId}`);
    const cfg = await hosts.decryptAuth(host);
    if (password) cfg.auth = { ...cfg.auth, password };
    return cfg;
  };

  const transportFor = async (hostId: string): Promise<CapacitorSshTransport> => {
    const { sessions } = await ready;
    const conn = await sessions.connection(await cfgFor(hostId));
    if (!(conn instanceof CapacitorSshTransport)) throw new Error('Unexpected transport type');
    return conn;
  };

  // ---- transfers: TransferEngine with the phone as the relay ---------------

  const transferUpdates = new Set<(job: TransferJobSnapshot) => void>();
  /** jobId → staging dir to publish into system Downloads on success. */
  const downloadJobs = new Map<string, string>();
  /** jobId → staging dir to delete once the job reaches a terminal state. */
  const jobStaging = new Map<string, string>();
  const localFs = new LocalFsTransport(deps.plugin);

  /** Move every staged file into the Downloads collection, then clean up. */
  const publishDownloads = async (dir: string): Promise<void> => {
    const walk = async (d: string): Promise<void> => {
      const listing = await deps.plugin.localList({ path: d });
      for (const entry of listing.entries) {
        const p = `${d}/${entry.name}`;
        if (entry.kind === 'dir') await walk(p);
        else await deps.plugin.saveToDownloads({ localPath: p });
      }
    };
    try {
      await walk(dir);
    } finally {
      void deps.plugin.localRemove({ path: dir, recursive: true }).catch(() => {});
    }
  };

  const settleTransferJob = (job: TransferJobSnapshot): void => {
    const downloadDir = downloadJobs.get(job.id);
    const stagingDir = jobStaging.get(job.id);
    downloadJobs.delete(job.id);
    jobStaging.delete(job.id);
    if (job.status === 'done' && downloadDir) {
      void publishDownloads(downloadDir);
      return;
    }
    for (const dir of [downloadDir, stagingDir]) {
      if (dir) void deps.plugin.localRemove({ path: dir, recursive: true }).catch(() => {});
    }
  };

  const transfers = new TransferEngine(
    {
      connection: async (hostId) =>
        hostId === null ? localFs : (await ready).sessions.connection(await cfgFor(hostId)),
      makeStagingDir: async () => (await deps.plugin.makeStagingDir()).path,
      removeStaging: async (dir) => deps.plugin.localRemove({ path: dir, recursive: true }),
    },
    {
      onUpdate: (job) => {
        transferUpdates.forEach((cb) => cb(job));
        if (job.status === 'done' || job.status === 'error' || job.status === 'canceled') {
          settleTransferJob(job);
        }
      },
    },
  );

  // ---- resilient terminals via tmux (screen-off / backgrounding) ----------
  const TMUX_SESSION = 'pear';
  const tmuxAvailable = new Map<string, boolean>();
  const tmuxWarned = new Set<string>();

  const wrapTerminalInTmux = async (
    sessions: SessionManager,
    cfg: HostConfig,
    termId: string,
  ): Promise<void> => {
    try {
      let has = tmuxAvailable.get(cfg.id);
      if (has === undefined) {
        const r = await sessions.exec(
          cfg,
          '"$SHELL" -lc \'command -v tmux\' >/dev/null 2>&1 && echo yes || echo no',
        );
        has = r.stdout.includes('yes');
        tmuxAvailable.set(cfg.id, has);
      }
      if (has) {
        // Attach-or-create: reconnect re-attaches the same live session.
        sessions.writeTerminal(termId, `tmux new-session -A -s ${TMUX_SESSION}\n`);
      } else if (!tmuxWarned.has(cfg.id)) {
        tmuxWarned.add(cfg.id);
        termData.forEach((cb) =>
          cb(
            termId,
            '\x1b[2m[pear] tmux not found — install it for terminal sessions that survive backgrounding\x1b[0m\r\n',
          ),
        );
      }
    } catch {
      // best-effort: a plain shell still works
    }
  };

  const buildClaude = async (): Promise<ClaudeState> => {
    const hostId = await deps.kv.get(CLAUDE_HOST_KEY);
    if (!hostId) {
      throw new ClaudeSetupError('Pick a Claude host from the ⋯ menu — a server with the claude CLI installed and logged in.');
    }
    const { hosts, sessions } = await ready;
    const hostName = hosts.get(hostId)?.name ?? hostId;

    let transport: CapacitorSshTransport;
    try {
      transport = await transportFor(hostId);
    } catch (e) {
      throw new ClaudeSetupError(`Couldn't connect to the Claude host "${hostName}": ${errText(e)}`);
    }
    const pluginSession = transport.pluginSessionId;
    if (!pluginSession) throw new ClaudeSetupError(`The Claude host "${hostName}" isn't connected.`);

    // Preflight: is the CLI actually there? A clear message beats a code-127
    // exit mid-turn after the tunnel is already up.
    const dir = await claudeWorkspaceDir(transport).catch((e: unknown) => {
      throw new ClaudeSetupError(`Couldn't reach "${hostName}"'s home directory: ${errText(e)}`);
    });
    const probe = await transport.exec('"$SHELL" -lc \'command -v claude\' >/dev/null 2>&1 && echo yes || echo no');
    if (!probe.stdout.includes('yes')) {
      throw new ClaudeSetupError(`The claude CLI isn't installed (or not on PATH) on "${hostName}". Install it there and run \`claude login\`, then try again.`);
    }

    // Tunnel: device relay ← SSH remote forward ← claude on the host.
    const token = randomToken();
    const { port } = await deps.plugin.mcpStart();
    const cleanup = () => {
      void deps.plugin.mcpStop();
    };

    let remotePort: number;
    try {
      ({ remotePort } = await deps.plugin.remoteForwardOpen({ sessionId: pluginSession, targetPort: port }));
    } catch (e) {
      cleanup();
      if (codeOf(e) === 'FORWARD_DENIED') {
        throw new ClaudeSetupError(`"${hostName}" won't let Claude tunnel back to your phone — its SSH server has TCP forwarding disabled. Set \`AllowTcpForwarding yes\` in /etc/ssh/sshd_config on that host and restart sshd.`);
      }
      throw new ClaudeSetupError(`Couldn't open the Claude tunnel to "${hostName}": ${errText(e)}`);
    }

    try {
      await provisionSshWorkspace(transport, dir, remotePort, token);
    } catch (e) {
      cleanup();
      void deps.plugin.remoteForwardClose({ sessionId: pluginSession, remotePort });
      throw new ClaudeSetupError(`Couldn't set up Claude's workspace on "${hostName}": ${errText(e)}`);
    }

    // The MCP tunnel dies with its SSH session, but the detached claude's
    // .mcp.json (written once above) points at a fixed remote port. So when
    // the connection has dropped, redial and re-forward the SAME port —
    // the running claude never notices beyond a failed call or two.
    let tunnelSession = pluginSession;
    let retunneling: Promise<string> | null = null;
    const ensureTunnel = (): Promise<string> => {
      retunneling ??= (async () => {
        const t = await transportFor(hostId);
        const sid = t.pluginSessionId;
        if (!sid) throw new Error('Claude host is not connected');
        if (sid !== tunnelSession) {
          await deps.plugin.remoteForwardOpen({ sessionId: sid, targetPort: port, remotePort });
          tunnelSession = sid;
        }
        return sid;
      })().finally(() => (retunneling = null));
      return retunneling;
    };

    const executor = new ClaudeExecutor({
      hosts: () => hosts.list(),
      isConnected: (id) => sessions.isConnected(id),
      exec: async (host, command) => sessions.exec(await hosts.decryptAuth(host), command),
      readFile: async (host, path, maxBytes) =>
        sessions.readFile(await hosts.decryptAuth(host), path, maxBytes),
      writeFile: async (host, path, content) =>
        sessions.writeFile(await hosts.decryptAuth(host), path, content),
      listDir: async (host, path) => sessions.listDir(await hosts.decryptAuth(host), path),
    });
    executor.setFocus(claudeFocus);

    // Transcripts: a write-through cache so core's sync store contract holds;
    // backfilled from kv per session via loadTranscript before resume.
    const indexStorage = await syncStorage(deps.kv, 'pear.claude.sessions');
    const transcripts = new Map<string, string>();

    const runtime = new ClaudeChatRuntime({
      storage: indexStorage,
      transcripts: {
        read: (id) => transcripts.get(id) ?? null,
        write: (id, data) => {
          transcripts.set(id, data);
          void deps.kv.set(`pear.claude.t.${id}`, data);
        },
      },
      emit: emitClaude,
      executor,
      createSession: (opts, onEvent) =>
        new SshChatSession({ plugin: deps.plugin, hub, dir, sessionId: ensureTunnel }, opts, onEvent),
    });
    runtime.setAutoApprove(claudeAutoApprove);
    if (claudeModel) runtime.setModel(claudeModel);
    // Lazy: the MCP SDK (with CJS ajv) is a heavy chunk only Claude needs.
    const { McpWebViewServer } = await import('./claude/mcp-handler');
    const mcp = new McpWebViewServer(deps.plugin, token, executor, runtime.bridge);
    activeClaudeHostId = hostId;
    return {
      runtime,
      executor,
      // No catch: a kv failure must fail the resume — proceeding with an
      // empty log would overwrite the stored transcript on the next turn.
      loadTranscript: async (id) => {
        if (transcripts.has(id)) return;
        const data = await deps.kv.get(`pear.claude.t.${id}`);
        if (data != null) transcripts.set(id, data);
      },
      dispose: () => {
        runtime.dispose();
        mcp.dispose();
        deps.plugin.remoteForwardClose({ sessionId: tunnelSession, remotePort }).catch(() => {});
        void deps.plugin.mcpStop();
      },
    };
  };

  const ensureClaude = (): Promise<ClaudeState> => {
    claudeState ??= buildClaude().catch((err: unknown) => {
      claudeState = null;
      throw err;
    });
    return claudeState;
  };

  /** Fire-and-forget onto an already-building runtime; a rejected build is
   *  swallowed here because it already surfaces via ensureClaude. */
  const withClaude = (fn: (s: ClaudeState) => void): void => {
    void claudeState?.then(fn).catch(() => {});
  };

  return {
    hosts: {
      list: async () => (await ready).hosts.listSanitized(),
      upsert: async (host) => (await ready).hosts.upsert(host),
      remove: async (id) => {
        const { hosts, groups, sessions } = await ready;
        sessions.disconnectHost(id);
        // Removing the Claude host: drop the runtime + tunnel, and clear the
        // sticky pick even when the runtime was never built this run — a
        // dangling id would fail every future chat with a confusing error.
        if (activeClaudeHostId === id) teardownClaude();
        if ((await deps.kv.get(CLAUDE_HOST_KEY)) === id) await deps.kv.set(CLAUDE_HOST_KEY, '');
        groups.removeHostRefs(id);
        await hosts.remove(id);
      },
      addLocal: notYet('This device cannot be a host'),
      probe: async (endpoint, timeoutMs = 4000): Promise<ProbeResult> => {
        try {
          const { ms } = await deps.plugin.probe({
            host: endpoint.addr,
            port: endpoint.port,
            timeoutMs,
          });
          return { ok: true, latencyMs: ms };
        } catch (e) {
          const detail = (e as { message?: string })?.message ?? String(e);
          const lower = detail.toLowerCase();
          const error = lower.includes('timed out') || lower.includes('timeout')
            ? 'timeout'
            : lower.includes('refused')
              ? 'refused'
              : lower.includes('unreachable') || lower.includes('no route')
                ? 'unreachable'
                : 'other';
          return { ok: false, error, detail };
        }
      },
    },
    hostGroups: {
      list: async () => (await ready).groups.list(),
      upsert: async (group) => (await ready).groups.upsert(group),
      remove: async (id) => (await ready).groups.remove(id),
      setMembership: async (hostId, groupId, member) =>
        (await ready).groups.setMembership(hostId, groupId, member),
    },
    term: {
      open: async (hostId, size, opts) => {
        const { sessions } = await ready;
        const cfg = await cfgFor(hostId, opts?.password);
        const handle = await sessions.openTerminal(cfg, size, { cwd: opts?.cwd });
        // Resilient sessions: if the host has tmux, attach-or-create a stable
        // per-host session so a screen-off/backgrounding disconnect doesn't
        // kill a running command (e.g. a package update) — reconnect
        // re-attaches to the same session. Env/cwd already ran in the outer
        // shell, so a freshly created tmux session inherits them.
        void wrapTerminalInTmux(sessions, cfg, handle.id);
        return handle.id;
      },
      write: (termId, data) => {
        void ready.then(({ sessions }) => sessions.writeTerminal(termId, data));
      },
      resize: (termId, size) => {
        void ready.then(({ sessions }) => sessions.resizeTerminal(termId, size));
      },
      close: (termId) => {
        void ready.then(({ sessions }) => sessions.closeTerminal(termId));
      },
      onData: (cb) => {
        termData.add(cb);
        return () => termData.delete(cb);
      },
      onExit: (cb) => {
        termExit.add(cb);
        return () => termExit.delete(cb);
      },
    },
    fs: {
      list: async (hostId, path, password) => {
        const { sessions } = await ready;
        return sessions.listDir(await cfgFor(hostId, password), path);
      },
      read: async (hostId, path) => {
        const { sessions } = await ready;
        return sessions.readFile(await cfgFor(hostId), path);
      },
      write: async (hostId, path, content) => {
        const { sessions } = await ready;
        return sessions.writeFile(await cfgFor(hostId), path, content);
      },
      upload: notYet('Uploads arrive in M6'),
      stat: async (hostId, path) => {
        const { sessions } = await ready;
        return sessions.stat(await cfgFor(hostId), path);
      },
      mkdir: async (hostId, path) => {
        const { sessions } = await ready;
        return sessions.mkdir(await cfgFor(hostId), path);
      },
      remove: async (hostId, path, recursive) => {
        const { sessions } = await ready;
        return sessions.remove(await cfgFor(hostId), path, recursive);
      },
      rename: async (hostId, oldPath, newPath) => {
        const { sessions } = await ready;
        return sessions.rename(await cfgFor(hostId), oldPath, newPath);
      },
      copy: async (hostId, src, dest) => {
        const { sessions } = await ready;
        return sessions.copy(await cfgFor(hostId), src, dest);
      },
    },
    transfers: {
      start: async (req) => transfers.start(req),
      // "Download to my device": stage on the phone, then publish every file
      // into the system Downloads collection (Download/Pear) when done.
      download: async (srcHostId, srcDir, names, conflict, verify) => {
        const staging = (await deps.plugin.makeStagingDir()).path;
        const id = transfers.start({
          src: { hostId: srcHostId, dir: srcDir },
          dest: { hostId: null, dir: staging },
          names,
          op: 'copy',
          conflict,
          verify,
        });
        downloadJobs.set(id, staging);
        return id;
      },
      cancel: (id) => transfers.cancel(id),
      list: async () => transfers.list(),
      clearFinished: () => transfers.clearFinished(),
      setMaxParallel: (n) => transfers.setMaxParallel(n),
      onUpdate: (cb) => {
        transferUpdates.add(cb);
        return () => transferUpdates.delete(cb);
      },
      // No OS file drag-drop on Android — uploads go through pickAndUpload.
      pathForFile: () => '',
    },
    subhosts: {
      // Sub-host *descent* (docker exec / pct enter into a container or guest)
      // is a separate, still-deferred feature — not the same as `via`/ProxyJump
      // (M5), which reaches a full SSH host through a jump and is supported.
      list: async () => [],
      jumpIn: notYet('Sub-host descent is not available on mobile yet'),
      jumpInVm: notYet('Sub-host descent is not available on mobile yet'),
      pin: notYet('Sub-host descent is not available on mobile yet'),
      unpin: notYet('Sub-host descent is not available on mobile yet'),
    },
    orch: {
      get: async (hostId) => {
        const { hosts, sessions } = await ready;
        const cfg = await cfgFor(hostId);
        // Detect every run — facet sets change (an engine starts, a node
        // joins a swarm). Persist the primary kind for the list glyphs,
        // mirroring desktop main.ts.
        const facets = await sessions.detectOrchFacets(cfg);
        const kind = primaryKind(facets);
        if (kind !== cfg.kind && !cfg.kindManual) await hosts.patch(hostId, { kind });
        return sessions.orchestration(cfg, facets);
      },
      action: async (hostId, action) => {
        const { sessions } = await ready;
        return sessions.orchAction(await cfgFor(hostId), action);
      },
      serviceTasks: async (hostId, service) => {
        const { sessions } = await ready;
        return sessions.serviceTasks(await cfgFor(hostId), service);
      },
      taskLogs: async (hostId, taskId, opts) => {
        const { sessions } = await ready;
        return sessions.taskLogs(await cfgFor(hostId), taskId, opts);
      },
    },
    monitor: {
      sample: async (hostId) => {
        const { sessions } = await ready;
        return sessions.vitals(await cfgFor(hostId));
      },
      dockerDf: async (hostId) => {
        const { sessions } = await ready;
        return sessions.dockerDf(await cfgFor(hostId));
      },
      stats: async (hostId) => {
        const { sessions } = await ready;
        return Object.fromEntries(await sessions.containerStats(await cfgFor(hostId)));
      },
    },
    history: {
      list: async () => (await ready).history.list(),
      record: (hostId, command) => {
        void ready.then(({ history }) => history.record(hostId, command));
      },
      importFromHost: async (hostId) => {
        const { history, sessions } = await ready;
        const cfg = await cfgFor(hostId);
        const result = await importShellHistory((path, maxBytes) =>
          sessions.readFile(cfg, path, maxBytes),
        );
        const added = history.importCommands(hostId, result.commands);
        return { added, files: result.files };
      },
      clear: async (hostId) => (await ready).history.clear(hostId),
    },
    claude: {
      open: notYet('Claude terminal mode is desktop-only — chat runs over SSH here'),
      status: async () => {
        const hostId = await deps.kv.get(CLAUDE_HOST_KEY);
        if (!hostId) return { installed: false, mcpReady: false };
        try {
          const transport = await transportFor(hostId);
          const result = await transport.exec(
            '"$SHELL" -lc \'command -v claude\' >/dev/null 2>&1 && echo yes || echo no',
          );
          return { installed: result.stdout.includes('yes'), mcpReady: claudeState !== null };
        } catch {
          return { installed: false, mcpReady: false };
        }
      },
      chatSend: async (text) => (await ensureClaude()).runtime.send(text),
      chatInterrupt: () => {
        withClaude((s) => s.runtime.interrupt());
      },
      chatAnswer: (requestId, answer) => {
        withClaude((s) => s.runtime.answer(requestId, answer));
      },
      chatSetAutoApprove: (on) => {
        claudeAutoApprove = on;
        withClaude((s) => s.runtime.setAutoApprove(on));
      },
      chatSetModel: (model) => {
        claudeModel = model;
        withClaude((s) => s.runtime.setModel(model));
      },
      chatSessions: async () => {
        try {
          const raw = await deps.kv.get('pear.claude.sessions');
          const metas = raw ? (JSON.parse(raw) as ClaudeSessionMeta[]) : [];
          return metas.sort((a, b) => b.lastUsedAt - a.lastUsedAt);
        } catch {
          return [];
        }
      },
      chatResume: async (sessionId) => {
        const s = await ensureClaude();
        await s.loadTranscript(sessionId);
        return s.runtime.resume(sessionId);
      },
      chatNew: async () => {
        // A rejected build means there is no conversation to reset; real
        // build errors surface via ensureClaude on send/resume.
        await claudeState?.then((s) => s.runtime.newSession()).catch(() => {});
      },
      setFocus: (focus) => {
        claudeFocus = focus;
        withClaude((s) => s.executor.setFocus(focus));
      },
      onEvent: (cb) => {
        claudeEvents.add(cb);
        return () => claudeEvents.delete(cb);
      },
      onUiRequest: () => () => {},
      uiRespond: () => {},
    },
    onHostDisconnected: (cb) => {
      hostDown.add(cb);
      return () => hostDown.delete(cb);
    },
    getClaudeHost: async () => (await deps.kv.get(CLAUDE_HOST_KEY)) || null,
    setClaudeHost: async (id) => {
      await deps.kv.set(CLAUDE_HOST_KEY, id ?? '');
      // Different host = different tunnel and workspace — tear down and
      // rebuild lazily on the next chat use.
      teardownClaude();
    },
    pickAndUpload: async (hostId, destDir) => {
      const picked = await deps.plugin.pickFiles();
      if (!picked.files.length) return null;
      const dir = picked.dir ?? picked.files[0].path.split('/').slice(0, -1).join('/');
      const id = transfers.start({
        src: { hostId: null, dir },
        dest: { hostId, dir: destDir },
        names: picked.files.map((f) => f.name),
        op: 'copy',
        conflict: 'rename',
        verify: false,
      });
      jobStaging.set(id, dir);
      return id;
    },
  };
}
