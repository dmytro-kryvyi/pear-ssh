import { Component, computed, inject, input, output } from '@angular/core';
import type {
  ContainerInfo,
  ProxmoxFacet,
  ProxmoxGuestInfo,
  SwarmFacet,
  SwarmServiceInfo,
} from '@pear/core';
import { PmHeader, PmIconBtn, PmStateDot, type StateTone } from '../chrome/chrome';
import { PmIcon } from '../icons/icon';
import { PearSession } from '../state/session';
import { fmtMemPair, fmtPct, fmtUptime, pseudoCpu, pseudoMemFrac } from '../util/fmt';

function tone(pct: number): 'accent' | 'warn' | 'err' {
  return pct >= 88 ? 'err' : pct >= 70 ? 'warn' : 'accent';
}

@Component({
  selector: 'pm-gauge',
  template: `
    <div class="top">
      <span class="lbl">{{ label() }}</span>
      <span class="val">{{ valText() }}</span>
    </div>
    <div class="bar">
      <div class="fill" [style.width.%]="width()" [style.background]="color()"></div>
    </div>
  `,
  styles: `
    :host { display: flex; flex-direction: column; gap: 4px; }
    .top { display: flex; justify-content: space-between; font-family: var(--mono); font-size: 11px; }
    .lbl { color: var(--fg-3); text-transform: uppercase; letter-spacing: 0.04em; font-size: 10.5px; }
    .val { color: var(--fg-1); }
    .bar { height: 6px; border-radius: 999px; background: var(--bg-0); overflow: hidden; }
    .fill { height: 100%; border-radius: 999px; transition: width 0.4s ease; }
  `,
})
export class PmGauge {
  readonly label = input.required<string>();
  readonly valText = input.required<string>();
  readonly pct = input.required<number>();
  protected readonly width = computed(() => Math.max(2, Math.min(100, this.pct())));
  protected readonly color = computed(() => {
    const t = tone(this.pct());
    return t === 'err' ? 'var(--err)' : t === 'warn' ? 'var(--warn)' : 'var(--accent)';
  });
}

const KIND_TITLE: Record<string, string> = {
  docker: 'Docker Engine',
  swarm: 'Swarm Cluster',
  proxmox: 'Proxmox VE',
};

/** Orchestration screen — host-kind-aware cards (design src-mobile/orch.jsx). */
@Component({
  selector: 'pm-orch-screen',
  imports: [PmHeader, PmIconBtn, PmIcon, PmStateDot, PmGauge],
  templateUrl: './orch-screen.html',
  styleUrl: './orch-screen.scss',
})
export class PmOrchScreen {
  readonly hostTap = output<void>();

  protected readonly session = inject(PearSession);

  protected readonly facet = computed<'swarm' | 'proxmox' | 'docker'>(() => {
    const o = this.session.orch();
    if (o?.swarm) return 'swarm';
    if (o?.proxmox) return 'proxmox';
    return 'docker';
  });
  protected readonly title = computed(() => KIND_TITLE[this.facet()]);

  protected readonly containers = computed<ContainerInfo[]>(
    () => this.session.orch()?.docker?.containers ?? [],
  );
  protected readonly swarm = computed<SwarmFacet | null>(() => this.session.orch()?.swarm ?? null);
  protected readonly proxmox = computed<ProxmoxFacet | null>(() => this.session.orch()?.proxmox ?? null);

  // ---- docker KPIs ---------------------------------------------------------
  protected readonly dockerRunning = computed(() => this.containers().filter((c) => c.running).length);
  protected readonly dockerImages = computed(
    () => new Set(this.containers().map((c) => c.image.split(':')[0])).size,
  );
  protected readonly dockerPorts = computed(() =>
    this.containers().reduce((n, c) => n + (c.ports === '—' || !c.ports ? 0 : c.ports.split(',').length), 0),
  );

  // ---- swarm KPIs ----------------------------------------------------------
  protected readonly managers = computed(() => this.swarm()?.nodes.filter((n) => n.role === 'manager').length ?? 0);
  protected readonly workers = computed(() => this.swarm()?.nodes.filter((n) => n.role === 'worker').length ?? 0);
  protected readonly nodesDown = computed(() => this.swarm()?.nodes.filter((n) => !n.ready).length ?? 0);
  protected readonly converged = computed(
    () => this.swarm()?.services.filter((s) => s.running === s.desired).length ?? 0,
  );
  protected readonly tasksRunning = computed(() => this.swarm()?.services.reduce((n, s) => n + s.running, 0) ?? 0);
  protected readonly tasksDesired = computed(() => this.swarm()?.services.reduce((n, s) => n + s.desired, 0) ?? 0);

  // ---- proxmox KPIs --------------------------------------------------------
  protected readonly guestsUp = computed(() => this.proxmox()?.guests.filter((g) => g.running).length ?? 0);
  protected readonly vmCount = computed(() => this.proxmox()?.guests.filter((g) => g.type === 'vm').length ?? 0);
  protected readonly ctCount = computed(() => (this.proxmox()?.guests.length ?? 0) - this.vmCount());
  protected readonly memPct = computed(() => {
    const r = this.proxmox()?.resources;
    return r?.maxmem ? Math.round((r.mem / r.maxmem) * 100) : null;
  });
  protected readonly diskPct = computed(() => {
    const r = this.proxmox()?.resources;
    return r?.maxdisk ? Math.round((r.disk / r.maxdisk) * 100) : null;
  });

  // ---- helpers -------------------------------------------------------------
  protected cpuPct(c: ContainerInfo): number {
    return c.cpu != null ? Math.round(c.cpu * 100) : 0;
  }
  protected memPctOf(c: ContainerInfo): number {
    return c.mem != null && c.maxmem ? Math.round((c.mem / c.maxmem) * 100) : 0;
  }
  protected nodeCpu(name: string): number {
    return Math.round(pseudoCpu(name) * 100);
  }
  protected nodeMem(name: string): number {
    return Math.round(pseudoMemFrac(name) * 100);
  }
  protected svcTone(s: SwarmServiceInfo): StateTone {
    return s.running === 0 ? 'off' : s.running === s.desired ? 'ok' : 'warn';
  }
  protected replicaSlots(s: SwarmServiceInfo): boolean[] {
    const total = Math.min(s.desired || s.running, 12);
    return Array.from({ length: total }, (_, i) => i < s.running);
  }
  protected guestMemText(g: ProxmoxGuestInfo): string {
    return g.running ? fmtMemPair(g.mem, g.maxmem) : '—';
  }
  protected guestMemPct(g: ProxmoxGuestInfo): number {
    return g.maxmem ? Math.round((g.mem / g.maxmem) * 100) : 0;
  }

  // ---- actions -------------------------------------------------------------
  protected container(c: ContainerInfo, op: 'start' | 'stop' | 'restart' | 'logs'): void {
    void this.session.orchAction({ type: 'container', id: c.id, name: c.name, op });
  }
  protected service(s: SwarmServiceInfo, op: 'restart' | 'logs'): void {
    void this.session.orchAction({ type: 'service', name: s.name, op });
  }
  protected scale(s: SwarmServiceInfo, delta: number): void {
    void this.session.orchAction({
      type: 'service',
      name: s.name,
      op: 'scale',
      replicas: Math.max(0, s.desired + delta),
    });
  }
  protected guest(g: ProxmoxGuestInfo, op: 'start' | 'shutdown' | 'reboot' | 'console'): void {
    void this.session.orchAction({ type: 'guest', vmid: g.vmid, guestType: g.type, op });
  }

  protected readonly fmtPct = fmtPct;
  protected readonly fmtUptime = fmtUptime;
  protected readonly fmtMemPair = fmtMemPair;
}
