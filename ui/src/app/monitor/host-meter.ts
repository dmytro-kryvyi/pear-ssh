import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { MonitorStore, type HostMonitorState } from './store';
import { tone } from '../orch/format';

/**
 * Two 3px CPU / memory lines under a sidebar host row. Renders nothing until
 * the host has a sample, so unsupported and just-connected hosts cost no
 * vertical space.
 */
@Component({
  selector: 'pear-hostmeter',
  template: `
    @if (point(); as p) {
      <div class="meter" [title]="label()">
        <div class="bar">
          <div class="fill" [style.width.%]="p.cpuPct ?? 0" [style.background]="cpuColor()"></div>
        </div>
        <div class="bar">
          <div class="fill mem" [style.width.%]="p.memPct"></div>
        </div>
      </div>
    }
  `,
  styles: `
    .meter { display: flex; flex-direction: column; gap: 2px; margin-top: 4px; }
    .bar { height: 3px; border-radius: 999px; background: var(--bg-3); overflow: hidden; }
    .fill { height: 100%; border-radius: 999px; transition: width 0.4s ease; }
    .fill.mem { background: var(--fg-3); }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class HostMeter {
  readonly hostId = input.required<string>();

  private readonly store = inject(MonitorStore);

  readonly point = computed(
    () => (this.store.states()[this.hostId()] as HostMonitorState | undefined)?.point,
  );
  readonly cpuColor = computed(() => `var(--${tone(this.point()?.cpuPct ?? 0)})`);
  readonly label = computed(() => {
    const p = this.point();
    if (!p) return '';
    const cpu = p.cpuPct == null ? '—' : `${Math.round(p.cpuPct)}%`;
    return `cpu ${cpu} · mem ${Math.round(p.memPct)}%`;
  });
}
