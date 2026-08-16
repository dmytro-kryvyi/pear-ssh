import { Injectable, inject, signal } from '@angular/core';
import type { HostGroup } from '@pear/core';
import { Pear } from '../pear';

/**
 * Host groups — "Workspaces" in the UI. Named, colored sets of hosts a host
 * can belong to any number of; the sidebar switcher scopes the host list to
 * one of them. Persisted in the main process (workspaces.json).
 */
@Injectable({ providedIn: 'root' })
export class HostGroups {
  private readonly pear = inject(Pear);

  readonly groups = signal<HostGroup[]>([]);

  byId(id: string | null): HostGroup | null {
    return id ? (this.groups().find((g) => g.id === id) ?? null) : null;
  }

  countFor(groupId: string): number {
    return this.byId(groupId)?.hostIds.length ?? 0;
  }

  groupsOf(hostId: string): HostGroup[] {
    return this.groups().filter((g) => g.hostIds.includes(hostId));
  }

  async refresh(): Promise<void> {
    if (!this.pear.available) return;
    this.groups.set(await this.pear.api.hostGroups.list());
  }

  async upsert(group: Omit<HostGroup, 'id'> & { id?: string }): Promise<HostGroup> {
    const saved = await this.pear.api.hostGroups.upsert(group);
    await this.refresh();
    return saved;
  }

  async remove(id: string): Promise<void> {
    await this.pear.api.hostGroups.remove(id);
    await this.refresh();
  }

  async setMembership(hostId: string, groupId: string, member: boolean): Promise<void> {
    await this.pear.api.hostGroups.setMembership(hostId, groupId, member);
    await this.refresh();
  }
}
