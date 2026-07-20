import { Injectable, computed, inject, signal } from '@angular/core';
import type { HostConfig } from '@pear/core';
import { Pear } from './pear';

/** Deterministic per-host accent for tab dots — stable across sessions. */
const HOST_HUES = [190, 240, 295, 75, 25, 150, 330, 50];

/**
 * The host inventory as a root service: persisted hosts plus session-scoped
 * sub-hosts, addressable from any component (panes, transfers, menus) rather
 * than only through the app shell.
 */
@Injectable({ providedIn: 'root' })
export class HostCatalog {
  private readonly pear = inject(Pear);

  readonly hosts = signal<HostConfig[]>([]);
  /** Session-scoped sub-hosts (jump-in targets, not yet pinned). */
  readonly subHosts = signal<HostConfig[]>([]);

  readonly all = computed(() => [...this.hosts(), ...this.subHosts()]);
  readonly roots = computed(() => this.all().filter((h) => !h.parentId));

  byId(id: string | null): HostConfig | null {
    return id ? (this.all().find((h) => h.id === id) ?? null) : null;
  }

  nameOf(id: string | null): string {
    if (id === null) return 'my machine';
    return this.byId(id)?.name ?? 'unknown host';
  }

  color(id: string): string {
    let hash = 0;
    for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
    const hue = HOST_HUES[Math.abs(hash) % HOST_HUES.length];
    return `oklch(0.72 0.11 ${hue})`;
  }

  async refresh(): Promise<void> {
    this.hosts.set(await this.pear.api.hosts.list());
    this.subHosts.set(await this.pear.api.subhosts.list());
  }
}
