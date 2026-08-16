import type { ComposeGroup, ContainerInfo, DockerAction, DockerFacet } from '../types';
import { jsonLines, must, parseBytes, probeMarker, type Exec, type FacetProvider } from './provider';
import { shq } from '../shq';

// The engine CLI. Everything in this provider goes through it, so a
// docker-CLI-compatible engine (podman) can be added by cloning the provider
// with a different binary and kind.
const BIN = 'docker';

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

/** Best-effort live cpu/mem for running containers, keyed by container id. */
export async function fetchStats(
  exec: Exec,
): Promise<Map<string, { cpu: number | null; mem: number | null; maxmem: number | null }>> {
  const stats = new Map<string, { cpu: number | null; mem: number | null; maxmem: number | null }>();
  const result = await exec(`${BIN} stats --no-stream --format '{{json .}}'`);
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
    exec(`${BIN} ps -a --format '{{json .}}'`).then((r) => must(r, `${BIN} ps`)),
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

function buildAction(action: DockerAction): { command?: string; terminalCommand?: string } {
  switch (action.type) {
    case 'container':
      if (action.op === 'logs') {
        return { terminalCommand: `${BIN} logs -f --tail 100 ${shq(action.name)}` };
      }
      return { command: `${BIN} ${action.op} ${shq(action.id)}` };
    // Compose v2 resolves a bare `-p <project>` from container labels, so
    // start/stop/restart/logs work without access to the compose file.
    case 'compose':
      if (action.op === 'logs') {
        return { terminalCommand: `${BIN} compose -p ${shq(action.project)} logs -f --tail 100` };
      }
      return { command: `${BIN} compose -p ${shq(action.project)} ${action.op}` };
    // Deliberately excludes --volumes: unused volumes can hold data, and the
    // command runs unattended once it lands in the terminal.
    case 'engine':
      return { terminalCommand: `${BIN} system prune -af` };
  }
}

export const dockerProvider: FacetProvider<'docker'> = {
  kind: 'docker',
  probe: `${BIN} info >/dev/null 2>&1 && echo ${probeMarker('docker')}`,
  actionTypes: ['container', 'compose', 'engine'],
  fetch: fetchDocker,
  buildAction,
};
