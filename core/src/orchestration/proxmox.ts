import type { ProxmoxAction, ProxmoxFacet, ProxmoxGuestGroup, ProxmoxGuestInfo, ProxmoxResources } from '../types';
import { must, probeMarker, type Exec, type FacetProvider } from './provider';

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

export async function fetchProxmox(exec: Exec): Promise<ProxmoxFacet> {
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

function buildAction(action: ProxmoxAction): { command?: string; terminalCommand?: string } {
  const tool = action.guestType === 'vm' ? 'qm' : 'pct';
  if (action.op === 'console') {
    return {
      terminalCommand:
        action.guestType === 'vm' ? `qm terminal ${action.vmid}` : `pct enter ${action.vmid}`,
    };
  }
  return { command: `${tool} ${action.op} ${action.vmid}` };
}

export const proxmoxProvider: FacetProvider<'proxmox'> = {
  kind: 'proxmox',
  probe: `command -v pvesh >/dev/null 2>&1 && echo ${probeMarker('proxmox')}`,
  actionTypes: ['guest'],
  fetch: fetchProxmox,
  buildAction,
};
