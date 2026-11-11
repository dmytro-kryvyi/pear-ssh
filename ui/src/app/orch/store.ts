import { Injectable, inject, signal } from '@angular/core';
import {
  FACET_KINDS,
  type ContainerInfo,
  type ContainerStatsMap,
  type DockerDiskRow,
  type OrchAction,
  type Orchestration,
  type SwarmFacet,
  type SwarmTaskInfo,
} from '@pear/core';
import { Pear } from '../pear';

export interface OrchState {
  status: 'detecting' | 'ready' | 'none' | 'error';
  data?: Orchestration;
  error?: string;
}

export interface DockerDfState {
  loading: boolean;
  rows?: DockerDiskRow[];
  error?: string;
  /** When the rows were fetched (ms epoch). */
  at?: number;
}

export interface TasksState {
  loading: boolean;
  tasks?: SwarmTaskInfo[];
  error?: string;
  /** When the tasks were fetched (ms epoch). */
  at?: number;
}

/** What the whole-app service tasks drawer is showing. */
export interface TasksDrawerCtx {
  hostId: string;
  serviceName: string;
  /** Preselect this task (e.g. the failure that opened the drawer). */
  initialTaskId?: string;
}

/**
 * Per-host orchestration state. Discovery runs in the background when a host
 * connects; the panel is only shown once the host is confirmed to actually
 * run Docker / Swarm / Proxmox ('none' keeps it hidden).
 */
@Injectable({ providedIn: 'root' })
export class OrchStore {
  private readonly pear = inject(Pear);

  readonly states = signal<Readonly<Record<string, OrchState>>>({});

  private set(hostId: string, state: OrchState): void {
    this.states.update((all) => ({ ...all, [hostId]: state }));
  }

  /** Kick off (or re-run) discovery for a freshly connected host. */
  async discover(hostId: string): Promise<void> {
    if (this.states()[hostId]?.status === 'detecting') return;
    this.set(hostId, { status: 'detecting' });
    await this.fetch(hostId);
  }

  /** Refetch state for a host whose discovery already completed. */
  async refresh(hostId: string): Promise<void> {
    const current = this.states()[hostId];
    if (!current || current.status === 'detecting') return;
    await this.fetch(hostId, current.data);
  }

  /**
   * Run an action. Streaming actions resolve with the command to type into
   * the terminal; state-changing ones refetch after letting the engine settle.
   */
  async action(hostId: string, action: OrchAction): Promise<string | undefined> {
    const result = await this.pear.api.orch.action(hostId, action);
    if (result.terminalCommand) return result.terminalCommand;
    await new Promise((resolve) => setTimeout(resolve, 700));
    await this.refresh(hostId);
    return undefined;
  }

  clear(hostId: string): void {
    this.fetchAgain.delete(hostId);
    this.states.update((all) => {
      const { [hostId]: _removed, ...rest } = all;
      return rest;
    });
    this.dockerDf.update((all) => {
      const { [hostId]: _removed, ...rest } = all;
      return rest;
    });
    this.tasks.update((all) =>
      Object.fromEntries(Object.entries(all).filter(([key]) => !key.startsWith(`${hostId}/`))),
    );
    if (this.drawer()?.hostId === hostId) this.drawer.set(null);
  }

  /** Live per-container stats from the monitor tick, patched in place. */
  applyStats(hostId: string, stats: ContainerStatsMap): void {
    this.states.update((all) => {
      const st = all[hostId];
      const docker = st?.data?.docker;
      if (!st || !docker) return all;
      const patch = (c: ContainerInfo): ContainerInfo => {
        const live = stats[c.id];
        // A running container missing from stats keeps its last values; a
        // stopped one clears them.
        if (!live) return c.running ? c : c.cpu == null ? c : { ...c, cpu: null, mem: null };
        return { ...c, cpu: live.cpu, mem: live.mem, maxmem: live.maxmem };
      };
      return {
        ...all,
        [hostId]: {
          ...st,
          data: {
            ...st.data,
            docker: {
              containers: docker.containers.map(patch),
              groups: docker.groups.map((g) => ({ ...g, containers: g.containers.map(patch) })),
            },
          },
        },
      };
    });
  }

  /** One best-effort `docker stats` pass after a snapshot; a failure just
   *  leaves the gauges empty, the way a missing stats row always has. */
  private readonly statsInflight = new Set<string>();
  private fillStats(hostId: string): void {
    if (this.statsInflight.has(hostId)) return;
    this.statsInflight.add(hostId);
    this.pear.api.monitor
      .stats(hostId)
      .then((stats) => this.applyStats(hostId, stats))
      .catch(() => {})
      .finally(() => this.statsInflight.delete(hostId));
  }

  // ---- docker system df (lazy: slow on busy hosts, never on the tick) ------

  readonly dockerDf = signal<Readonly<Record<string, DockerDfState>>>({});

  async fetchDockerDf(hostId: string): Promise<void> {
    if (this.dockerDf()[hostId]?.loading) return;
    this.dockerDf.update((all) => ({ ...all, [hostId]: { ...all[hostId], loading: true } }));
    try {
      const rows = await this.pear.api.monitor.dockerDf(hostId);
      this.dockerDf.update((all) => ({
        ...all,
        [hostId]: { loading: false, rows, at: Date.now() },
      }));
    } catch (err) {
      this.dockerDf.update((all) => ({
        ...all,
        [hostId]: { ...all[hostId], loading: false, error: cleanIpcError(err) },
      }));
    }
  }

  /**
   * One snapshot fetch per host at a time. Each fetch is an SSH session
   * channel for as long as `docker ps` runs, and sshd caps those per
   * connection — a slow daemon plus a few refresh clicks used to exhaust the
   * cap. A refresh asked for while one is running makes the next run once
   * the current one settles, so the state after an action still lands.
   */
  private readonly fetching = new Map<string, Promise<void>>();
  private readonly fetchAgain = new Set<string>();

  private fetch(hostId: string, previous?: Orchestration): Promise<void> {
    const running = this.fetching.get(hostId);
    if (running) {
      this.fetchAgain.add(hostId);
      return running;
    }
    const run = this.fetchOnce(hostId, previous).finally(() => {
      this.fetching.delete(hostId);
      if (this.fetchAgain.delete(hostId)) void this.fetch(hostId, this.states()[hostId]?.data);
    });
    this.fetching.set(hostId, run);
    return run;
  }

  private async fetchOnce(hostId: string, previous?: Orchestration): Promise<void> {
    try {
      const data = await this.pear.api.orch.get(hostId);
      const empty = FACET_KINDS.every((kind) => !data[kind]);
      this.set(hostId, empty ? { status: 'none' } : { status: 'ready', data });
      if (data.swarm) this.fillDegraded(hostId, data.swarm);
      // The snapshot deliberately skips `docker stats` (it samples for ~2s);
      // the container list is on screen already, the gauges fill in after.
      if (data.docker?.containers.some((c) => c.running)) this.fillStats(hostId);
    } catch (err) {
      // Keep the last good data visible next to the error, if there was any
      this.set(hostId, { status: 'error', error: cleanIpcError(err), data: previous });
    }
  }

  // ---- swarm service tasks (`docker service ps`) ---------------------------

  /** Open state of the whole-app tasks drawer (rendered from app.html). */
  readonly drawer = signal<TasksDrawerCtx | null>(null);

  /** Task lists keyed `${hostId}/${serviceName}`. */
  readonly tasks = signal<Readonly<Record<string, TasksState>>>({});

  openDrawer(ctx: TasksDrawerCtx): void {
    this.drawer.set(ctx);
    void this.fetchTasks(ctx.hostId, ctx.serviceName);
  }

  closeDrawer(): void {
    this.drawer.set(null);
  }

  async fetchTasks(hostId: string, service: string): Promise<void> {
    const key = `${hostId}/${service}`;
    if (this.tasks()[key]?.loading) return;
    this.tasks.update((all) => ({ ...all, [key]: { ...all[key], loading: true } }));
    try {
      const tasks = await this.pear.api.orch.serviceTasks(hostId, service);
      this.tasks.update((all) => ({ ...all, [key]: { loading: false, tasks, at: Date.now() } }));
    } catch (err) {
      this.tasks.update((all) => ({
        ...all,
        [key]: { ...all[key], loading: false, error: cleanIpcError(err) },
      }));
    }
  }

  /**
   * Lazily fill task lists for degraded services so the cluster view's failed
   * task callout can show the latest error. Sequential on purpose — one ssh
   * round-trip at a time, and degraded services are usually few.
   */
  private async fillDegraded(hostId: string, swarm: SwarmFacet): Promise<void> {
    for (const s of swarm.services) {
      if (s.running < s.desired) await this.fetchTasks(hostId, s.name);
    }
  }
}

function cleanIpcError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}
