import type { HostGroup } from '../types';
import { uuid } from '../uuid';
import type { HostStorage } from './store';

/**
 * Host groups ("Workspaces" in the UI) persisted as a JSON array through the
 * same storage abstraction as hosts. A corrupt or missing file degrades to no
 * groups — the "All hosts" pseudo-group always exists UI-side.
 */
export class HostGroupStore {
  private groups: HostGroup[] = [];

  constructor(private readonly storage: HostStorage) {
    try {
      const raw = storage.read();
      this.groups = raw ? JSON.parse(raw) : [];
    } catch {
      this.groups = [];
    }
  }

  list(): HostGroup[] {
    return this.groups.map((g) => ({ ...g, hostIds: [...g.hostIds] }));
  }

  get(id: string): HostGroup | undefined {
    return this.groups.find((g) => g.id === id);
  }

  upsert(group: Omit<HostGroup, 'id'> & { id?: string }): HostGroup {
    const saved: HostGroup = {
      ...group,
      id: group.id ?? uuid(),
      hostIds: [...new Set(group.hostIds ?? [])],
    };
    if (this.groups.some((g) => g.id === saved.id)) {
      this.groups = this.groups.map((g) => (g.id === saved.id ? saved : g));
    } else {
      this.groups.push(saved);
    }
    this.persist();
    return { ...saved, hostIds: [...saved.hostIds] };
  }

  remove(id: string): void {
    this.groups = this.groups.filter((g) => g.id !== id);
    this.persist();
  }

  /** Add or remove one host from one group. No-op on unknown group. */
  setMembership(hostId: string, groupId: string, member: boolean): void {
    const group = this.get(groupId);
    if (!group) return;
    const has = group.hostIds.includes(hostId);
    if (member === has) return;
    group.hostIds = member ? [...group.hostIds, hostId] : group.hostIds.filter((h) => h !== hostId);
    this.persist();
  }

  /** Drop a removed host from every group. */
  removeHostRefs(hostId: string): void {
    let changed = false;
    for (const g of this.groups) {
      if (g.hostIds.includes(hostId)) {
        g.hostIds = g.hostIds.filter((h) => h !== hostId);
        changed = true;
      }
    }
    if (changed) this.persist();
  }

  private persist(): void {
    this.storage.write(JSON.stringify(this.groups, null, 2));
  }
}
