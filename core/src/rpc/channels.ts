import type { PearApi } from '../api';

/**
 * How one PearApi member crosses a process boundary.
 *  - invoke: request/response (the method returns a Promise)
 *  - send:   fire-and-forget (the method returns void)
 *  - event:  a subscription; the channel is the event name pushed to clients
 *  - local:  never crosses — each embedder implements it client-side
 */
export type ChannelRow =
  | readonly ['invoke', string]
  | readonly ['send', string]
  | readonly ['event', string]
  | readonly ['local'];

/** One row per PearApi member. Optional members are required here on purpose:
 *  adding an API method without deciding how it travels must not compile. */
export type ChannelTable<T> = {
  [K in keyof T]-?: NonNullable<T[K]> extends (...args: never[]) => unknown
    ? ChannelRow
    : ChannelTable<NonNullable<T[K]>>;
};

/**
 * The wire names, spelled out. They are deliberately NOT derived from the
 * member names: the Electron bridge shipped with irregular ones
 * (hostGroups → hostgroups:*, importFromHost → history:import,
 * transfers.onUpdate → transfer:update …) and the preload script — sandboxed,
 * so it cannot import this table — hard-codes the same strings.
 */
export const CHANNELS = {
  hosts: {
    list: ['invoke', 'hosts:list'],
    upsert: ['invoke', 'hosts:upsert'],
    remove: ['invoke', 'hosts:remove'],
    addLocal: ['invoke', 'hosts:addLocal'],
    sshConfigEntries: ['invoke', 'hosts:sshConfigEntries'],
    probe: ['invoke', 'hosts:probe'],
  },
  hostGroups: {
    list: ['invoke', 'hostgroups:list'],
    upsert: ['invoke', 'hostgroups:upsert'],
    remove: ['invoke', 'hostgroups:remove'],
    setMembership: ['invoke', 'hostgroups:setMembership'],
  },
  term: {
    open: ['invoke', 'term:open'],
    write: ['send', 'term:write'],
    resize: ['send', 'term:resize'],
    close: ['send', 'term:close'],
    onData: ['event', 'term:data'],
    onExit: ['event', 'term:exit'],
  },
  fs: {
    list: ['invoke', 'fs:list'],
    read: ['invoke', 'fs:read'],
    write: ['invoke', 'fs:write'],
    upload: ['invoke', 'fs:upload'],
    stat: ['invoke', 'fs:stat'],
    mkdir: ['invoke', 'fs:mkdir'],
    remove: ['invoke', 'fs:remove'],
    rename: ['invoke', 'fs:rename'],
    copy: ['invoke', 'fs:copy'],
    info: ['invoke', 'fs:info'],
    setPerms: ['invoke', 'fs:setPerms'],
  },
  ops: {
    tools: ['invoke', 'ops:tools'],
    extract: ['invoke', 'ops:extract'],
    compress: ['invoke', 'ops:compress'],
    cancel: ['send', 'ops:cancel'],
    list: ['invoke', 'ops:list'],
    clearFinished: ['send', 'ops:clearFinished'],
    onUpdate: ['event', 'fsop:update'],
  },
  transfers: {
    start: ['invoke', 'transfers:start'],
    download: ['invoke', 'transfers:download'],
    cancel: ['send', 'transfers:cancel'],
    list: ['invoke', 'transfers:list'],
    clearFinished: ['send', 'transfers:clearFinished'],
    setMaxParallel: ['send', 'transfers:setMaxParallel'],
    onUpdate: ['event', 'transfer:update'],
    pathForFile: ['local'],
  },
  subhosts: {
    list: ['invoke', 'subhosts:list'],
    jumpIn: ['invoke', 'subhosts:jumpIn'],
    jumpInVm: ['invoke', 'subhosts:jumpInVm'],
    pin: ['invoke', 'subhosts:pin'],
    unpin: ['invoke', 'subhosts:unpin'],
  },
  orch: {
    get: ['invoke', 'orch:get'],
    action: ['invoke', 'orch:action'],
    serviceTasks: ['invoke', 'orch:serviceTasks'],
    taskLogs: ['invoke', 'orch:taskLogs'],
  },
  monitor: {
    sample: ['invoke', 'monitor:sample'],
    dockerDf: ['invoke', 'monitor:dockerDf'],
    stats: ['invoke', 'monitor:stats'],
  },
  history: {
    list: ['invoke', 'history:list'],
    record: ['send', 'history:record'],
    importFromHost: ['invoke', 'history:import'],
    clear: ['invoke', 'history:clear'],
  },
  claude: {
    open: ['invoke', 'claude:open'],
    status: ['invoke', 'claude:status'],
    chatSend: ['invoke', 'claude:chatSend'],
    chatInterrupt: ['send', 'claude:chatInterrupt'],
    chatAnswer: ['send', 'claude:chatAnswer'],
    chatSetAutoApprove: ['send', 'claude:chatAutoApprove'],
    chatSetModel: ['send', 'claude:chatModel'],
    chatSessions: ['invoke', 'claude:chatSessions'],
    chatResume: ['invoke', 'claude:chatResume'],
    chatState: ['invoke', 'claude:chatState'],
    chatNew: ['invoke', 'claude:chatNew'],
    setFocus: ['send', 'claude:focus'],
    onEvent: ['event', 'claude:event'],
    onUiRequest: ['event', 'claude:uiRequest'],
    uiRespond: ['send', 'claude:uiResponse'],
  },
  hostKeys: {
    trust: ['invoke', 'hostkeys:trust'],
    forget: ['invoke', 'hostkeys:forget'],
  },
  onHostDisconnected: ['event', 'host:disconnected'],
} as const satisfies ChannelTable<PearApi>;

export type ChannelKind = 'invoke' | 'send' | 'event';

function isRow(v: unknown): v is ChannelRow {
  return Array.isArray(v);
}

/** Every wire channel of one kind, flattened (adapters register from this). */
export function channelsOf(kind: ChannelKind): string[] {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (isRow(node)) {
      if (node[0] === kind) out.push(node[1] as string);
      return;
    }
    for (const child of Object.values(node as Record<string, unknown>)) walk(child);
  };
  walk(CHANNELS);
  return out;
}

/** What a transport must provide for {@link buildApiClient} to assemble PearApi. */
export interface ApiClientTransport {
  invoke(channel: string, args: unknown[]): Promise<unknown>;
  send(channel: string, args: unknown[]): void;
  /** Returns the unsubscribe function. */
  subscribe(event: string, cb: (...args: never[]) => void): () => void;
}

/**
 * Assemble a PearApi from the table over any transport. `local` rows have no
 * wire form, so the caller supplies them keyed by dotted path
 * (e.g. `{ 'transfers.pathForFile': … }`); a missing one throws when called.
 */
export function buildApiClient(
  transport: ApiClientTransport,
  locals: Record<string, (...args: never[]) => unknown> = {},
): PearApi {
  const build = (node: unknown, path: string): unknown => {
    if (isRow(node)) {
      const row = node;
      if (row[0] === 'invoke') return (...a: unknown[]) => transport.invoke(row[1], a);
      if (row[0] === 'send') return (...a: unknown[]) => transport.send(row[1], a);
      if (row[0] === 'event') {
        return (cb: (...args: never[]) => void) => transport.subscribe(row[1], cb);
      }
      return (
        locals[path] ??
        (() => {
          throw new Error(`${path} is not available in this environment`);
        })
      );
    }
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      out[key] = build(child, path ? `${path}.${key}` : key);
    }
    return out;
  };
  return build(CHANNELS, '') as PearApi;
}
