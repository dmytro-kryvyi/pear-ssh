import type { HostConfig } from '../types';
import { uuid } from '../uuid';

/**
 * Session-scoped sub-hosts: created by "jump in", never persisted. Pinning
 * moves an entry into the HostStore under the same id (so open terminals and
 * editors keep working); unpinning restores it here, again with its id kept.
 */
export class EphemeralHostRegistry {
  private hosts = new Map<string, HostConfig>();

  /** Register a sub-host; mints an id unless one is given (unpin restore). */
  add(config: Omit<HostConfig, 'id'> & { id?: string }): HostConfig {
    const saved: HostConfig = { ...config, id: config.id ?? uuid() };
    this.hosts.set(saved.id, saved);
    return { ...saved };
  }

  get(id: string): HostConfig | undefined {
    return this.hosts.get(id);
  }

  update(config: HostConfig): void {
    if (this.hosts.has(config.id)) this.hosts.set(config.id, config);
  }

  list(): HostConfig[] {
    return [...this.hosts.values()].map((h) => ({ ...h }));
  }

  remove(id: string): void {
    this.hosts.delete(id);
  }

  /** Drop all (transitive) descendants of parentId; returns the removed ids. */
  removeByParent(parentId: string): string[] {
    const removed: string[] = [];
    const queue = [parentId];
    while (queue.length) {
      const current = queue.shift()!;
      for (const h of this.hosts.values()) {
        if (h.parentId === current) {
          this.hosts.delete(h.id);
          removed.push(h.id);
          queue.push(h.id);
        }
      }
    }
    return removed;
  }
}
