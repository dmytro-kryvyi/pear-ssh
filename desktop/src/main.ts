import { app, BrowserWindow, dialog, ipcMain, net, protocol } from 'electron';
import { hostname, userInfo } from 'node:os';
import { basename, dirname, join, normalize } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  EphemeralHostRegistry,
  HistoryStore,
  HostGroupStore,
  HostStore,
  SessionManager,
  TransferEngine,
  importShellHistory,
  parseGuestIp,
  primaryKind,
  probeCommand,
  probeError,
  sanitizeHost,
  type ClaudeFocus,
  type ClaudeUiRequestPayload,
  type ClaudeUiResponse,
  type ConflictPolicy,
  type HostConfig,
  type HostGroup,
  type OrchAction,
  type ShellChannel,
  type SubHostTarget,
  type TermSize,
  uuid,
  type TransferEndpoint,
  type TransferRequest,
} from '@pear/core';
import {
  ClaudeChatRuntime,
  ClaudeExecutor,
  JsonFileStorage,
  LocalConnection,
  PearMcpServer,
  PortForwardManager,
  SshConnection,
  claudeInstalled,
  launchClaudePty,
  loadSshConfigEntries,
  makeStagingDir,
  probeSsh,
  provisionClaudeWorkspace,
  removeStaging,
  sweepStaging,
} from '@pear/core/node';
import { SafeStorageCipher } from './secrets';

const UI_DIST = join(__dirname, '../../ui/dist/ui/browser');

// Transport hiccups from dropped links are handled by the disconnect flow;
// they must never surface as Electron's uncaught-exception modal. Anything
// non-network stays loud (logged + dialog), just under our control.
const NETWORK_ERROR =
  /ECONNRESET|ECONNREFUSED|ECONNABORTED|EPIPE|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ENETDOWN|ENOTFOUND|socket hang up|[Kk]eepalive timeout/;
process.on('uncaughtException', (err) => {
  if (NETWORK_ERROR.test(err.message)) {
    console.warn(`[net] ${err.message}`);
    return;
  }
  console.error(err);
  dialog.showErrorBox('Unexpected error', err.stack ?? String(err));
});

// Serve the built UI over a standard scheme instead of file:// — module web
// workers (Monaco) and fetch are blocked on file:// origins.
protocol.registerSchemesAsPrivileged([
  { scheme: 'pear', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

let win: BrowserWindow | null = null;

const userFile = (name: string) => new JsonFileStorage(join(app.getPath('userData'), name));
let hosts: HostStore;
let groups: HostGroupStore;
let history: HistoryStore;

// Session-scoped sub-hosts (jump-in targets). Anything hostId-keyed resolves
// through both stores; pinning just moves the entry into the persistent one.
const ephemeral = new EphemeralHostRegistry();
/**
 * Connect-time lookup: the single chokepoint where stored ciphertext becomes
 * plaintext auth. Every connection-opening path resolves through here; the
 * result is never returned to the renderer.
 */
const resolveHost = (id: string): HostConfig | undefined => {
  const h = hosts.get(id) ?? ephemeral.get(id);
  return h && hosts.decryptAuth(h);
};
/**
 * Configs that arrive as objects (Claude tool callbacks) are sanitized views
 * with the ciphertext stripped — re-resolve by id to get connectable auth.
 */
const withSecrets = (h: HostConfig): HostConfig => resolveHost(h.id) ?? h;

const sessions = new SessionManager(
  {
    onTermData: (termId, data) => win?.webContents.send('term:data', termId, data),
    onTermExit: (termId) => win?.webContents.send('term:exit', termId),
    onHostDisconnected: (hostId) => {
      // Unpinned sub-hosts don't outlive their parent's connection.
      for (const childId of ephemeral.removeByParent(hostId)) {
        win?.webContents.send('host:disconnected', childId);
      }
      forwards.closeForHost(hostId); // dead tunnels must not keep listening
      win?.webContents.send('host:disconnected', hostId);
    },
  },
  (config, jump) => {
    if (config.local) return new LocalConnection();
    if (config.via && !(jump instanceof SshConnection)) {
      throw new Error('Jump host must be a direct SSH connection');
    }
    return new SshConnection(config, jump instanceof SshConnection ? jump : undefined);
  },
  resolveHost,
);

// Private relay transport for the transfer engine's local side — never shown
// in the sidebar, independent of whether the user registered a local host.
let relay: LocalConnection | null = null;

const transfers = new TransferEngine(
  {
    async connection(hostId) {
      if (hostId === null) {
        if (!relay?.isConnected) {
          relay = new LocalConnection();
          await relay.connect();
        }
        return relay;
      }
      const host = resolveHost(hostId);
      if (!host) throw new Error(`Unknown host: ${hostId}`);
      return sessions.connection(host);
    },
    makeStagingDir,
    removeStaging,
  },
  { onUpdate: (job) => win?.webContents.send('transfer:update', job) },
);

// SSH port forwards opened by the Claude tools (loopback listeners piped into
// forwardOut legs). Torn down per-host on disconnect and wholesale on quit.
const forwards = new PortForwardManager((host) => sessions.connection(host));

/** Endpoints on a registered local host collapse to the relay side, so a
 *  local-host pane gets a 1-stage transfer instead of a pointless relay hop. */
function normalizeEndpoint(ep: TransferEndpoint): TransferEndpoint {
  if (ep.hostId === null) return ep;
  const host = resolveHost(ep.hostId);
  if (!host) throw new Error(`Unknown host: ${ep.hostId}`);
  return host.local ? { hostId: null, dir: ep.dir } : ep;
}

// Claude Code integration: a loopback MCP server exposing the pear tools, and
// a workspace dir the (user-installed, self-authenticated) claude CLI runs in.
// Failure is non-fatal — the dock just reports tools as unavailable.
let claudeMcp: PearMcpServer | null = null;
let claudeChat: ClaudeChatRuntime | null = null;
let claudeExecutor: ClaudeExecutor | null = null;
const claudeDir = () => join(app.getPath('userData'), 'claude');
// Claude PTYs are local channels outside SessionManager (no host attached);
// they share the term:* streaming channels via this side table.
const claudeTerms = new Map<string, ShellChannel>();

// Main → renderer round-trips for the UI-facing MCP tools (read_terminal,
// reveal_in_app). The timeout only fires when the renderer is gone or
// reloading — handlers themselves are synchronous signal work.
const UI_REQUEST_TIMEOUT_MS = 5_000;
const pendingUi = new Map<
  string,
  { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
>();

function claudeUiRequest(payload: ClaudeUiRequestPayload): Promise<unknown> {
  if (!win || win.isDestroyed()) return Promise.reject(new Error('Pear window is not open'));
  const id = uuid();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingUi.delete(id);
      reject(new Error('Pear UI did not respond (window busy or reloading)'));
    }, UI_REQUEST_TIMEOUT_MS);
    pendingUi.set(id, { resolve, reject, timer });
    win?.webContents.send('claude:uiRequest', { id, payload });
  });
}

function rejectPendingUi(reason: string): void {
  for (const [, p] of pendingUi) {
    clearTimeout(p.timer);
    p.reject(new Error(reason));
  }
  pendingUi.clear();
}

async function startClaudeIntegration(): Promise<void> {
  try {
    const executor = new ClaudeExecutor({
      hosts: () => [...hosts.listSanitized(), ...ephemeral.list().map(sanitizeHost)],
      isConnected: (id) => sessions.isConnected(id),
      // Configs flowing back in from the executor are sanitized views — put
      // the decrypted auth back before they reach a connection.
      exec: (host, command) => sessions.exec(withSecrets(host), command),
      readFile: (host, path, maxBytes) => sessions.readFile(withSecrets(host), path, maxBytes),
      writeFile: (host, path, content) => sessions.writeFile(withSecrets(host), path, content),
      listDir: (host, path) => sessions.listDir(withSecrets(host), path),
      uiRequest: (payload) => claudeUiRequest(payload),
      startTransfer: (req) =>
        transfers.start({
          ...req,
          src: normalizeEndpoint(req.src),
          dest: normalizeEndpoint(req.dest),
        }),
      transferList: () => transfers.list(),
      openForward: (host, remotePort, remoteHost, localPort) =>
        forwards.open(withSecrets(host), remotePort, remoteHost, localPort),
      listForwards: () => forwards.list(),
      closeForward: (id) => forwards.close(id),
    });
    claudeExecutor = executor;
    claudeChat = new ClaudeChatRuntime({
      dir: claudeDir(),
      storage: userFile('claude-sessions.json'),
      emit: (event) => win?.webContents.send('claude:event', event),
      executor,
    });
    claudeMcp = new PearMcpServer(executor, claudeChat.bridge);
    const info = await claudeMcp.start();
    await provisionClaudeWorkspace({ dir: claudeDir(), url: info.url, token: info.token });
  } catch (err) {
    claudeMcp = null;
    console.warn('[claude] MCP integration unavailable:', err instanceof Error ? err.message : err);
  }
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 900,
    minHeight: 560,
    backgroundColor: '#202329',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
    },
  });

  const devUrl = process.env.PEAR_DEV_URL;
  if (devUrl) {
    void win.loadURL(devUrl);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    void win.loadURL('pear://ui/index.html');
  }
  win.on('closed', () => {
    win = null;
    rejectPendingUi('Pear window was closed');
  });
}

function registerUiProtocol(): void {
  protocol.handle('pear', (request) => {
    const { pathname } = new URL(request.url);
    const relative = normalize(decodeURIComponent(pathname)).replace(/^([/\\]|\.\.)+/, '');
    const file = join(UI_DIST, relative || 'index.html');
    if (!file.startsWith(UI_DIST)) {
      return new Response('Forbidden', { status: 403 });
    }
    return net.fetch(pathToFileURL(file).toString());
  });
}

/** Remove a host and every descendant sub-host, persisted or ephemeral. */
function removeHostTree(id: string): void {
  for (const child of hosts.list().filter((h) => h.parentId === id)) {
    removeHostTree(child.id);
  }
  for (const childId of ephemeral.removeByParent(id)) {
    sessions.disconnectHost(childId);
  }
  sessions.disconnectHost(id);
  if (ephemeral.get(id)) ephemeral.remove(id);
  else hosts.remove(id);
}

function registerIpc(): void {
  ipcMain.handle('hosts:list', () => hosts.listSanitized());
  ipcMain.handle('hosts:upsert', (_e, host: Omit<HostConfig, 'id'> & { id?: string }) =>
    hosts.upsert(host),
  );
  ipcMain.handle('hosts:remove', (_e, id: string) => {
    removeHostTree(id);
    groups.removeHostRefs(id);
  });
  ipcMain.handle('hosts:addLocal', () => {
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
  ipcMain.handle('hosts:sshConfigEntries', () => loadSshConfigEntries());
  // Never rejects — routine dead-endpoint probes must not trip Electron's
  // rejected-handler logging (same rationale as the monitor envelope).
  ipcMain.handle(
    'hosts:probe',
    (_e, endpoint: { addr: string; port: number }, timeoutMs?: number) =>
      probeSsh(endpoint.addr, endpoint.port, timeoutMs),
  );

  ipcMain.handle('hostgroups:list', () => groups.list());
  ipcMain.handle('hostgroups:upsert', (_e, group: Omit<HostGroup, 'id'> & { id?: string }) =>
    groups.upsert(group),
  );
  ipcMain.handle('hostgroups:remove', (_e, id: string) => groups.remove(id));
  ipcMain.handle('hostgroups:setMembership', (_e, hostId: string, groupId: string, member: boolean) =>
    groups.setMembership(hostId, groupId, member),
  );

  ipcMain.handle(
    'term:open',
    async (_e, hostId: string, size: TermSize, opts?: { password?: string; cwd?: string }) => {
      const host = resolveHost(hostId);
      if (!host) throw new Error(`Unknown host: ${hostId}`);
      const config = opts?.password
        ? { ...host, auth: { ...host.auth, password: opts.password } }
        : host;
      const handle = await sessions.openTerminal(config, size, { cwd: opts?.cwd });
      return handle.id;
    },
  );
  ipcMain.on('term:write', (_e, termId: string, data: string) => {
    const claude = claudeTerms.get(termId);
    if (claude) return claude.write(data);
    sessions.writeTerminal(termId, data);
  });
  ipcMain.on('term:resize', (_e, termId: string, size: TermSize) => {
    const claude = claudeTerms.get(termId);
    if (claude) return claude.resize(size);
    sessions.resizeTerminal(termId, size);
  });
  ipcMain.on('term:close', (_e, termId: string) => {
    const claude = claudeTerms.get(termId);
    if (claude) return claude.close();
    sessions.closeTerminal(termId);
  });

  ipcMain.handle('claude:open', (_e, size: TermSize) => {
    const channel = launchClaudePty(claudeDir(), size);
    const id = uuid();
    claudeTerms.set(id, channel);
    channel.onData((data) => win?.webContents.send('term:data', id, data));
    channel.onClose(() => {
      if (claudeTerms.delete(id)) win?.webContents.send('term:exit', id);
    });
    return id;
  });
  ipcMain.handle('claude:status', async () => ({
    installed: await claudeInstalled(),
    mcpReady: claudeMcp !== null,
  }));
  ipcMain.handle('claude:chatSend', (_e, text: string) => {
    if (!claudeChat) throw new Error('Claude integration unavailable');
    claudeChat.send(text);
  });
  ipcMain.on('claude:chatInterrupt', () => claudeChat?.interrupt());
  ipcMain.on('claude:chatAnswer', (_e, requestId: string, answer) =>
    claudeChat?.answer(requestId, answer),
  );
  ipcMain.on('claude:chatAutoApprove', (_e, on: boolean) => claudeChat?.setAutoApprove(on));
  ipcMain.on('claude:chatModel', (_e, model: string | null) =>
    claudeChat?.setModel(typeof model === 'string' && model ? model : null),
  );
  ipcMain.handle('claude:chatSessions', () => claudeChat?.sessions() ?? []);
  ipcMain.handle('claude:chatResume', (_e, sessionId: string) =>
    claudeChat?.resume(sessionId) ?? [],
  );
  ipcMain.handle('claude:chatNew', () => claudeChat?.newSession());
  ipcMain.on('claude:uiResponse', (_e, r: ClaudeUiResponse) => {
    const p = pendingUi.get(r.id);
    if (!p) return; // stale reply after timeout or reload
    pendingUi.delete(r.id);
    clearTimeout(p.timer);
    if (r.ok) p.resolve(r.value);
    else p.reject(new Error(r.error));
  });
  ipcMain.on('claude:focus', (_e, focus: ClaudeFocus | null) =>
    claudeExecutor?.setFocus(
      focus && typeof focus.hostId === 'string'
        ? { hostId: focus.hostId, ...(typeof focus.path === 'string' ? { path: focus.path } : {}) }
        : null,
    ),
  );

  ipcMain.handle('fs:list', (_e, hostId: string, path: string, password?: string) => {
    const host = resolveHost(hostId);
    if (!host) throw new Error(`Unknown host: ${hostId}`);
    const config = password ? { ...host, auth: { ...host.auth, password } } : host;
    return sessions.listDir(config, path);
  });
  ipcMain.handle('fs:stat', (_e, hostId: string, path: string) => {
    const host = resolveHost(hostId);
    if (!host) throw new Error(`Unknown host: ${hostId}`);
    return sessions.stat(host, path);
  });
  ipcMain.handle('fs:mkdir', (_e, hostId: string, path: string) => {
    const host = resolveHost(hostId);
    if (!host) throw new Error(`Unknown host: ${hostId}`);
    return sessions.mkdir(host, path);
  });
  ipcMain.handle('fs:remove', (_e, hostId: string, path: string, recursive?: boolean) => {
    const host = resolveHost(hostId);
    if (!host) throw new Error(`Unknown host: ${hostId}`);
    return sessions.remove(host, path, recursive);
  });
  ipcMain.handle('fs:rename', (_e, hostId: string, oldPath: string, newPath: string) => {
    const host = resolveHost(hostId);
    if (!host) throw new Error(`Unknown host: ${hostId}`);
    return sessions.rename(host, oldPath, newPath);
  });
  ipcMain.handle('fs:copy', (_e, hostId: string, src: string, dest: string) => {
    const host = resolveHost(hostId);
    if (!host) throw new Error(`Unknown host: ${hostId}`);
    return sessions.copy(host, src, dest);
  });
  ipcMain.handle('fs:read', (_e, hostId: string, path: string) => {
    const host = resolveHost(hostId);
    if (!host) throw new Error(`Unknown host: ${hostId}`);
    return sessions.readFile(host, path);
  });
  ipcMain.handle('fs:write', (_e, hostId: string, path: string, content: string) => {
    const host = resolveHost(hostId);
    if (!host) throw new Error(`Unknown host: ${hostId}`);
    return sessions.writeFile(host, path, content);
  });
  ipcMain.handle('orch:get', async (_e, hostId: string) => {
    const host = resolveHost(hostId);
    if (!host) throw new Error(`Unknown host: ${hostId}`);
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
  ipcMain.handle('orch:action', (_e, hostId: string, action: OrchAction) => {
    const host = resolveHost(hostId);
    if (!host) throw new Error(`Unknown host: ${hostId}`);
    return sessions.orchAction(host, action);
  });
  ipcMain.handle('orch:serviceTasks', (_e, hostId: string, service: string) => {
    const host = resolveHost(hostId);
    if (!host) throw new Error(`Unknown host: ${hostId}`);
    return sessions.serviceTasks(host, service);
  });
  ipcMain.handle(
    'orch:taskLogs',
    (_e, hostId: string, taskId: string, opts?: { tail?: number; since?: string }) => {
      const host = resolveHost(hostId);
      if (!host) throw new Error(`Unknown host: ${hostId}`);
      return sessions.taskLogs(host, taskId, opts);
    },
  );
  // Monitor handlers run on every poll tick, and a dropped link makes their
  // in-flight execs fail routinely — expected, already counted by the
  // renderer's MonitorStore. Rejecting across IPC would make Electron log
  // "Error occurred in handler" for each one, so failures travel as an
  // envelope instead; the preload unwraps it back into a rejection.
  const enveloped = (fn: (host: HostConfig) => Promise<unknown>) => {
    return async (_e: unknown, hostId: string) => {
      try {
        const host = resolveHost(hostId);
        if (!host) throw new Error(`Unknown host: ${hostId}`);
        return { ok: true, value: await fn(host) };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    };
  };
  ipcMain.handle('monitor:sample', enveloped((host) => sessions.vitals(host)));
  ipcMain.handle('monitor:dockerDf', enveloped((host) => sessions.dockerDf(host)));
  ipcMain.handle(
    'monitor:stats',
    enveloped(async (host) => Object.fromEntries(await sessions.containerStats(host))),
  );

  ipcMain.handle('subhosts:list', () => ephemeral.list().map(sanitizeHost));
  ipcMain.handle(
    'subhosts:jumpIn',
    async (_e, parentId: string, target: SubHostTarget, name: string) => {
      const parent = resolveHost(parentId);
      if (!parent) throw new Error(`Unknown host: ${parentId}`);
      const probe = await sessions.exec(parent, probeCommand(target));
      if (probe.code !== 0) throw new Error(probeError(target, probe));
      const user = probe.stdout.trim().split('\n').pop()?.trim() || 'root';
      return ephemeral.add({
        name,
        host: parent.host,
        port: parent.port,
        user,
        kind: 'plain',
        parentId,
        target,
      });
    },
  );
  ipcMain.handle('subhosts:pin', (_e, id: string) => {
    const cfg = ephemeral.get(id);
    if (!cfg) throw new Error(`Unknown sub-host: ${id}`);
    const saved = hosts.upsert(cfg);
    ephemeral.remove(id);
    return saved;
  });
  ipcMain.handle('subhosts:unpin', (_e, id: string) => {
    const cfg = hosts.get(id);
    if (!cfg?.parentId && !cfg?.via) throw new Error(`Not a pinned sub-host: ${id}`);
    hosts.remove(id);
    groups.removeHostRefs(id);
    return sanitizeHost(ephemeral.add(cfg));
  });
  ipcMain.handle(
    'subhosts:jumpInVm',
    async (_e, parentId: string, vmid: number, name: string) => {
      const parent = resolveHost(parentId);
      if (!parent) throw new Error(`Unknown host: ${parentId}`);
      const result = await sessions.exec(
        parent,
        `qm guest cmd ${Number(vmid)} network-get-interfaces`,
      );
      if (result.code !== 0) {
        throw new Error('Guest agent not responding — is qemu-guest-agent installed and running?');
      }
      const ip = parseGuestIp(result.stdout);
      if (!ip) throw new Error('Guest agent reported no usable IP address');
      return ephemeral.add({ name, host: ip, port: 22, user: 'root', kind: 'plain', via: parentId });
    },
  );

  ipcMain.handle('history:list', () => history.list());
  ipcMain.on('history:record', (_e, hostId: string, command: string) =>
    history.record(hostId, command),
  );
  ipcMain.handle('history:clear', (_e, hostId?: string) => history.clear(hostId));
  // Only ever reached because the renderer's "scan remote shell history"
  // setting is on — the main process never scans a host by itself.
  ipcMain.handle('history:import', async (_e, hostId: string) => {
    const host = resolveHost(hostId);
    if (!host) throw new Error(`Unknown host: ${hostId}`);
    const { files, commands } = await importShellHistory((path, maxBytes) =>
      sessions.readFile(host, path, maxBytes),
    );
    return { added: history.importCommands(hostId, commands), files };
  });

  ipcMain.handle(
    'fs:upload',
    async (_e, hostId: string, remoteDir: string, conflict: ConflictPolicy, verify: boolean) => {
      const host = resolveHost(hostId);
      if (!host) throw new Error(`Unknown host: ${hostId}`);
      if (!win) return;
      const picked = await dialog.showOpenDialog(win, {
        title: `Upload to ${host.name}:${remoteDir}`,
        properties: ['openFile', 'multiSelections'],
      });
      if (picked.canceled) return;
      // One transfer job per source directory (usually exactly one).
      const byDir = new Map<string, string[]>();
      for (const localPath of picked.filePaths) {
        const dir = dirname(localPath);
        byDir.set(dir, [...(byDir.get(dir) ?? []), basename(localPath)]);
      }
      for (const [dir, names] of byDir) {
        transfers.start({
          src: { hostId: null, dir },
          dest: normalizeEndpoint({ hostId, dir: remoteDir }),
          names,
          op: 'copy',
          conflict,
          verify,
        });
      }
    },
  );

  ipcMain.handle('transfers:start', (_e, req: TransferRequest) =>
    transfers.start({
      ...req,
      src: normalizeEndpoint(req.src),
      dest: normalizeEndpoint(req.dest),
    }),
  );
  ipcMain.handle(
    'transfers:download',
    (
      _e,
      srcHostId: string,
      srcDir: string,
      names: string[],
      conflict: ConflictPolicy,
      verify: boolean,
    ) =>
      transfers.start({
        src: normalizeEndpoint({ hostId: srcHostId, dir: srcDir }),
        dest: { hostId: null, dir: app.getPath('downloads') },
        names,
        op: 'copy',
        conflict,
        verify,
      }),
  );
  ipcMain.on('transfers:cancel', (_e, id: string) => transfers.cancel(id));
  ipcMain.handle('transfers:list', () => transfers.list());
  ipcMain.on('transfers:clearFinished', () => transfers.clearFinished());
  ipcMain.on('transfers:setMaxParallel', (_e, n: number) => transfers.setMaxParallel(n));
}

app.whenReady().then(() => {
  // safeStorage needs the app to be ready before it can report a backend.
  hosts = new HostStore(userFile('hosts.json'), new SafeStorageCipher());
  groups = new HostGroupStore(userFile('workspaces.json'));
  history = new HistoryStore(userFile('history.json'));
  void sweepStaging();
  registerUiProtocol();
  registerIpc();
  void startClaudeIntegration();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  forwards.disposeAll();
  sessions.disposeAll();
  for (const channel of claudeTerms.values()) channel.close();
  claudeTerms.clear();
  claudeChat?.dispose();
  claudeChat = null;
  void claudeMcp?.stop();
  claudeMcp = null;
  if (process.platform !== 'darwin') app.quit();
});
