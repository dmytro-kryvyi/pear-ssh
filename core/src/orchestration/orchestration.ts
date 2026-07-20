import type {
  ComposeGroup,
  ContainerInfo,
  DockerFacet,
  HostFacets,
  HostKind,
  OrchAction,
  OrchActionResult,
  Orchestration,
  ProxmoxGuestGroup,
  ProxmoxGuestInfo,
  ProxmoxResources,
  SwarmNodeInfo,
  SwarmServiceInfo,
  SwarmStackGroup,
} from '../types';

import { shq } from '../shq';

export type Exec = (command: string) => Promise<{ code: number; stdout: string; stderr: string }>;

function jsonLines<T>(stdout: string): T[] {
  return stdout
    .split('\n')
    .filter((line) => line.trim().startsWith('{'))
    .map((line) => JSON.parse(line) as T);
}

function must(result: { code: number; stdout: string; stderr: string }, what: string): string {
  if (result.code !== 0) {
    throw new Error(`${what} failed: ${result.stderr.trim() || `exit ${result.code}`}`);
  }
  return result.stdout;
}

/**
 * Probe which orchestration systems the host runs. A host can be several at
 * once: a Proxmox node commonly also runs Docker, and a Swarm manager always
 * has both the `swarm` control plane and a plain `docker` engine. `docker` is
 * true whenever the engine is reachable; `swarm` only when this node is a
 * manager (services can only be managed from a manager).
 */
export async function detectFacets(exec: Exec): Promise<HostFacets> {
  const probe = await exec(
    `command -v pvesh >/dev/null 2>&1 && echo PVE; ` +
      `docker info --format '{{.Swarm.LocalNodeState}}/{{.Swarm.ControlAvailable}}' 2>/dev/null`,
  );
  const proxmox = /^PVE$/m.test(probe.stdout);
  const docker = probe.stdout.match(/^(\w+)\/(true|false)$/m);
  return {
    proxmox,
    docker: docker != null,
    swarm: docker != null && docker[1] === 'active' && docker[2] === 'true',
  };
}

/** The dominant facet, used for the sidebar host glyph. */
export function primaryKind(facets: HostFacets): HostKind {
  if (facets.proxmox) return 'proxmox';
  if (facets.swarm) return 'swarm';
  if (facets.docker) return 'docker';
  return 'plain';
}

export async function fetchOrchestration(
  exec: Exec,
  facets: HostFacets,
): Promise<Orchestration> {
  const [docker, swarm, proxmox] = await Promise.all([
    facets.docker ? fetchDocker(exec) : Promise.resolve(undefined),
    facets.swarm
      ? Promise.all([fetchNodes(exec), fetchServices(exec)]).then(([nodes, services]) => ({
          nodes,
          services,
          stacks: groupByStack(services),
        }))
      : Promise.resolve(undefined),
    facets.proxmox ? fetchProxmox(exec) : Promise.resolve(undefined),
  ]);
  const out: Orchestration = {};
  if (docker) out.docker = docker;
  if (swarm) out.swarm = swarm;
  if (proxmox) out.proxmox = proxmox;
  return out;
}

interface DockerPsRow {
  ID: string;
  Names: string;
  Image: string;
  State: string;
  Status: string;
  Ports: string;
  Labels: string;
}

/** Parse docker's comma-joined "k=v,k=v" Labels string into a lookup. */
function parseLabels(labels: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!labels) return out;
  for (const pair of labels.split(',')) {
    const eq = pair.indexOf('=');
    if (eq > 0) out[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return out;
}

interface DockerStatsRow {
  ID: string;
  CPUPerc: string;
  MemUsage: string;
}

// "1.83GiB / 15.6GiB" -> [used bytes, limit bytes]
const MEM_UNITS: Record<string, number> = {
  B: 1,
  KiB: 1024,
  MiB: 1024 ** 2,
  GiB: 1024 ** 3,
  TiB: 1024 ** 4,
  KB: 1000,
  MB: 1000 ** 2,
  GB: 1000 ** 3,
  TB: 1000 ** 4,
};
function parseBytes(token: string): number | null {
  const m = token.trim().match(/^([\d.]+)\s*([A-Za-z]+)$/);
  if (!m) return null;
  const unit = MEM_UNITS[m[2]];
  return unit ? parseFloat(m[1]) * unit : null;
}

/** Best-effort live cpu/mem for running containers, keyed by container id. */
async function fetchStats(
  exec: Exec,
): Promise<Map<string, { cpu: number | null; mem: number | null; maxmem: number | null }>> {
  const stats = new Map<string, { cpu: number | null; mem: number | null; maxmem: number | null }>();
  const result = await exec(`docker stats --no-stream --format '{{json .}}'`);
  if (result.code !== 0) return stats; // stats are optional; skip on failure
  for (const row of jsonLines<DockerStatsRow>(result.stdout)) {
    const cpu = parseFloat(row.CPUPerc);
    const [used, limit] = row.MemUsage.split('/');
    stats.set(row.ID, {
      cpu: Number.isFinite(cpu) ? cpu / 100 : null,
      mem: used ? parseBytes(used) : null,
      maxmem: limit ? parseBytes(limit) : null,
    });
  }
  return stats;
}

async function fetchDocker(exec: Exec): Promise<DockerFacet> {
  const [psOut, stats] = await Promise.all([
    exec(`docker ps -a --format '{{json .}}'`).then((r) => must(r, 'docker ps')),
    fetchStats(exec),
  ]);
  const containers: ContainerInfo[] = [];
  for (const row of jsonLines<DockerPsRow>(psOut)) {
    const labels = parseLabels(row.Labels);
    // Swarm tasks are managed as services in the swarm facet — don't list them
    // again as plain containers.
    if (labels['com.docker.swarm.service.id'] || labels['com.docker.swarm.service.name']) {
      continue;
    }
    const live = stats.get(row.ID);
    containers.push({
      id: row.ID,
      name: row.Names.split(',')[0],
      image: row.Image,
      running: row.State === 'running',
      status: row.Status,
      ports: row.Ports || '—',
      project: labels['com.docker.compose.project'] ?? null,
      cpu: live?.cpu ?? null,
      mem: live?.mem ?? null,
      maxmem: live?.maxmem ?? null,
    });
  }
  return { containers, groups: groupByProject(containers) };
}

/** Group containers by Compose project; standalone (null) sorts last. */
function groupByProject(containers: ContainerInfo[]): ComposeGroup[] {
  const byProject = new Map<string | null, ContainerInfo[]>();
  for (const c of containers) {
    const list = byProject.get(c.project);
    if (list) list.push(c);
    else byProject.set(c.project, [c]);
  }
  return [...byProject.entries()]
    .map(([project, items]) => ({ project, containers: items }))
    .sort((a, b) => {
      if (a.project === null) return 1;
      if (b.project === null) return -1;
      return a.project.localeCompare(b.project);
    });
}

interface DockerNodeRow {
  ID: string;
  Hostname: string;
  Status: string;
  ManagerStatus: string;
}

async function fetchNodes(exec: Exec): Promise<SwarmNodeInfo[]> {
  const out = must(await exec(`docker node ls --format '{{json .}}'`), 'docker node ls');
  const rows = jsonLines<DockerNodeRow>(out);
  const addrs = await fetchNodeAddrs(exec, rows.map((r) => r.ID));
  return rows.map((row) => ({
    name: row.Hostname,
    role: row.ManagerStatus ? 'manager' : 'worker',
    ready: row.Status === 'Ready',
    leader: row.ManagerStatus === 'Leader',
    addr: addrs.get(row.Hostname) ?? '',
  }));
}

// node ls has no address column; one inspect call resolves them all.
async function fetchNodeAddrs(exec: Exec, ids: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (ids.length === 0) return map;
  const fmt = '{{.Description.Hostname}}\t{{.Status.Addr}}';
  const result = await exec(`docker node inspect --format '${fmt}' ${ids.join(' ')}`);
  if (result.code !== 0) return map; // addresses are optional
  for (const line of result.stdout.split('\n')) {
    const [host, addr] = line.split('\t');
    if (host && addr) map.set(host.trim(), addr.trim());
  }
  return map;
}

interface DockerServiceRow {
  ID: string;
  Name: string;
  Mode: string;
  Replicas: string;
  Image: string;
  Ports: string;
}

async function fetchServices(exec: Exec): Promise<SwarmServiceInfo[]> {
  const out = must(await exec(`docker service ls --format '{{json .}}'`), 'docker service ls');
  return jsonLines<DockerServiceRow>(out).map((row) => {
    const replicas = row.Replicas.match(/^(\d+)\/(\d+)/);
    return {
      id: row.ID,
      name: row.Name,
      image: row.Image,
      mode: row.Mode === 'global' ? 'global' : 'replicated',
      running: replicas ? Number(replicas[1]) : 0,
      desired: replicas ? Number(replicas[2]) : 0,
      ports: row.Ports || '—',
      stack: stackOf(row.Name),
    };
  });
}

// Stack-deployed services are named "<stack>_<service>" (the compose file's
// project). Services created directly (`docker service create foo`) have no
// underscore and count as standalone.
function stackOf(name: string): string | null {
  const sep = name.indexOf('_');
  return sep > 0 ? name.slice(0, sep) : null;
}

/** Group services by stack; standalone (null) sorts last. */
function groupByStack(services: SwarmServiceInfo[]): SwarmStackGroup[] {
  const byStack = new Map<string | null, SwarmServiceInfo[]>();
  for (const s of services) {
    const list = byStack.get(s.stack);
    if (list) list.push(s);
    else byStack.set(s.stack, [s]);
  }
  return [...byStack.entries()]
    .map(([stack, items]) => ({ stack, services: items }))
    .sort((a, b) => {
      if (a.stack === null) return 1;
      if (b.stack === null) return -1;
      return a.stack.localeCompare(b.stack);
    });
}

interface PveResource {
  type: 'node' | 'qemu' | 'lxc' | 'storage' | 'sdn';
  node?: string;
  vmid?: number;
  name?: string;
  status?: string;
  cpu?: number;
  mem?: number;
  maxmem?: number;
  disk?: number;
  maxdisk?: number;
  uptime?: number;
}

async function fetchProxmox(
  exec: Exec,
): Promise<{ resources: ProxmoxResources | null; guests: ProxmoxGuestInfo[]; groups: ProxmoxGuestGroup[] }> {
  const out = must(
    await exec(`hostname; pvesh get /cluster/resources --output-format json`),
    'pvesh get /cluster/resources',
  );
  const newline = out.indexOf('\n');
  const node = out.slice(0, newline).trim();
  const all = JSON.parse(out.slice(newline + 1)) as PveResource[];

  const self = all.find((r) => r.type === 'node' && r.node === node);
  const resources: ProxmoxResources | null = self
    ? {
        cpu: self.cpu ?? 0,
        mem: self.mem ?? 0,
        maxmem: self.maxmem ?? 0,
        disk: self.disk ?? 0,
        maxdisk: self.maxdisk ?? 0,
        uptime: self.uptime ?? 0,
      }
    : null;

  const guests = all
    .filter((r) => (r.type === 'qemu' || r.type === 'lxc') && r.node === node)
    .map<ProxmoxGuestInfo>((r) => ({
      vmid: r.vmid ?? 0,
      name: r.name ?? String(r.vmid),
      type: r.type === 'qemu' ? 'vm' : 'lxc',
      running: r.status === 'running',
      status: r.status ?? 'unknown',
      cpu: r.status === 'running' ? (r.cpu ?? 0) : 0,
      mem: r.status === 'running' ? (r.mem ?? 0) : 0,
      maxmem: r.maxmem ?? 0,
    }))
    .sort((a, b) => a.vmid - b.vmid);

  return { resources, guests, groups: groupByType(guests) };
}

/** Split guests into VM and CT groups; VMs first. Empty groups are dropped. */
function groupByType(guests: ProxmoxGuestInfo[]): ProxmoxGuestGroup[] {
  const groups: ProxmoxGuestGroup[] = [];
  for (const type of ['vm', 'lxc'] as const) {
    const items = guests.filter((g) => g.type === type);
    if (items.length) groups.push({ type, guests: items });
  }
  return groups;
}

function buildAction(action: OrchAction): { command?: string; terminalCommand?: string } {
  switch (action.type) {
    case 'container':
      if (action.op === 'logs') {
        return { terminalCommand: `docker logs -f --tail 100 ${shq(action.name)}` };
      }
      return { command: `docker ${action.op} ${shq(action.id)}` };
    // Compose v2 resolves a bare `-p <project>` from container labels, so
    // start/stop/restart/logs work without access to the compose file.
    case 'compose':
      if (action.op === 'logs') {
        return { terminalCommand: `docker compose -p ${shq(action.project)} logs -f --tail 100` };
      }
      return { command: `docker compose -p ${shq(action.project)} ${action.op}` };
    case 'service':
      if (action.op === 'logs') {
        return { terminalCommand: `docker service logs -f --tail 100 ${shq(action.name)}` };
      }
      if (action.op === 'scale') {
        return { command: `docker service scale ${shq(action.name)}=${action.replicas}` };
      }
      return { command: `docker service update --force ${shq(action.name)}` };
    case 'guest': {
      const tool = action.guestType === 'vm' ? 'qm' : 'pct';
      if (action.op === 'console') {
        return {
          terminalCommand:
            action.guestType === 'vm' ? `qm terminal ${action.vmid}` : `pct enter ${action.vmid}`,
        };
      }
      return { command: `${tool} ${action.op} ${action.vmid}` };
    }
  }
}

export async function performAction(exec: Exec, action: OrchAction): Promise<OrchActionResult> {
  const { command, terminalCommand } = buildAction(action);
  if (command) {
    must(await exec(command), command);
  }
  return terminalCommand ? { terminalCommand } : {};
}
