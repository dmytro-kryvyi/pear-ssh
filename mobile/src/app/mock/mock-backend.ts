import type {
  DirListing,
  FileEntry,
  HostConfig,
  HostGroup,
  OrchAction,
  OrchActionResult,
  Orchestration,
  PearApi,
  ProbeResult,
} from '@pear/core';
import { Provider } from '@angular/core';
import { PEAR_BACKEND } from '../backend';
import { ClaudeDemo } from '../claude/claude-demo';
import { CLAUDE_STORE } from '../claude/claude-store';
import { FakePty } from './fake-pty';
import { FILE_CONTENTS, ORCH, SEED_GROUPS, SEED_HOSTS, TREE } from './seed';

// In-memory PearApi for browser development and demos. Screens talk to this
// exactly as they will talk to the native SSH backend in M3 — same types,
// same error contracts (rejections with plain Error messages).

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const clone = <T>(v: T): T => structuredClone(v);
const fail = (what: string) => () => Promise.reject(new Error(`mock: ${what} not implemented`));
const noop = () => {};
const never = () => noop;

function parentOf(path: string): { dir: string; name: string } {
  const i = path.lastIndexOf('/');
  return { dir: i <= 0 ? '/' : path.slice(0, i), name: path.slice(i + 1) };
}

export function createMockBackend(): PearApi {
  const hosts: HostConfig[] = clone(SEED_HOSTS);
  const groups: HostGroup[] = clone(SEED_GROUPS);
  const orch: Record<string, Orchestration> = clone(ORCH);
  const tree: Record<string, FileEntry[]> = clone(TREE);
  const contents: Record<string, string> = { ...FILE_CONTENTS };

  const termData = new Set<(termId: string, data: string) => void>();
  const termExit = new Set<(termId: string) => void>();
  const ptys = new Map<string, FakePty>();
  let ptyN = 0;

  const hostById = (id: string): HostConfig => {
    const h = hosts.find((x) => x.id === id);
    if (!h) throw new Error(`unknown host ${id}`);
    return h;
  };

  const resolve = (hostId: string, path: string): string => {
    if (path === '~' || path.startsWith('~/')) {
      const user = hostById(hostId).user;
      const home = user === 'root' ? '/root' : `/home/${user}`;
      return path === '~' ? home : home + path.slice(1);
    }
    return path.replace(/\/+$/, '') || '/';
  };

  const listing = (path: string): FileEntry[] => {
    const entries = tree[path];
    if (!entries) throw new Error(`ls: cannot access '${path}': No such file or directory`);
    return entries;
  };

  const touch = (dir: string, name: string, size: number) => {
    const e = tree[dir]?.find((x) => x.name === name);
    if (e) {
      e.size = size;
      e.mtimeMs = Date.now();
    }
  };

  const orchAction = async (hostId: string, action: OrchAction): Promise<OrchActionResult> => {
    await sleep(140);
    const o = orch[hostId] ?? {};
    if (action.type === 'container') {
      const c = o.docker?.containers.find((x) => x.id === action.id);
      if (!c) throw new Error(`no such container: ${action.name}`);
      if (action.op === 'logs') return { terminalCommand: `docker logs -f --tail 200 ${c.name}` };
      c.running = action.op !== 'stop';
      c.status = c.running ? 'Up less than a minute' : 'Exited (0) just now';
      c.cpu = c.running ? 0.02 : null;
      c.mem = c.running ? 64 * 1024 ** 2 : null;
      return {};
    }
    if (action.type === 'service') {
      const s = o.swarm?.services.find((x) => x.name === action.name);
      if (!s) throw new Error(`no such service: ${action.name}`);
      if (action.op === 'logs') return { terminalCommand: `docker service logs -f ${s.name}` };
      if (action.op === 'scale') s.desired = s.running = Math.max(0, action.replicas);
      if (action.op === 'restart') s.running = s.desired;
      return {};
    }
    if (action.type === 'guest') {
      const g = o.proxmox?.guests.find((x) => x.vmid === action.vmid);
      if (!g) throw new Error(`no such guest: ${action.vmid}`);
      const tool = action.guestType === 'vm' ? 'qm' : 'pct';
      if (action.op === 'console')
        return { terminalCommand: action.guestType === 'vm' ? `qm terminal ${g.vmid}` : `pct enter ${g.vmid}` };
      if (action.op === 'start') Object.assign(g, { running: true, status: 'running', cpu: 0.01, mem: 0.2 * 1024 ** 3 });
      if (action.op === 'shutdown') Object.assign(g, { running: false, status: 'stopped', cpu: 0, mem: 0 });
      void tool;
      return {};
    }
    return {};
  };

  return {
    hosts: {
      list: async () => (await sleep(60), clone(hosts)),
      upsert: async (input) => {
        await sleep(80);
        const id = input.id || `h${Math.random().toString(36).slice(2, 7)}`;
        const eps = input.endpoints?.length
          ? input.endpoints
          : [{ id: `e${Math.random().toString(36).slice(2, 8)}`, addr: input.host || 'localhost', port: input.port || 22 }];
        const auth = input.auth ? { ...input.auth } : undefined;
        if (auth) {
          // Write-only secret contract: flags survive, values never come back.
          auth.hasPassword = auth.password ? true : auth.password === '' ? false : auth.hasPassword;
          auth.hasPassphrase = auth.passphrase ? true : auth.passphrase === '' ? false : auth.hasPassphrase;
          auth.hasPrivateKey = auth.privateKey ? true : auth.privateKey === '' ? false : auth.hasPrivateKey;
          delete auth.password;
          delete auth.passphrase;
          delete auth.privateKey;
        }
        const next: HostConfig = {
          ...clone(input),
          id,
          auth,
          endpoints: clone(eps),
          host: eps[0].addr,
          port: eps[0].port,
        };
        const i = hosts.findIndex((h) => h.id === id);
        if (i >= 0) hosts[i] = next;
        else hosts.push(next);
        return clone(next);
      },
      remove: async (id) => {
        const i = hosts.findIndex((h) => h.id === id);
        if (i >= 0) hosts.splice(i, 1);
        for (const g of groups) g.hostIds = g.hostIds.filter((x) => x !== id);
      },
      addLocal: fail('hosts.addLocal'),
      // No ~/.ssh/config to read off-desktop; the API contract is "never rejects".
      sshConfigEntries: async () => [],
      probe: async (endpoint): Promise<ProbeResult> => {
        const far = /^(203\.|2a01|100\.)/.test(endpoint.addr);
        await sleep(420 + Math.random() * 260);
        if (!endpoint.addr.trim()) return { ok: false, error: 'unreachable', detail: 'empty address' };
        if (endpoint.addr === '10.0.1.11') return { ok: false, error: 'timeout' };
        return { ok: true, latencyMs: Math.round((far ? 44 : 5) + Math.random() * (far ? 55 : 12)) };
      },
    },
    hostGroups: {
      list: async () => clone(groups),
      upsert: async (input) => {
        const id = input.id || `w${Math.random().toString(36).slice(2, 7)}`;
        const next: HostGroup = { ...clone(input), id };
        const i = groups.findIndex((g) => g.id === id);
        if (i >= 0) groups[i] = next;
        else groups.push(next);
        return clone(next);
      },
      remove: async (id) => {
        const i = groups.findIndex((g) => g.id === id);
        if (i >= 0) groups.splice(i, 1);
      },
      setMembership: async (hostId, groupId, member) => {
        const g = groups.find((x) => x.id === groupId);
        if (!g) return;
        const has = g.hostIds.includes(hostId);
        if (member && !has) g.hostIds.push(hostId);
        if (!member && has) g.hostIds = g.hostIds.filter((x) => x !== hostId);
      },
    },
    term: {
      open: async (hostId, _size, opts) => {
        await sleep(350);
        const host = hostById(hostId);
        const id = `t${++ptyN}`;
        const pty = new FakePty(
          host,
          {
            list: async (p) => {
              await sleep(60);
              const rp = resolve(hostId, p);
              return { path: rp, entries: clone(listing(rp)) };
            },
            read: async (p) => {
              await sleep(40);
              const rp = resolve(hostId, p);
              return contents[rp] ?? `# ${rp.split('/').pop()}\n\n(mock file — no seeded content)\n`;
            },
          },
          {
            emit: (data) => termData.forEach((cb) => cb(id, data)),
            exit: () => {
              ptys.delete(id);
              termExit.forEach((cb) => cb(id));
            },
          },
          opts?.cwd,
        );
        ptys.set(id, pty);
        // After the caller has the id — otherwise the banner beats the routing.
        setTimeout(() => pty.start(), 0);
        return id;
      },
      write: (id, data) => ptys.get(id)?.input(data),
      resize: noop,
      close: (id) => ptys.get(id)?.dispose(),
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
      list: async (hostId, path): Promise<DirListing> => {
        await sleep(90);
        const p = resolve(hostId, path);
        return { path: p, entries: clone(listing(p)) };
      },
      read: async (hostId, path) => {
        await sleep(70);
        const p = resolve(hostId, path);
        return contents[p] ?? `# ${p.split('/').pop()}\n\n(mock file — no seeded content)\n`;
      },
      write: async (hostId, path, content) => {
        const p = resolve(hostId, path);
        contents[p] = content;
        const { dir, name } = parentOf(p);
        touch(dir, name, content.length);
      },
      upload: fail('fs.upload'),
      stat: async (hostId, path) => {
        const p = resolve(hostId, path);
        const { dir, name } = parentOf(p);
        return clone(tree[dir]?.find((e) => e.name === name) ?? null);
      },
      mkdir: async (hostId, path) => {
        const p = resolve(hostId, path);
        const { dir, name } = parentOf(p);
        listing(dir).push({ name, kind: 'dir', size: 0, mtimeMs: Date.now(), mode: 'drwxr-xr-x' });
        tree[p] = [];
      },
      remove: async (hostId, path, recursive) => {
        const p = resolve(hostId, path);
        const { dir, name } = parentOf(p);
        if (tree[p]?.length && !recursive) throw new Error(`rm: cannot remove '${name}': Directory not empty`);
        delete tree[p];
        delete contents[p];
        const parent = listing(dir);
        const i = parent.findIndex((e) => e.name === name);
        if (i >= 0) parent.splice(i, 1);
      },
      rename: async (hostId, oldPath, newPath) => {
        const from = resolve(hostId, oldPath);
        const to = resolve(hostId, newPath);
        const a = parentOf(from);
        const b = parentOf(to);
        const src = listing(a.dir);
        const i = src.findIndex((e) => e.name === a.name);
        if (i < 0) throw new Error(`mv: cannot stat '${from}'`);
        const [entry] = src.splice(i, 1);
        const dst = listing(b.dir);
        const j = dst.findIndex((e) => e.name === b.name);
        if (j >= 0) dst.splice(j, 1);
        dst.push({ ...entry, name: b.name });
        if (contents[from] != null) {
          contents[to] = contents[from];
          delete contents[from];
        }
        if (tree[from]) {
          tree[to] = tree[from];
          delete tree[from];
        }
      },
      copy: async (hostId, src, dest) => {
        const from = resolve(hostId, src);
        const to = resolve(hostId, dest);
        const a = parentOf(from);
        const b = parentOf(to);
        const entry = listing(a.dir).find((e) => e.name === a.name);
        if (!entry) throw new Error(`cp: cannot stat '${from}'`);
        listing(b.dir).push({ ...clone(entry), name: b.name, mtimeMs: Date.now() });
        if (contents[from] != null) contents[to] = contents[from];
      },
    },
    transfers: {
      start: fail('transfers.start'),
      download: fail('transfers.download'),
      cancel: noop,
      list: async () => [],
      clearFinished: noop,
      setMaxParallel: noop,
      onUpdate: never,
      pathForFile: () => {
        throw new Error('mock: transfers.pathForFile not implemented');
      },
    },
    subhosts: {
      list: async () => [],
      jumpIn: fail('subhosts.jumpIn'),
      jumpInVm: fail('subhosts.jumpInVm'),
      pin: fail('subhosts.pin'),
      unpin: fail('subhosts.unpin'),
    },
    orch: {
      get: async (hostId) => (await sleep(160), clone(orch[hostId] ?? {})),
      action: orchAction,
      serviceTasks: fail('orch.serviceTasks'),
      taskLogs: fail('orch.taskLogs'),
    },
    monitor: {
      sample: fail('monitor.sample (vitals unsupported)'),
      dockerDf: fail('monitor.dockerDf'),
      stats: async () => ({}),
    },
    history: {
      list: async () => [],
      record: noop,
      importFromHost: fail('history.importFromHost'),
      clear: async () => {},
    },
    claude: {
      open: fail('claude.open'),
      status: async () => ({ installed: false, mcpReady: false }),
      chatSend: fail('claude.chatSend'),
      chatInterrupt: noop,
      chatAnswer: noop,
      chatSetAutoApprove: noop,
      chatSetModel: noop,
      chatSessions: async () => [],
      chatResume: fail('claude.chatResume'),
      chatNew: async () => {},
      setFocus: noop,
      onEvent: never,
      onUiRequest: never,
      uiRespond: noop,
    },
    onHostDisconnected: never,
  };
}

export function provideMockBackend(): Provider[] {
  return [
    { provide: PEAR_BACKEND, useFactory: createMockBackend },
    { provide: CLAUDE_STORE, useExisting: ClaudeDemo },
  ];
}
