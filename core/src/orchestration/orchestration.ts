// Facet-agnostic orchestration engine. Each system (docker, swarm, proxmox)
// lives in its own provider file; this module only knows how to run the
// registry: probe all facets in one round-trip, fetch the present ones, and
// route actions to the provider that owns them. To add a facet, write a
// provider and register it in FACET_PROVIDERS (the mapped type makes a
// missing entry a compile error once the kind exists in FacetDataMap).

import type { FacetKind, HostFacets, HostKind, OrchAction, OrchActionResult, Orchestration } from '../types';
import { must, probeMarker, type Exec, type FacetProvider } from './provider';
import { dockerProvider } from './docker';
import { swarmProvider } from './swarm';
import { proxmoxProvider } from './proxmox';

export { jsonLines, must, parseBytes, probeMarker, type BuiltAction, type Exec, type FacetProvider } from './provider';
export { fetchStats } from './docker';
export { fetchProxmox } from './proxmox';

/** Every facet Pear understands, keyed by kind, in display order. */
export const FACET_PROVIDERS: { [K in FacetKind]: FacetProvider<K> } = {
  docker: dockerProvider,
  swarm: swarmProvider,
  proxmox: proxmoxProvider,
};

/** Facet kinds in display order (sidebar sections, view tabs). */
export const FACET_KINDS = Object.keys(FACET_PROVIDERS) as readonly FacetKind[];

/** Kind-erased view of the registry for iteration. */
const PROVIDERS = Object.values(FACET_PROVIDERS) as FacetProvider[];

/**
 * Probe which orchestration systems the host runs, in a single exec
 * round-trip: every provider's probe snippet runs and prints its marker line
 * when its facet is present. A host can be several at once: a Proxmox node
 * commonly also runs Docker, and a Swarm manager always has both the `swarm`
 * control plane and a plain `docker` engine.
 */
export async function detectFacets(exec: Exec): Promise<HostFacets> {
  const result = await exec(PROVIDERS.map((p) => p.probe).join('; '));
  const facets = {} as HostFacets;
  for (const p of PROVIDERS) {
    facets[p.kind] = new RegExp(`^${probeMarker(p.kind)}$`, 'm').test(result.stdout);
  }
  return facets;
}

/** Sidebar glyph dominance — lowest rank wins when a host runs several facets. */
const PRIMARY_RANK: Record<FacetKind, number> = { proxmox: 0, swarm: 1, docker: 2 };

/** The dominant facet, used for the sidebar host glyph. */
export function primaryKind(facets: HostFacets): HostKind {
  const present = FACET_KINDS.filter((kind) => facets[kind]);
  present.sort((a, b) => PRIMARY_RANK[a] - PRIMARY_RANK[b]);
  return present[0] ?? 'plain';
}

export async function fetchOrchestration(exec: Exec, facets: HostFacets): Promise<Orchestration> {
  const present = PROVIDERS.filter((p) => facets[p.kind]);
  const fetched = await Promise.all(present.map((p) => p.fetch(exec)));
  const out: Orchestration = {};
  present.forEach((p, i) => {
    (out as Record<FacetKind, unknown>)[p.kind] = fetched[i];
  });
  return out;
}

function providerFor(action: OrchAction): FacetProvider {
  const provider = PROVIDERS.find((p) => (p.actionTypes as readonly string[]).includes(action.type));
  if (!provider) throw new Error(`No facet provider handles '${action.type}' actions`);
  return provider;
}

export async function performAction(exec: Exec, action: OrchAction): Promise<OrchActionResult> {
  const { command, terminalCommand } = providerFor(action).buildAction(action);
  if (command) {
    must(await exec(command), command);
  }
  return terminalCommand ? { terminalCommand } : {};
}
