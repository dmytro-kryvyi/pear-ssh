import type { Favourite } from '../types';
import { uuid } from '../uuid';
import type { HostStorage } from './store';

/**
 * Favourite folders persisted as a JSON array through the same storage
 * abstraction as hosts. A corrupt or missing file degrades to no favourites.
 */
export class FavouriteStore {
  private favs: Favourite[] = [];

  constructor(private readonly storage: HostStorage) {
    try {
      const raw = storage.read();
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      this.favs = Array.isArray(parsed) ? parsed.filter(isFavourite) : [];
    } catch {
      this.favs = [];
    }
  }

  list(): Favourite[] {
    return this.favs.map((f) => ({ ...f }));
  }

  /**
   * Without an id, a host+path that is already saved returns the existing
   * entry untouched, so starring a folder twice never makes a twin. With an
   * id the entry is replaced (rename); an unknown id is added.
   */
  upsert(fav: Omit<Favourite, 'id'> & { id?: string }): Favourite {
    const path = normalize(fav.path);
    if (!fav.hostId || !path.startsWith('/')) {
      throw new Error('A favourite needs a host and an absolute path');
    }
    if (!fav.id) {
      const existing = this.favs.find((f) => f.hostId === fav.hostId && f.path === path);
      if (existing) return { ...existing };
    }
    const label = fav.label?.trim();
    const saved: Favourite = { id: fav.id ?? uuid(), hostId: fav.hostId, path };
    if (label) saved.label = label;
    if (this.favs.some((f) => f.id === saved.id)) {
      this.favs = this.favs.map((f) => (f.id === saved.id ? saved : f));
    } else {
      this.favs.push(saved);
    }
    this.persist();
    return { ...saved };
  }

  remove(id: string): void {
    const next = this.favs.filter((f) => f.id !== id);
    if (next.length === this.favs.length) return;
    this.favs = next;
    this.persist();
  }

  /** Drop every favourite of a removed host. */
  removeHostRefs(hostId: string): void {
    const next = this.favs.filter((f) => f.hostId !== hostId);
    if (next.length === this.favs.length) return;
    this.favs = next;
    this.persist();
  }

  private persist(): void {
    this.storage.write(JSON.stringify(this.favs, null, 2));
  }
}

/** '/srv/www/' and '/srv/www' are one folder; '/' stays '/'. */
function normalize(path: string): string {
  const p = String(path ?? '').trim();
  return p.length > 1 ? p.replace(/\/+$/, '') || '/' : p;
}

function isFavourite(v: unknown): v is Favourite {
  const f = v as Favourite | null;
  return !!f && typeof f.id === 'string' && typeof f.hostId === 'string' && typeof f.path === 'string';
}
