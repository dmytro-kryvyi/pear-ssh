import type { FacetKind } from '@pear/core';

/** Icon + tab label + full-page title for each orchestration facet. */
export const FACET_META: Record<FacetKind, { icon: string; tab: string; title: string }> = {
  docker: { icon: 'docker', tab: 'Containers', title: 'Docker Engine' },
  swarm: { icon: 'layers', tab: 'Cluster', title: 'Swarm Cluster' },
  proxmox: { icon: 'server', tab: 'Guests', title: 'Proxmox VE Node' },
};
