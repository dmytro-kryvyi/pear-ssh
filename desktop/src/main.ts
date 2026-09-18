import { app, BrowserWindow, dialog, ipcMain, net, protocol } from 'electron';
import { join, normalize } from 'node:path';
import { pathToFileURL } from 'node:url';
import { channelsOf, type ConflictPolicy } from '@pear/core';
import { PearService } from '@pear/core/node';
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
    service.rejectPendingUi('Pear window was closed');
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

// Everything behind PearApi lives in core's PearService (shared with
// pear-server); this file only adapts it to Electron: ipcMain in, webContents
// out, and the two things only a desktop shell can do — a native file picker
// and the OS keychain.
let service: PearService;

// Monitor handlers run on every poll tick, and a dropped link makes their
// in-flight execs fail routinely — expected, already counted by the
// renderer's MonitorStore. Rejecting across IPC would make Electron log
// "Error occurred in handler" for each one, so failures travel as an
// envelope instead; the preload unwraps it back into a rejection.
const ENVELOPED = new Set(['monitor:sample', 'monitor:dockerDf', 'monitor:stats']);

function registerIpc(): void {
  for (const channel of channelsOf('invoke')) {
    if (ENVELOPED.has(channel)) {
      ipcMain.handle(channel, async (_e, ...args: unknown[]) => {
        try {
          return { ok: true, value: await service.invoke(channel, args) };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      });
    } else {
      ipcMain.handle(channel, (_e, ...args: unknown[]) => service.invoke(channel, args));
    }
  }
  for (const channel of channelsOf('send')) {
    ipcMain.on(channel, (_e, ...args: unknown[]) => service.send(channel, args));
  }
}

app.whenReady().then(() => {
  // safeStorage needs the app to be ready before it can report a backend.
  service = new PearService({
    dataDir: app.getPath('userData'),
    cipher: new SafeStorageCipher(),
    downloadsDir: app.getPath('downloads'),
    emit: (channel, ...args) => win?.webContents.send(channel, ...args),
    sendUiRequest: (request) => {
      if (!win || win.isDestroyed()) return false;
      win.webContents.send('claude:uiRequest', request);
      return true;
    },
  });
  service.override('fs:upload', async ([hostId, remoteDir, conflict, verify]) => {
    const host = service.requireHost(hostId);
    if (!win) return;
    const picked = await dialog.showOpenDialog(win, {
      title: `Upload to ${host.name}:${String(remoteDir)}`,
      properties: ['openFile', 'multiSelections'],
    });
    if (picked.canceled) return;
    await service.startLocalUpload(
      host.id,
      String(remoteDir),
      picked.filePaths,
      conflict as ConflictPolicy,
      verify === true,
    );
  });
  registerUiProtocol();
  registerIpc();
  void service.start();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  void service.dispose();
  if (process.platform !== 'darwin') app.quit();
});
