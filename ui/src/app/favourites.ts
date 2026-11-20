import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import type { Favourite, HostConfig } from '@pear/core';
import { Pear } from './pear';
import { HostCatalog } from './hosts';

export interface FavouriteRow {
  fav: Favourite;
  host: HostConfig;
  label: string;
}

/**
 * Favourite folders across hosts. Persisted by the backend (favourites.json),
 * so the same list shows on every device that talks to it.
 */
@Injectable({ providedIn: 'root' })
export class Favourites {
  private readonly pear = inject(Pear);
  private readonly catalog = inject(HostCatalog);

  readonly list = signal<Favourite[]>([]);
  /** Last failed change, shown under the sidebar section until the next one. */
  readonly error = signal<string | null>(null);

  private readonly index = computed(
    () => new Map(this.list().map((f) => [key(f.hostId, f.path), f])),
  );

  /** Rows for the sidebar, kept together per host in inventory order. A
   *  favourite whose host is not in the inventory is left out. */
  readonly rows = computed<FavouriteRow[]>(() => {
    const order = new Map(this.catalog.hosts().map((h, i) => [h.id, i]));
    return this.list()
      .map((fav) => ({ fav, host: this.catalog.byId(fav.hostId) }))
      .filter((r): r is { fav: Favourite; host: HostConfig } => !!r.host)
      .map((r) => ({ ...r, label: r.fav.label || baseName(r.fav.path) }))
      .sort((a, b) => (order.get(a.host.id) ?? 0) - (order.get(b.host.id) ?? 0));
  });

  constructor() {
    // The backend drops a removed host's favourites; reloading whenever the
    // inventory changes keeps this copy in step (and does the first load).
    effect(() => {
      this.catalog.hosts();
      untracked(() => void this.refresh());
    });
  }

  find(hostId: string, path: string): Favourite | null {
    return this.index().get(key(hostId, path)) ?? null;
  }

  /** Whether a folder on this host can be saved at all. */
  canSave(hostId: string, path: string): boolean {
    return path.startsWith('/') && this.catalog.pinnedIds().has(hostId);
  }

  async refresh(): Promise<void> {
    if (!this.pear.available) return;
    try {
      this.list.set(await this.pear.api.favourites.list());
    } catch {
      // Keep the list we have; the next inventory change retries.
    }
  }

  async toggle(hostId: string, path: string): Promise<void> {
    const existing = this.find(hostId, path);
    await this.run(() =>
      existing
        ? this.pear.api.favourites.remove(existing.id)
        : this.pear.api.favourites.upsert({ hostId, path }),
    );
  }

  async rename(fav: Favourite, label: string): Promise<void> {
    await this.run(() => this.pear.api.favourites.upsert({ ...fav, label }));
  }

  async remove(id: string): Promise<void> {
    await this.run(() => this.pear.api.favourites.remove(id));
  }

  private async run(change: () => Promise<unknown>): Promise<void> {
    this.error.set(null);
    try {
      await change();
    } catch (e) {
      this.error.set(e instanceof Error ? e.message : String(e));
    }
    await this.refresh();
  }
}

const key = (hostId: string, path: string): string => `${hostId}\n${trimSlash(path)}`;
const trimSlash = (p: string): string => (p.length > 1 ? p.replace(/\/+$/, '') || '/' : p);
const baseName = (p: string): string => trimSlash(p).split('/').pop() || '/';
