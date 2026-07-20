import type { HostConfig } from '../types';
import { uuid } from '../uuid';

/**
 * Where the inventory JSON lives. Injected by the embedder: a file under
 * Electron's userData today, a daemon's config dir or Capacitor Preferences
 * tomorrow. `read` returns null when nothing has been stored yet.
 */
export interface HostStorage {
  read(): string | null;
  write(data: string): void;
}

/**
 * Host inventory persisted as JSON through an injected HostStorage.
 * Passwords are never persisted — auth.password is stripped on save.
 */
export class HostStore {
  private hosts: HostConfig[] = [];

  constructor(private readonly storage: HostStorage) {
    try {
      const raw = storage.read();
      this.hosts = raw ? JSON.parse(raw) : [];
    } catch {
      this.hosts = [];
    }
  }

  list(): HostConfig[] {
    return this.hosts.map((h) => ({ ...h }));
  }

  get(id: string): HostConfig | undefined {
    return this.hosts.find((h) => h.id === id);
  }

  upsert(host: Omit<HostConfig, 'id'> & { id?: string }): HostConfig {
    const existing = host.id ? this.get(host.id) : undefined;
    const saved: HostConfig = { ...host, id: host.id ?? uuid() };
    if (existing) {
      this.hosts = this.hosts.map((h) => (h.id === saved.id ? saved : h));
    } else {
      this.hosts.push(saved);
    }
    this.persist();
    return { ...saved };
  }

  remove(id: string): void {
    this.hosts = this.hosts.filter((h) => h.id !== id);
    this.persist();
  }

  private persist(): void {
    const sanitized = this.hosts.map((h) => ({
      ...h,
      auth: h.auth ? { ...h.auth, password: undefined } : undefined,
    }));
    this.storage.write(JSON.stringify(sanitized, null, 2));
  }
}
