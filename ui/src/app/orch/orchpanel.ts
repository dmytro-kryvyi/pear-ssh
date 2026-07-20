import { Component, computed, inject, input, output, signal } from '@angular/core';
import type { FacetKind, HostConfig, OrchAction, SubHostTarget } from '@pear/core';
import { Pear } from '../pear';
import { PearIcon } from '../icons/icon';
import { OrchStore, type OrchState } from './store';
import { FACET_META } from './facet-meta';
import { pctText, memPair, uptime } from './format';

export interface OrchTermCommand {
  command: string;
  title: string;
}

/** A VM promoted to a real SSH host: detected address + suggested name. */
export interface PromotedVm {
  ip: string;
  name: string;
  /** The PVE host it was discovered on — becomes the new host's jump (via). */
  viaId: string;
}

/** One collapsible section in the sidebar per orchestration facet present. */
interface FacetSummary {
  kind: FacetKind;
  icon: string;
  label: string;
  count: string;
}

@Component({
  selector: 'pear-orchpanel',
  imports: [PearIcon],
  templateUrl: './orchpanel.html',
  styleUrl: './orchpanel.scss',
})
export class OrchPanel {
  readonly host = input.required<HostConfig>();
  readonly state = input.required<OrchState>();
  readonly termCommand = output<OrchTermCommand>();
  readonly expand = output<FacetKind>();
  /** An ephemeral sub-host was registered — the app should open it. */
  readonly jumpedIn = output<HostConfig>();
  readonly promoted = output<PromotedVm>();

  private readonly store = inject(OrchStore);
  private readonly pear = inject(Pear);

  /** Which facet sections are expanded (all open by default). */
  readonly openFacets = signal<Record<string, boolean>>({ docker: true, swarm: true, proxmox: true });
  readonly busy = signal<string | null>(null);
  readonly actionError = signal<string | null>(null);

  readonly data = computed(() => this.state().data ?? null);
  readonly loading = computed(() => this.state().status === 'detecting');
  readonly error = computed(() => this.state().error ?? this.actionError());

  readonly docker = computed(() => this.data()?.docker ?? null);
  readonly swarm = computed(() => this.data()?.swarm ?? null);
  readonly proxmox = computed(() => this.data()?.proxmox ?? null);

  /** Header summaries, in a stable order, for each present facet. */
  readonly summaries = computed<FacetSummary[]>(() => {
    const data = this.data();
    if (!data) return [];
    const out: FacetSummary[] = [];
    if (data.docker) {
      const running = data.docker.containers.filter((c) => c.running).length;
      out.push({ kind: 'docker', icon: FACET_META.docker.icon, label: FACET_META.docker.tab, count: `${running}/${data.docker.containers.length}` });
    }
    if (data.swarm) {
      const converged = data.swarm.services.filter((s) => s.running > 0 && s.running === s.desired).length;
      out.push({ kind: 'swarm', icon: FACET_META.swarm.icon, label: FACET_META.swarm.tab, count: `${converged}/${data.swarm.services.length}` });
    }
    if (data.proxmox) {
      const running = data.proxmox.guests.filter((g) => g.running).length;
      out.push({ kind: 'proxmox', icon: FACET_META.proxmox.icon, label: FACET_META.proxmox.tab, count: `${running}/${data.proxmox.guests.length}` });
    }
    return out;
  });

  readonly swarmRoster = computed(() => {
    const s = this.swarm();
    if (!s) return null;
    return {
      managers: s.nodes.filter((n) => n.role === 'manager').length,
      workers: s.nodes.filter((n) => n.role === 'worker').length,
      down: s.nodes.filter((n) => !n.ready).length,
    };
  });

  isOpen(kind: FacetKind): boolean {
    return this.openFacets()[kind] !== false;
  }
  toggle(kind: FacetKind): void {
    this.openFacets.update((o) => ({ ...o, [kind]: o[kind] === false }));
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
  runningOf(items: { running: boolean }[]): number {
    return items.filter((c) => c.running).length;
  }
  convergedOf(services: { running: number; desired: number }[]): number {
    return services.filter((s) => s.running > 0 && s.running === s.desired).length;
  }

  refresh(): void {
    this.actionError.set(null);
    void this.store.refresh(this.host().id);
  }

  async act(busyKey: string, action: OrchAction, title = 'stream'): Promise<void> {
    await this.guarded(busyKey, async () => {
      const terminalCommand = await this.store.action(this.host().id, action);
      if (terminalCommand) this.termCommand.emit({ command: terminalCommand, title });
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

  readonly pctText = pctText;
  readonly memPair = memPair;
  readonly uptime = uptime;
}
