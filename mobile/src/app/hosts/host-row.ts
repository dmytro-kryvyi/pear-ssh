import { Component, computed, inject, input, output } from '@angular/core';
import { shortLabel, type HostConfig } from '@pear/core';
import { ORCH_ICON, PmHostDot } from '../chrome/chrome';
import { PmIcon } from '../icons/icon';
import { PearSession } from '../state/session';
import { wsColor } from '../util/fmt';

/** One host row — hosts screen, host picker sheet and tablet rail (compact). */
@Component({
  selector: 'pm-host-row',
  imports: [PmIcon, PmHostDot],
  templateUrl: './host-row.html',
  styleUrl: './host-row.scss',
})
export class PmHostRow {
  readonly h = input.required<HostConfig>();
  readonly active = input(false);
  readonly compact = input(false);
  readonly tap = output<HostConfig>();
  readonly edit = output<HostConfig>();

  protected readonly session = inject(PearSession);

  protected readonly stripe = computed(() => wsColor(this.h().color));
  protected readonly kindIcon = computed(() => ORCH_ICON[this.h().kind] ?? 'docker');
  protected readonly short = computed(() => shortLabel(this.h()));
  protected readonly members = computed(() => this.session.groupsOf(this.h().id));
  protected readonly memberNames = computed(() => this.members().map((w) => w.name).join(', '));
  protected readonly extraEps = computed(() => Math.max(0, (this.h().endpoints?.length ?? 0) - 1));
  protected readonly wsColor = wsColor;
}
