import { Component, computed, inject, input } from '@angular/core';
import type { HostConfig, MountUsage } from '@pear/core';
import { PearIcon } from '../icons/icon';
import { Settings } from '../settings';
import { MonitorStore, type HostMonitorState } from './store';
import { Sparkline } from './sparkline';
import { bytes, memPair, rate, tone, uptime } from '../orch/format';

const MAX_MOUNTS = 5;

/**
 * Host-level CPU / memory / disk / network band, fed by the MonitorStore
 * poll loop. Renders nothing until the host has state, and never for hosts
 * that proved unsupported (no /proc).
 */
@Component({
  selector: 'pear-vitals',
  imports: [PearIcon, Sparkline],
  templateUrl: './vitals-band.html',
  styleUrl: './vitals-band.scss',
})
export class VitalsBand {
  readonly host = input.required<HostConfig>();

  readonly settings = inject(Settings);
  private readonly store = inject(MonitorStore);

  readonly st = computed<HostMonitorState | undefined>(
    () => this.store.states()[this.host().id],
  );
  readonly live = computed(() => this.settings.liveStats());
  readonly latest = computed(() => this.st()?.latest);
  readonly point = computed(() => this.st()?.point);

  readonly cpuHist = computed(() => (this.st()?.history ?? []).map((p) => p.cpuPct));
  readonly memHist = computed(() => (this.st()?.history ?? []).map((p) => p.memPct));
  readonly netHist = computed(() =>
    (this.st()?.history ?? []).map((p) =>
      p.rxRate == null || p.txRate == null ? null : p.rxRate + p.txRate,
    ),
  );

  readonly memUsed = computed(() => {
    const l = this.latest();
    return l ? (l.memTotalKB - l.memAvailableKB) * 1024 : null;
  });
  readonly swapUsed = computed(() => {
    const l = this.latest();
    return l ? (l.swapTotalKB - l.swapFreeKB) * 1024 : null;
  });

  readonly mounts = computed(() => (this.latest()?.mounts ?? []).slice(0, MAX_MOUNTS));
  readonly hiddenMounts = computed(() =>
    Math.max(0, (this.latest()?.mounts.length ?? 0) - MAX_MOUNTS),
  );
  readonly worstDisk = computed(() => {
    const mounts = this.latest()?.mounts ?? [];
    return mounts.reduce((worst, m) => Math.max(worst, this.mountPct(m)), 0);
  });
  readonly netTotal = computed(() => {
    const p = this.point();
    return p?.rxRate == null || p.txRate == null ? null : p.rxRate + p.txRate;
  });

  mountPct(m: MountUsage): number {
    return m.totalKB > 0 ? (m.usedKB / m.totalKB) * 100 : 0;
  }
  kb(n: number): string {
    return bytes(n * 1024);
  }

  sampleNow(): void {
    void this.store.sampleNow(this.host().id);
  }

  readonly bytes = bytes;
  readonly memPair = memPair;
  readonly rate = rate;
  readonly tone = tone;
  readonly uptime = uptime;
  readonly Math = Math;
}
