import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type {
  ClaudeFocus,
  ClaudePermissionAnswer,
  ClaudeUiResponse,
  ArchiveFormat,
  ConflictPolicy,
  HostConfig,
  HostGroup,
  OrchAction,
  PearApi,
  PermsChange,
  SubHostTarget,
  TermSize,
  TransferRequest,
} from '@pear/core';

function subscribe(channel: string, cb: (...args: any[]) => void): () => void {
  const listener = (_e: unknown, ...args: any[]) => cb(...args);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

/** Monitor handlers reply with {ok, value|error} so routine poll failures
 *  don't hit Electron's rejected-handler logging; rebuild the rejection here. */
async function unwrap<T>(reply: Promise<{ ok: boolean; value?: T; error?: string }>): Promise<T> {
  const r = await reply;
  if (!r.ok) throw new Error(r.error ?? 'unknown error');
  return r.value as T;
}

const api: PearApi = {
  hosts: {
    list: () => ipcRenderer.invoke('hosts:list'),
    upsert: (host: Omit<HostConfig, 'id'> & { id?: string }) =>
      ipcRenderer.invoke('hosts:upsert', host),
    remove: (id: string) => ipcRenderer.invoke('hosts:remove', id),
    addLocal: () => ipcRenderer.invoke('hosts:addLocal'),
    sshConfigEntries: () => ipcRenderer.invoke('hosts:sshConfigEntries'),
    probe: (endpoint: { addr: string; port: number }, timeoutMs?: number) =>
      ipcRenderer.invoke('hosts:probe', endpoint, timeoutMs),
  },
  hostGroups: {
    list: () => ipcRenderer.invoke('hostgroups:list'),
    upsert: (group: Omit<HostGroup, 'id'> & { id?: string }) =>
      ipcRenderer.invoke('hostgroups:upsert', group),
    remove: (id: string) => ipcRenderer.invoke('hostgroups:remove', id),
    setMembership: (hostId: string, groupId: string, member: boolean) =>
      ipcRenderer.invoke('hostgroups:setMembership', hostId, groupId, member),
  },
  term: {
    open: (hostId: string, size: TermSize, opts?: { password?: string; cwd?: string }) =>
      ipcRenderer.invoke('term:open', hostId, size, opts),
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
    upload: (hostId: string, remoteDir: string, conflict: ConflictPolicy, verify: boolean) =>
      ipcRenderer.invoke('fs:upload', hostId, remoteDir, conflict, verify),
    stat: (hostId: string, path: string) => ipcRenderer.invoke('fs:stat', hostId, path),
    mkdir: (hostId: string, path: string) => ipcRenderer.invoke('fs:mkdir', hostId, path),
    remove: (hostId: string, path: string, recursive?: boolean) =>
      ipcRenderer.invoke('fs:remove', hostId, path, recursive),
    rename: (hostId: string, oldPath: string, newPath: string) =>
      ipcRenderer.invoke('fs:rename', hostId, oldPath, newPath),
    copy: (hostId: string, src: string, dest: string) =>
      ipcRenderer.invoke('fs:copy', hostId, src, dest),
    info: (hostId: string, path: string, deep?: boolean) =>
      ipcRenderer.invoke('fs:info', hostId, path, deep),
    setPerms: (hostId: string, path: string, change: PermsChange) =>
      ipcRenderer.invoke('fs:setPerms', hostId, path, change),
  },
  ops: {
    tools: (hostId: string) => ipcRenderer.invoke('ops:tools', hostId),
    extract: (hostId: string, archivePath: string, destDir: string) =>
      ipcRenderer.invoke('ops:extract', hostId, archivePath, destDir),
    compress: (
      hostId: string,
      dir: string,
      names: string[],
      archiveName: string,
      format: ArchiveFormat,
    ) => ipcRenderer.invoke('ops:compress', hostId, dir, names, archiveName, format),
    cancel: (id: string) => ipcRenderer.send('ops:cancel', id),
    list: () => ipcRenderer.invoke('ops:list'),
    clearFinished: () => ipcRenderer.send('ops:clearFinished'),
    onUpdate: (cb) => subscribe('fsop:update', cb),
  },
  transfers: {
    start: (req: TransferRequest) => ipcRenderer.invoke('transfers:start', req),
    download: (
      srcHostId: string,
      srcDir: string,
      names: string[],
      conflict: ConflictPolicy,
      verify: boolean,
    ) => ipcRenderer.invoke('transfers:download', srcHostId, srcDir, names, conflict, verify),
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
    jumpInVm: (parentId: string, vmid: number, name: string) =>
      ipcRenderer.invoke('subhosts:jumpInVm', parentId, vmid, name),
    pin: (id: string) => ipcRenderer.invoke('subhosts:pin', id),
    unpin: (id: string) => ipcRenderer.invoke('subhosts:unpin', id),
  },
  orch: {
    get: (hostId: string) => ipcRenderer.invoke('orch:get', hostId),
    action: (hostId: string, action: OrchAction) =>
      ipcRenderer.invoke('orch:action', hostId, action),
    serviceTasks: (hostId: string, service: string) =>
      ipcRenderer.invoke('orch:serviceTasks', hostId, service),
    taskLogs: (hostId: string, taskId: string, opts?: { tail?: number; since?: string }) =>
      ipcRenderer.invoke('orch:taskLogs', hostId, taskId, opts),
  },
  monitor: {
    sample: (hostId: string) => unwrap(ipcRenderer.invoke('monitor:sample', hostId)),
    dockerDf: (hostId: string) => unwrap(ipcRenderer.invoke('monitor:dockerDf', hostId)),
    stats: (hostId: string) => unwrap(ipcRenderer.invoke('monitor:stats', hostId)),
  },
  history: {
    list: () => ipcRenderer.invoke('history:list'),
    record: (hostId: string, command: string) =>
      ipcRenderer.send('history:record', hostId, command),
    importFromHost: (hostId: string) => ipcRenderer.invoke('history:import', hostId),
    clear: (hostId?: string) => ipcRenderer.invoke('history:clear', hostId),
  },
  claude: {
    open: (size: TermSize) => ipcRenderer.invoke('claude:open', size),
    status: () => ipcRenderer.invoke('claude:status'),
    chatSend: (text: string) => ipcRenderer.invoke('claude:chatSend', text),
    chatInterrupt: () => ipcRenderer.send('claude:chatInterrupt'),
    chatAnswer: (requestId: string, answer: ClaudePermissionAnswer) =>
      ipcRenderer.send('claude:chatAnswer', requestId, answer),
    chatSetAutoApprove: (on: boolean) => ipcRenderer.send('claude:chatAutoApprove', on),
    chatSetModel: (model: string | null) => ipcRenderer.send('claude:chatModel', model),
    chatSessions: () => ipcRenderer.invoke('claude:chatSessions'),
    chatResume: (sessionId: string) => ipcRenderer.invoke('claude:chatResume', sessionId),
    chatNew: () => ipcRenderer.invoke('claude:chatNew'),
    setFocus: (focus: ClaudeFocus | null) => ipcRenderer.send('claude:focus', focus),
    onEvent: (cb) => subscribe('claude:event', cb),
    onUiRequest: (cb) => subscribe('claude:uiRequest', cb),
    uiRespond: (response: ClaudeUiResponse) => ipcRenderer.send('claude:uiResponse', response),
  },
  onHostDisconnected: (cb) => subscribe('host:disconnected', cb),
};

contextBridge.exposeInMainWorld('pear', api);
