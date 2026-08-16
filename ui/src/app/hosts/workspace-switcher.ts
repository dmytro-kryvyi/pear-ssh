import { Component, computed, inject, input, output, signal } from '@angular/core';
import type { HostGroup } from '@pear/core';
import { HOST_COLORS, HostCatalog } from '../hosts';
import { HostGroups } from './groups';
import { Settings } from '../settings';
import { PearIcon } from '../icons/icon';

export const HOST_DRAG_TYPE = 'application/x-pear-host';

/**
 * Workspace switcher at the top of the sidebar: the active host group with a
 * dropdown of all groups (plus "All hosts"), per-group edit, and drop targets
 * for dragging a host row onto a group.
 */
@Component({
  selector: 'pear-workspace-switcher',
  imports: [PearIcon],
  templateUrl: './workspace-switcher.html',
  styleUrl: './workspace-switcher.scss',
})
export class WorkspaceSwitcher {
  readonly catalog = inject(HostCatalog);
  readonly groups = inject(HostGroups);
  readonly settings = inject(Settings);

  /** Hosts with a live connection — for the online/total counter. */
  readonly connectedIds = input.required<ReadonlySet<string>>();

  readonly editGroup = output<HostGroup>();
  readonly newGroup = output<void>();

  readonly open = signal(false);
  readonly dragOver = signal<string | null>(null);

  readonly active = computed(() => this.groups.byId(this.settings.activeGroup()));

  glyph(group: HostGroup | null): string {
    return group?.icon ?? 'server';
  }

  colorOf(group: HostGroup | null): string {
    return group ? HOST_COLORS[group.color] : 'var(--accent)';
  }

  /** Root hosts a group scopes to (all roots for the pseudo-group). */
  countFor(group: HostGroup | null): number {
    if (!group) return this.catalog.roots().length;
    return this.catalog.roots().filter((h) => group.hostIds.includes(h.id)).length;
  }

  onlineFor(group: HostGroup | null): number {
    const connected = this.connectedIds();
    const roots = group
      ? this.catalog.roots().filter((h) => group.hostIds.includes(h.id))
      : this.catalog.roots();
    return roots.filter((h) => connected.has(h.id)).length;
  }

  select(groupId: string): void {
    this.settings.activeGroup.set(groupId);
    this.open.set(false);
  }

  edit(event: MouseEvent, group: HostGroup): void {
    event.stopPropagation();
    this.open.set(false);
    this.editGroup.emit(group);
  }

  create(): void {
    this.open.set(false);
    this.newGroup.emit();
  }

  onDragOver(event: DragEvent, groupId: string): void {
    if (!event.dataTransfer?.types.includes(HOST_DRAG_TYPE)) return;
    event.preventDefault();
    this.dragOver.set(groupId);
  }

  async onDrop(event: DragEvent, group: HostGroup): Promise<void> {
    const hostId = event.dataTransfer?.getData(HOST_DRAG_TYPE);
    this.dragOver.set(null);
    if (!hostId) return;
    event.preventDefault();
    await this.groups.setMembership(hostId, group.id, true);
  }
}
