import { app, BrowserWindow, dialog, ipcMain, net, protocol } from 'electron';
import { hostname, userInfo } from 'node:os';
import { basename, dirname, join, normalize } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  EphemeralHostRegistry,
  HistoryStore,
  HostStore,
  SessionManager,
  TransferEngine,
  importShellHistory,
  parseGuestIp,
  primaryKind,
  probeCommand,
  probeError,
  type ConflictPolicy,
  type HostConfig,
  type OrchAction,
  type SubHostTarget,
  type TermSize,
  type TransferEndpoint,
  type TransferRequest,
} from '@pear/core';
import {
  JsonFileStorage,
  LocalConnection,
  SshConnection,
  makeStagingDir,
  removeStaging,
  sweepStaging,
} from '@pear/core/node';

const UI_DIST = join(__dirname, '../../ui/dist/ui/browser');

// Serve the built UI over a standard scheme instead of file:// — module web
// workers (Monaco) and fetch are blocked on file:// origins.
protocol.registerSchemesAsPrivileged([
  { scheme: 'pear', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

let win: BrowserWindow | null = null;

const userFile = (name: string) => new JsonFileStorage(join(app.getPath('userData'), name));
let hosts: HostStore;
let history: HistoryStore;

// Session-scoped sub-hosts (jump-in targets). Anything hostId-keyed resolves
// through both stores; pinning just moves the entry into the persistent one.
const ephemeral = new EphemeralHostRegistry();
const resolveHost = (id: string): HostConfig | undefined => hosts.get(id) ?? ephemeral.get(id);

const sessions = new SessionManager(
  {
    onTermData: (termId, data) => win?.webContents.send('term:data', termId, data),
    onTermExit: (termId) => win?.webContents.send('term:exit', termId),
    onHostDisconnected: (hostId) => {
      // Unpinned sub-hosts don't outlive their parent's connection.
      for (const childId of ephemeral.removeByParent(hostId)) {
        win?.webContents.send('host:disconnected', childId);
      }
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

/** Endpoints on a registered local host collapse to the relay side, so a
 *  local-host pane gets a 1-stage transfer instead of a pointless relay hop. */
function normalizeEndpoint(ep: TransferEndpoint): TransferEndpoint {
  if (ep.hostId === null) return ep;
  const host = resolveHost(ep.hostId);
  if (!host) throw new Error(`Unknown host: ${ep.hostId}`);
  return host.local ? { hostId: null, dir: ep.dir } : ep;
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
  win.on('closed', () => (win = null));
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
  ipcMain.handle('hosts:list', () => hosts.list());
  ipcMain.handle('hosts:upsert', (_e, host: Omit<HostConfig, 'id'> & { id?: string }) =>
    hosts.upsert(host),
  );
  ipcMain.handle('hosts:remove', (_e, id: string) => removeHostTree(id));
  ipcMain.handle('hosts:addLocal', () => {
    const existing = hosts.list().find((h) => h.local);
    if (existing) return existing;
    return hosts.upsert({
      name: hostname(),
      host: 'localhost',
      port: 0,
      user: userInfo().username,
      kind: 'plain',
      local: true,
    });
  });

  ipcMain.handle('term:open', async (_e, hostId: string, size: TermSize, password?: string) => {
    const host = resolveHost(hostId);
    if (!host) throw new Error(`Unknown host: ${hostId}`);
    const config = password ? { ...host, auth: { ...host.auth, password } } : host;
    const handle = await sessions.openTerminal(config, size);
    return handle.id;
  });
  ipcMain.on('term:write', (_e, termId: string, data: string) =>
    sessions.writeTerminal(termId, data),
  );
  ipcMain.on('term:resize', (_e, termId: string, size: TermSize) =>
    sessions.resizeTerminal(termId, size),
  );
  ipcMain.on('term:close', (_e, termId: string) => sessions.closeTerminal(termId));

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
    if (kind !== host.kind) {
      // Never upsert an ephemeral sub-host into the persistent store.
      if (hosts.get(host.id)) hosts.upsert({ ...host, kind });
      else ephemeral.update({ ...host, kind });
    }
    return sessions.orchestration(host, facets);
  });
  ipcMain.handle('orch:action', (_e, hostId: string, action: OrchAction) => {
    const host = resolveHost(hostId);
    if (!host) throw new Error(`Unknown host: ${hostId}`);
    return sessions.orchAction(host, action);
  });

  ipcMain.handle('subhosts:list', () => ephemeral.list());
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
    if (!cfg?.parentId) throw new Error(`Not a pinned sub-host: ${id}`);
    hosts.remove(id);
    return ephemeral.add(cfg);
  });
  ipcMain.handle('subhosts:vmIp', async (_e, hostId: string, vmid: number) => {
    const host = resolveHost(hostId);
    if (!host) throw new Error(`Unknown host: ${hostId}`);
    const result = await sessions.exec(
      host,
      `qm guest cmd ${Number(vmid)} network-get-interfaces`,
    );
    if (result.code !== 0) {
      throw new Error('Guest agent not responding — is qemu-guest-agent installed and running?');
    }
    const ip = parseGuestIp(result.stdout);
    if (!ip) throw new Error('Guest agent reported no usable IP address');
    return ip;
  });

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
    async (_e, hostId: string, remoteDir: string, conflict: ConflictPolicy) => {
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
    (_e, srcHostId: string, srcDir: string, names: string[], conflict: ConflictPolicy) =>
      transfers.start({
        src: normalizeEndpoint({ hostId: srcHostId, dir: srcDir }),
        dest: { hostId: null, dir: app.getPath('downloads') },
        names,
        op: 'copy',
        conflict,
      }),
  );
  ipcMain.on('transfers:cancel', (_e, id: string) => transfers.cancel(id));
  ipcMain.handle('transfers:list', () => transfers.list());
  ipcMain.on('transfers:clearFinished', () => transfers.clearFinished());
  ipcMain.on('transfers:setMaxParallel', (_e, n: number) => transfers.setMaxParallel(n));
}

app.whenReady().then(() => {
  hosts = new HostStore(userFile('hosts.json'));
  history = new HistoryStore(userFile('history.json'));
  void sweepStaging();
  registerUiProtocol();
  registerIpc();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  sessions.disposeAll();
  if (process.platform !== 'darwin') app.quit();
});
