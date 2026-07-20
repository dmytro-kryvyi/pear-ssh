import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type {
  ConflictPolicy,
  HostConfig,
  OrchAction,
  PearApi,
  SubHostTarget,
  TermSize,
  TransferRequest,
} from '@pear/core';

function subscribe(channel: string, cb: (...args: any[]) => void): () => void {
  const listener = (_e: unknown, ...args: any[]) => cb(...args);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api: PearApi = {
  hosts: {
    list: () => ipcRenderer.invoke('hosts:list'),
    upsert: (host: Omit<HostConfig, 'id'> & { id?: string }) =>
      ipcRenderer.invoke('hosts:upsert', host),
    remove: (id: string) => ipcRenderer.invoke('hosts:remove', id),
    addLocal: () => ipcRenderer.invoke('hosts:addLocal'),
  },
  term: {
    open: (hostId: string, size: TermSize, password?: string) =>
      ipcRenderer.invoke('term:open', hostId, size, password),
    write: (termId: string, data: string) => ipcRenderer.send('term:write', termId, data),
    resize: (termId: string, size: TermSize) => ipcRenderer.send('term:resize', termId, size),
    close: (termId: string) => ipcRenderer.send('term:close', termId),
    onData: (cb) => subscribe('term:data', cb),
    onExit: (cb) => subscribe('term:exit', cb),
  },
  fs: {
    list: (hostId: string, path: string, password?: string) =>
      ipcRenderer.invoke('fs:list', hostId, path, password),
    read: (hostId: string, path: string) => ipcRenderer.invoke('fs:read', hostId, path),
    write: (hostId: string, path: string, content: string) =>
      ipcRenderer.invoke('fs:write', hostId, path, content),
    upload: (hostId: string, remoteDir: string, conflict: ConflictPolicy) =>
      ipcRenderer.invoke('fs:upload', hostId, remoteDir, conflict),
    stat: (hostId: string, path: string) => ipcRenderer.invoke('fs:stat', hostId, path),
    mkdir: (hostId: string, path: string) => ipcRenderer.invoke('fs:mkdir', hostId, path),
    remove: (hostId: string, path: string, recursive?: boolean) =>
      ipcRenderer.invoke('fs:remove', hostId, path, recursive),
    rename: (hostId: string, oldPath: string, newPath: string) =>
      ipcRenderer.invoke('fs:rename', hostId, oldPath, newPath),
    copy: (hostId: string, src: string, dest: string) =>
      ipcRenderer.invoke('fs:copy', hostId, src, dest),
  },
  transfers: {
    start: (req: TransferRequest) => ipcRenderer.invoke('transfers:start', req),
    download: (srcHostId: string, srcDir: string, names: string[], conflict: ConflictPolicy) =>
      ipcRenderer.invoke('transfers:download', srcHostId, srcDir, names, conflict),
    cancel: (id: string) => ipcRenderer.send('transfers:cancel', id),
    list: () => ipcRenderer.invoke('transfers:list'),
    clearFinished: () => ipcRenderer.send('transfers:clearFinished'),
    setMaxParallel: (n: number) => ipcRenderer.send('transfers:setMaxParallel', n),
    onUpdate: (cb) => subscribe('transfer:update', cb),
    pathForFile: (file: unknown) => webUtils.getPathForFile(file as File),
  },
  subhosts: {
    list: () => ipcRenderer.invoke('subhosts:list'),
    jumpIn: (parentId: string, target: SubHostTarget, name: string) =>
      ipcRenderer.invoke('subhosts:jumpIn', parentId, target, name),
    pin: (id: string) => ipcRenderer.invoke('subhosts:pin', id),
    unpin: (id: string) => ipcRenderer.invoke('subhosts:unpin', id),
    vmIp: (hostId: string, vmid: number) => ipcRenderer.invoke('subhosts:vmIp', hostId, vmid),
  },
  orch: {
    get: (hostId: string) => ipcRenderer.invoke('orch:get', hostId),
    action: (hostId: string, action: OrchAction) =>
      ipcRenderer.invoke('orch:action', hostId, action),
  },
  history: {
    list: () => ipcRenderer.invoke('history:list'),
    record: (hostId: string, command: string) =>
      ipcRenderer.send('history:record', hostId, command),
    importFromHost: (hostId: string) => ipcRenderer.invoke('history:import', hostId),
    clear: (hostId?: string) => ipcRenderer.invoke('history:clear', hostId),
  },
  onHostDisconnected: (cb) => subscribe('host:disconnected', cb),
};

contextBridge.exposeInMainWorld('pear', api);
