import type { FacetKind, Orchestration } from '@pear/core';

export { FACET_KINDS } from '@pear/core';

export interface FacetMeta {
  icon: string;
  /** Sidebar section / view-tab label. */
  tab: string;
  /** Full-page title. */
  title: string;
  /** Sidebar header count (e.g. "3/5 running"); null when the facet is absent. */
  summary(data: Orchestration): string | null;
}

/**
 * UI-side facet registry: everything the chrome (sidebar, tabs, glyphs)
 * needs, keyed by facet kind. The Record is compile-checked against
 * FacetKind, so a facet added in core must be described here too. The facet
 * page/panel *bodies* stay per-facet components — only the chrome is data-
 * driven.
 */
export const FACET_META: Record<FacetKind, FacetMeta> = {
  docker: {
    icon: 'docker',
    tab: 'Containers',
    title: 'Docker Engine',
    summary: (data) => {
      const d = data.docker;
      return d ? `${d.containers.filter((c) => c.running).length}/${d.containers.length}` : null;
    },
  },
  swarm: {
    icon: 'layers',
    tab: 'Cluster',
    title: 'Swarm Cluster',
    summary: (data) => {
      const s = data.swarm;
      if (!s) return null;
      const converged = s.services.filter((x) => x.running > 0 && x.running === x.desired).length;
      return `${converged}/${s.services.length}`;
    },
  },
  proxmox: {
    icon: 'server',
    tab: 'Guests',
    title: 'Proxmox VE Node',
    summary: (data) => {
      const p = data.proxmox;
      return p ? `${p.guests.filter((g) => g.running).length}/${p.guests.length}` : null;
    },
  },
};
