import { Component, computed, inject, output, signal } from '@angular/core';
import type { HostConfig } from '@pear/core';
import { ORCH_ICON, PmHeader, PmHostDot, PmIconBtn, PmWsGlyph } from '../chrome/chrome';
import { PmIcon } from '../icons/icon';
import { PearSession } from '../state/session';
import { PmHostRow } from './host-row';

/** Hosts screen — workspace strip, recents, searchable host list. */
@Component({
  selector: 'pm-hosts-screen',
  imports: [PmHeader, PmIconBtn, PmIcon, PmHostDot, PmWsGlyph, PmHostRow],
  templateUrl: './hosts-screen.html',
  styleUrl: './hosts-screen.scss',
})
export class PmHostsScreen {
  readonly connect = output<HostConfig>();

  protected readonly session = inject(PearSession);
  protected readonly query = signal('');

  protected readonly scoped = computed(() => this.session.wsHosts());
  protected readonly online = computed(
    () => this.scoped().filter((h) => this.session.statusOf(h.id) === 'online').length,
  );
  protected readonly title = computed(() => this.session.activeWs()?.name ?? 'All hosts');
  protected readonly subtitle = computed(() => {
    const ws = this.session.activeWs();
    return `${this.online()} of ${this.scoped().length} online${ws?.desc ? ' · ' + ws.desc : ''}`;
  });

  protected readonly filtered = computed(() => {
    const q = this.query().trim().toLowerCase();
    const pool = q ? this.session.hosts() : this.scoped();
    if (!q) return pool;
    return pool.filter(
      (h) =>
        h.name.toLowerCase().includes(q) ||
        h.host.toLowerCase().includes(q) ||
        (h.aliases ?? []).some((a) => a.toLowerCase().includes(q)),
    );
  });

  protected readonly ORCH_ICON = ORCH_ICON;

  protected newHost(): void {
    this.session.editHost.set(this.session.blankHost());
  }
  protected editWs(id: string): void {
    const ws = this.session.groups().find((w) => w.id === id);
    if (ws) this.session.editWs.set(structuredClone(ws));
  }
  protected newWs(): void {
    this.session.editWs.set(this.session.blankWs());
  }
  protected editHost(h: HostConfig): void {
    this.session.editHost.set(structuredClone(h));
  }
}
