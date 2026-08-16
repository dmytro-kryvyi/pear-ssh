import {
  HistoryStore,
  HostGroupStore,
  SessionManager,
  importShellHistory,
  primaryKind,
  type HostConfig,
  type PearApi,
  type ProbeResult,
} from '@pear/core';
import { SshEventHub } from './event-hub';
import { MobileHostStore } from './host-store';
import { syncStorage, type AsyncCipher, type AsyncKv } from './kv';
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
export function createNativeBackend(deps: NativeBackendDeps): PearApi {
  const termData = new Set<(termId: string, data: string) => void>();
  const termExit = new Set<(termId: string) => void>();
  const hostDown = new Set<(hostId: string) => void>();
  const hub = new SshEventHub(deps.plugin);

  const ready: Promise<Ready> = (async () => {
    const hosts = await MobileHostStore.load(deps.kv, deps.cipher);
    const groups = new HostGroupStore(await syncStorage(deps.kv, 'pear.groups'));
    const history = new HistoryStore(await syncStorage(deps.kv, 'pear.history'));
    const sessions = new SessionManager(
      {
        onTermData: (termId, data) => termData.forEach((cb) => cb(termId, data)),
        onTermExit: (termId) => termExit.forEach((cb) => cb(termId)),
        onHostDisconnected: (hostId) => hostDown.forEach((cb) => cb(hostId)),
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

  return {
    hosts: {
      list: async () => (await ready).hosts.listSanitized(),
      upsert: async (host) => (await ready).hosts.upsert(host),
      remove: async (id) => {
        const { hosts, groups, sessions } = await ready;
        sessions.disconnectHost(id);
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
      start: notYet('Transfers arrive in M6'),
      download: notYet('Transfers arrive in M6'),
      cancel: () => {},
      list: async () => [],
      clearFinished: () => {},
      setMaxParallel: () => {},
      onUpdate: () => () => {},
      pathForFile: () => '',
    },
    subhosts: {
      list: async () => [],
      jumpIn: notYet('Sub-hosts arrive in M5'),
      jumpInVm: notYet('Sub-hosts arrive in M5'),
      pin: notYet('Sub-hosts arrive in M5'),
      unpin: notYet('Sub-hosts arrive in M5'),
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
      open: notYet('Claude arrives in M4'),
      status: notYet('Claude arrives in M4'),
      chatSend: notYet('Claude arrives in M4'),
      chatInterrupt: () => {},
      chatAnswer: () => {},
      chatSetAutoApprove: () => {},
      chatSetModel: () => {},
      chatSessions: async () => [],
      chatResume: notYet('Claude arrives in M4'),
      chatNew: async () => {},
      setFocus: () => {},
      onEvent: () => () => {},
      onUiRequest: () => () => {},
      uiRespond: () => {},
    },
    onHostDisconnected: (cb) => {
      hostDown.add(cb);
      return () => hostDown.delete(cb);
    },
  };
}
