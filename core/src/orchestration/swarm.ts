import type { SwarmAction, SwarmFacet, SwarmNodeInfo, SwarmServiceInfo, SwarmStackGroup } from '../types';
import { jsonLines, must, probeMarker, type Exec, type FacetProvider } from './provider';
import { shq } from '../shq';

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

async function fetchSwarm(exec: Exec): Promise<SwarmFacet> {
  const [nodes, services] = await Promise.all([fetchNodes(exec), fetchServices(exec)]);
  return { nodes, services, stacks: groupByStack(services) };
}

function buildAction(action: SwarmAction): { command?: string; terminalCommand?: string } {
  if (action.op === 'logs') {
    return { terminalCommand: `docker service logs -f --tail 100 ${shq(action.name)}` };
  }
  if (action.op === 'scale') {
    return { command: `docker service scale ${shq(action.name)}=${action.replicas}` };
  }
  return { command: `docker service update --force ${shq(action.name)}` };
}

export const swarmProvider: FacetProvider<'swarm'> = {
  kind: 'swarm',
  // Only a manager counts (services can only be managed from a manager).
  probe:
    `[ "$(docker info --format '{{.Swarm.LocalNodeState}}/{{.Swarm.ControlAvailable}}' 2>/dev/null)"` +
    ` = "active/true" ] && echo ${probeMarker('swarm')}`,
  actionTypes: ['service'],
  fetch: fetchSwarm,
  buildAction,
};
