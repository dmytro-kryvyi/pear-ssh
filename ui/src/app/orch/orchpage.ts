import { Component, computed, inject, input, output, signal } from '@angular/core';
import type { FacetKind, HostConfig, OrchAction, SubHostTarget } from '@pear/core';
import { Pear } from '../pear';
import { PearIcon } from '../icons/icon';
import { Gauge } from './gauge';
import { OrchStore, type OrchState } from './store';
import type { OrchTermCommand, PromotedVm } from './orchpanel';
import { FACET_META } from './facet-meta';
import { memPair, memPct, pctNum, pctText, tone, uptime } from './format';

@Component({
  selector: 'pear-orchpage',
  imports: [PearIcon, Gauge],
  templateUrl: './orchpage.html',
  styleUrl: './orchpage.scss',
})
export class OrchPage {
  readonly host = input.required<HostConfig>();
  readonly facet = input.required<FacetKind>();
  readonly state = input.required<OrchState>();
  readonly termCommand = output<OrchTermCommand>();
  /** An ephemeral sub-host was registered — the app should open it. */
  readonly jumpedIn = output<HostConfig>();
  readonly promoted = output<PromotedVm>();

  private readonly store = inject(OrchStore);
  private readonly pear = inject(Pear);

  readonly busy = signal<string | null>(null);
  readonly actionError = signal<string | null>(null);

  readonly data = computed(() => this.state().data ?? null);
  readonly loading = computed(() => this.state().status === 'detecting');
  readonly error = computed(() => this.state().error ?? this.actionError());
  readonly title = computed(() => FACET_META[this.facet()]);

  // ---- Docker derived --------------------------------------------------
  readonly docker = computed(() =>
    this.facet() === 'docker' ? (this.data()?.docker ?? null) : null,
  );
  readonly dockerKpis = computed(() => {
    const d = this.docker();
    if (!d) return null;
    const running = d.containers.filter((c) => c.running);
    const images = new Set(d.containers.map((c) => c.image.split(':')[0])).size;
    const ports = d.containers.reduce(
      (n, c) => n + (c.ports === '—' ? 0 : c.ports.split(',').length),
      0,
    );
    return {
      total: d.containers.length,
      running: running.length,
      stopped: d.containers.length - running.length,
      images,
      ports,
      projects: d.groups.filter((g) => g.project).length,
    };
  });

  // ---- Swarm derived ---------------------------------------------------
  readonly swarm = computed(() =>
    this.facet() === 'swarm' ? (this.data()?.swarm ?? null) : null,
  );
  readonly swarmKpis = computed(() => {
    const d = this.swarm();
    if (!d) return null;
    const managers = d.nodes.filter((n) => n.role === 'manager').length;
    const down = d.nodes.filter((n) => !n.ready).length;
    const tasksRunning = d.services.reduce((n, s) => n + s.running, 0);
    const tasksDesired = d.services.reduce((n, s) => n + s.desired, 0);
    const converged = d.services.filter((s) => s.running === s.desired).length;
    return {
      nodes: d.nodes.length,
      managers,
      workers: d.nodes.length - managers,
      down,
      services: d.services.length,
      converged,
      tasksRunning,
      tasksDesired,
      stacks: d.stacks.filter((s) => s.stack).length,
    };
  });

  // ---- Proxmox derived -------------------------------------------------
  readonly proxmox = computed(() =>
    this.facet() === 'proxmox' ? (this.data()?.proxmox ?? null) : null,
  );
  readonly proxmoxKpis = computed(() => {
    const d = this.proxmox();
    if (!d) return null;
    const running = d.guests.filter((g) => g.running).length;
    const vms = d.guests.filter((g) => g.type === 'vm').length;
    return { running, total: d.guests.length, vms, cts: d.guests.length - vms };
  });

  refresh(): void {
    this.actionError.set(null);
    void this.store.refresh(this.host().id);
  }

  async act(busyKey: string, action: OrchAction, title = 'stream'): Promise<void> {
    await this.guarded(busyKey, async () => {
      const cmd = await this.store.action(this.host().id, action);
      if (cmd) this.termCommand.emit({ command: cmd, title });
    });
  }

  /** Enter a container/CT as a sub-host (probes it through the parent). */
  async jumpInto(busyKey: string, target: SubHostTarget, name: string): Promise<void> {
    await this.guarded(busyKey, async () => {
      this.jumpedIn.emit(await this.pear.api.subhosts.jumpIn(this.host().id, target, name));
    });
  }

  /** Detect a VM's IP via the guest agent so it can become a real host. */
  async promoteVm(busyKey: string, vmid: number, name: string): Promise<void> {
    await this.guarded(busyKey, async () => {
      const ip = await this.pear.api.subhosts.vmIp(this.host().id, vmid);
      this.promoted.emit({ ip, name, viaId: this.host().id });
    });
  }

  private async guarded(busyKey: string, fn: () => Promise<void>): Promise<void> {
    if (this.busy()) return;
    this.busy.set(busyKey);
    this.actionError.set(null);
    try {
      await fn();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.actionError.set(msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
    } finally {
      this.busy.set(null);
    }
  }

  // Cell array for swarm replica grid
  cells(running: number, desired: number): boolean[] {
    const total = Math.min(desired || running, 12);
    return Array.from({ length: total }, (_, i) => i < running);
  }

  serviceState(running: number, desired: number): 'ok' | 'warn' | 'off' {
    return running === 0 ? 'off' : running === desired ? 'ok' : 'warn';
  }

  convergedOf(services: { running: number; desired: number }[]): number {
    return services.filter((s) => s.running === s.desired).length;
  }
  runningOf(items: { running: boolean }[]): number {
    return items.filter((c) => c.running).length;
  }

  /** Collapse state for subgroups (Compose project / stack / guest type),
   *  namespaced by facet so keys can't collide. Open by default. */
  readonly openGroups = signal<Record<string, boolean>>({});
  private groupKey(facet: FacetKind, key: string | null): string {
    return `${facet}:${key ?? ' '}`;
  }
  isGroupOpen(facet: FacetKind, key: string | null): boolean {
    return this.openGroups()[this.groupKey(facet, key)] !== false;
  }
  toggleGroup(facet: FacetKind, key: string | null): void {
    const k = this.groupKey(facet, key);
    this.openGroups.update((o) => ({ ...o, [k]: o[k] === false }));
  }

  // Formatting passthroughs for the template
  readonly pctText = pctText;
  readonly pctNum = pctNum;
  readonly memPair = memPair;
  readonly memPct = memPct;
  readonly tone = tone;
  readonly uptime = uptime;
}
