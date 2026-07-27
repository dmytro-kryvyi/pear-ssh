import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import type { CpuTicks, HostVitalsSample } from '@pear/core';
import { Pear } from '../pear';
import { Settings } from '../settings';
import { Workspace } from '../workspace/workspace';
import { OrchStore } from '../orch/store';

/** One derived history entry — deltas against the previous sample applied. */
export interface VitalsPoint {
  at: number;
  /** 0..100, null until a second sample exists. */
  cpuPct: number | null;
  corePcts: (number | null)[];
  memPct: number;
  swapPct: number;
  /** Bytes/sec across physical interfaces, null until a second sample. */
  rxRate: number | null;
  txRate: number | null;
  /** Busiest physical interface this tick. */
  iface: string | null;
}

export interface HostMonitorState {
  /** False once the host proved to have no readable /proc. */
  supported: boolean;
  /** Sampling gave up (3 straight failures) — values shown are last known. */
  stale: boolean;
  failures: number;
  latest?: HostVitalsSample;
  point?: VitalsPoint;
  history: VitalsPoint[];
}

const HISTORY = 48;
const MAX_FAILURES = 3;

// Interfaces that only mirror traffic already counted on a physical one.
const VIRTUAL_IF = /^(veth|docker|br-|virbr|vnet|tap|tun|fwbr|fwpr|fwln|flannel|cni|cali|kube)/;

function cpuPctOf(prev: CpuTicks | undefined, cur: CpuTicks): number | null {
  if (!prev) return null;
  const dTotal = cur.total - prev.total;
  if (dTotal <= 0) return null;
  const dIdle = cur.idle - prev.idle;
  return Math.min(100, Math.max(0, (1 - dIdle / dTotal) * 100));
}

function derivePoint(prev: HostVitalsSample | undefined, cur: HostVitalsSample): VitalsPoint {
  let rxRate: number | null = null;
  let txRate: number | null = null;
  let iface: string | null = null;
  const dtSec = prev ? (cur.at - prev.at) / 1000 : 0;
  if (prev && dtSec > 0) {
    const before = new Map(prev.net.map((n) => [n.name, n]));
    let rx = 0;
    let tx = 0;
    let busiest = -1;
    let counted = false;
    for (const n of cur.net) {
      if (VIRTUAL_IF.test(n.name)) continue;
      const p = before.get(n.name);
      if (!p) continue;
      const dRx = n.rxBytes - p.rxBytes;
      const dTx = n.txBytes - p.txBytes;
      if (dRx < 0 || dTx < 0) continue; // counter reset
      counted = true;
      rx += dRx;
      tx += dTx;
      if (dRx + dTx > busiest) {
        busiest = dRx + dTx;
        iface = n.name;
      }
    }
    if (counted) {
      rxRate = rx / dtSec;
      txRate = tx / dtSec;
    }
  }
  return {
    at: cur.at,
    cpuPct: cpuPctOf(prev?.cpu, cur.cpu),
    corePcts: cur.cores.map((c, i) => cpuPctOf(prev?.cores[i], c)),
    memPct: cur.memTotalKB > 0 ? (1 - cur.memAvailableKB / cur.memTotalKB) * 100 : 0,
    swapPct: cur.swapTotalKB > 0 ? (1 - cur.swapFreeKB / cur.swapTotalKB) * 100 : 0,
    rxRate,
    txRate,
    iface,
  };
}

/**
 * The resource monitor: Pear's one polling loop. One vitals round-trip per
 * targeted host per tick; raw counter samples come from core, deltas and
 * history live here. Targets are set from app wiring (connected hosts);
 * pausing is the global `liveStats` setting, matching the design.
 */
@Injectable({ providedIn: 'root' })
export class MonitorStore {
  private readonly pear = inject(Pear);
  private readonly settings = inject(Settings);
  private readonly ws = inject(Workspace);
  private readonly orch = inject(OrchStore);

  readonly states = signal<Readonly<Record<string, HostMonitorState>>>({});
  readonly targets = signal<ReadonlySet<string>>(new Set());

  private readonly inflight = new Set<string>();
  private readonly statsInflight = new Set<string>();

  /** Hosts whose active pane tab is a docker orchestration view. */
  private readonly visibleDockerHosts = computed<ReadonlySet<string>>(() => {
    const ids = new Set<string>();
    for (const pane of this.ws.panes()) {
      const tab = pane.tabs.find((t) => t.id === pane.activeTabId);
      if (tab?.kind === 'orch' && tab.facet === 'docker') ids.add(tab.hostId);
    }
    return ids;
  });

  constructor() {
    effect((onCleanup) => {
      const ids = this.targets();
      const live = this.settings.liveStats();
      const seconds = this.settings.monitorInterval();
      // First sample for fresh targets right away — the band shouldn't sit
      // empty for a whole interval after connecting.
      untracked(() => this.tick(ids));
      if (!live || ids.size === 0) return;
      const timer = setInterval(() => this.tick(this.targets()), seconds * 1000);
      onCleanup(() => clearInterval(timer));
    });
  }

  setTargets(ids: ReadonlySet<string>): void {
    const current = this.targets();
    if (current.size === ids.size && [...ids].every((id) => current.has(id))) return;
    this.targets.set(new Set(ids));
  }

  /** Manual sample — also the way out of the given-up (stale) state. */
  async sampleNow(hostId: string): Promise<void> {
    this.states.update((all) => {
      const st = all[hostId];
      return st ? { ...all, [hostId]: { ...st, stale: false, failures: 0 } } : all;
    });
    await this.sampleHost(hostId, true);
  }

  /** Host disconnected: forget everything about it. */
  drop(hostId: string): void {
    this.states.update((all) => {
      const { [hostId]: _removed, ...rest } = all;
      return rest;
    });
  }

  private tick(ids: ReadonlySet<string>): void {
    if (document.hidden) return; // nobody is looking; skip the round-trips
    for (const id of ids) void this.sampleHost(id, false);
    if (this.settings.containerStats()) this.statsTick(ids);
  }

  private async sampleHost(hostId: string, force: boolean): Promise<void> {
    const st = this.states()[hostId];
    if (st && !st.supported) return;
    if (!force && st?.stale) return;
    if (this.inflight.has(hostId)) return;
    this.inflight.add(hostId);
    try {
      const sample = await this.pear.api.monitor.sample(hostId);
      this.ingest(hostId, sample);
    } catch (err) {
      this.fail(hostId, err);
    } finally {
      this.inflight.delete(hostId);
    }
  }

  private ingest(hostId: string, sample: HostVitalsSample): void {
    this.states.update((all) => {
      const prev = all[hostId];
      const point = derivePoint(prev?.latest, sample);
      const history = [...(prev?.history ?? []), point].slice(-HISTORY);
      return {
        ...all,
        [hostId]: { supported: true, stale: false, failures: 0, latest: sample, point, history },
      };
    });
  }

  private fail(hostId: string, err: unknown): void {
    const msg = err instanceof Error ? err.message : String(err);
    const unsupported = msg.includes('vitals unsupported');
    this.states.update((all) => {
      const prev = all[hostId] ?? { supported: true, stale: false, failures: 0, history: [] };
      if (unsupported) return { ...all, [hostId]: { ...prev, supported: false, stale: true } };
      const failures = prev.failures + 1;
      return { ...all, [hostId]: { ...prev, failures, stale: failures >= MAX_FAILURES } };
    });
  }

  /**
   * The container-stats rider: same tick, but only hosts whose docker page
   * is actually on screen. `docker stats` takes a couple of seconds — while
   * one is pending its host just skips ticks.
   */
  private statsTick(targets: ReadonlySet<string>): void {
    for (const id of this.visibleDockerHosts()) {
      if (!targets.has(id) || this.statsInflight.has(id)) continue;
      this.statsInflight.add(id);
      this.pear.api.monitor
        .stats(id)
        .then((stats) => this.orch.applyStats(id, stats))
        .catch(() => {}) // best-effort, like the snapshot stats
        .finally(() => this.statsInflight.delete(id));
    }
  }
}
