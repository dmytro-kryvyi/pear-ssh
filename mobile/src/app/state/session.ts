import { Injectable, computed, inject, signal } from '@angular/core';
import type {
  ContainerInfo,
  ContainerStatsMap,
  HostConfig,
  HostGroup,
  HostStatus,
  OrchAction,
  Orchestration,
} from '@pear/core';
import { PEAR_BACKEND } from '../backend';
import { HOST_META, RECENT_IDS } from '../mock/seed';
import { TermStore } from '../terminal/term-store';

/** Session state shared by the phone and tablet shells (design state.jsx). */
@Injectable({ providedIn: 'root' })
export class PearSession {
  private readonly backend = inject(PEAR_BACKEND);
  private readonly terms = inject(TermStore);

  readonly hosts = signal<HostConfig[]>([]);
  readonly groups = signal<HostGroup[]>([]);
  /** False until the first inventory load answered (screens show
   *  placeholders rather than "no hosts" while the backend is coming up). */
  readonly loaded = signal(false);
  private readonly meta = signal<Record<string, { status: HostStatus; lastSeen: string }>>({ ...HOST_META });

  readonly activeWsId = signal<string | null>('w1');
  readonly activeHostId = signal<string | null>('h1');
  readonly path = signal('/etc/nginx');
  readonly openFile = signal<string | null>(null);
  readonly editHost = signal<HostConfig | null>(null);
  readonly editWs = signal<HostGroup | null>(null);

  readonly orch = signal<Orchestration | null>(null);
  readonly orchLoading = signal(false);
  /** Bumped when an action lands in the terminal (logs, console) — the
   *  shells react by revealing the terminal so the output is visible. */
  readonly shellPing = signal(0);

  readonly host = computed(() => this.hosts().find((h) => h.id === this.activeHostId()) ?? null);
  readonly activeWs = computed(() => this.groups().find((w) => w.id === this.activeWsId()) ?? null);
  readonly wsHosts = computed(() => {
    const ws = this.activeWs();
    return ws ? this.hosts().filter((h) => ws.hostIds.includes(h.id)) : this.hosts();
  });
  readonly recents = computed(() =>
    RECENT_IDS.map((id) => this.hosts().find((h) => h.id === id)).filter((h): h is HostConfig => !!h),
  );

  statusOf(id: string): HostStatus {
    return this.meta()[id]?.status ?? 'unknown';
  }
  lastSeenOf(id: string): string {
    return this.meta()[id]?.lastSeen ?? 'never';
  }
  groupsOf(hostId: string): HostGroup[] {
    return this.groups().filter((w) => w.hostIds.includes(hostId));
  }

  constructor() {
    void this.init();
  }

  private async init(): Promise<void> {
    await this.reload();
    // Dev/screenshot deep-link (like #tab=/#view=): #file=/path opens the editor.
    const file = /file=([^&]+)/.exec(location.hash)?.[1];
    if (file) {
      const decoded = decodeURIComponent(file);
      this.path.set(decoded.split('/').slice(0, -1).join('/') || '/');
      this.openFile.set(decoded);
    }
    void this.refreshOrch();
  }

  async reload(): Promise<void> {
    let hosts: HostConfig[];
    let groups: HostGroup[];
    try {
      [hosts, groups] = await Promise.all([this.backend.hosts.list(), this.backend.hostGroups.list()]);
    } finally {
      this.loaded.set(true);
    }
    this.hosts.set(hosts);
    this.groups.set(groups);
    // The active host/workspace default to mock seed ids ('h1'/'w1'); on the
    // native backend real hosts have generated ids, so reconcile the
    // selection against what actually loaded — otherwise every hostId-keyed
    // call (orch, fs, term) targets a phantom host.
    if (!hosts.some((h) => h.id === this.activeHostId())) {
      this.activeHostId.set(hosts[0]?.id ?? null);
      // …and the same goes for the path: the default is the mock's demo
      // directory, which a real host answers with ENOENT.
      this.path.set(hosts[0]?.cwd || '/');
    }
    if (this.activeWsId() !== null && !groups.some((g) => g.id === this.activeWsId())) {
      this.activeWsId.set(null);
    }
  }

  // ---- connection ----------------------------------------------------------

  connect(h: HostConfig): void {
    if (h.id === this.activeHostId()) return;
    this.activeHostId.set(h.id);
    this.path.set(h.cwd || '/');
    this.openFile.set(null);
    this.meta.update((m) => ({ ...m, [h.id]: { status: 'online', lastSeen: 'active now' } }));
    this.orch.set(null);
    void this.refreshOrch();
  }

  navigate(p: string): void {
    this.path.set(p);
    this.openFile.set(null);
  }

  // ---- orchestration -------------------------------------------------------

  /** Monotonic token so an older overlapping refresh can't apply stale
   *  results or turn the spinner off under a newer one. */
  private orchSeq = 0;

  async refreshOrch(): Promise<void> {
    const id = this.activeHostId();
    if (!id || !this.hosts().some((h) => h.id === id)) return;
    const seq = ++this.orchSeq;
    this.orchLoading.set(true);
    try {
      const o = await this.backend.orch.get(id);
      if (seq === this.orchSeq && this.activeHostId() === id) {
        this.orch.set(o);
        // The snapshot skips `docker stats` (~2s of sampling) so the cards
        // show up at once; the gauges fill in from a second call.
        if (o.docker?.containers.some((c) => c.running)) void this.fillStats(id, seq);
      }
    } catch {
      // Host offline or not yet reachable — leave the orch view empty rather
      // than surfacing a boot-time console error.
      if (seq === this.orchSeq && this.activeHostId() === id) this.orch.set(null);
    } finally {
      if (seq === this.orchSeq) this.orchLoading.set(false);
    }
  }

  private async fillStats(id: string, seq: number): Promise<void> {
    let stats: ContainerStatsMap;
    try {
      stats = await this.backend.monitor.stats(id);
    } catch {
      return; // best effort: the gauges just stay empty
    }
    if (seq !== this.orchSeq || this.activeHostId() !== id) return;
    const patch = (c: ContainerInfo): ContainerInfo => {
      const live = stats[c.id];
      return live ? { ...c, cpu: live.cpu, mem: live.mem, maxmem: live.maxmem } : c;
    };
    this.orch.update((o) =>
      o?.docker
        ? {
            ...o,
            docker: {
              containers: o.docker.containers.map(patch),
              groups: o.docker.groups.map((g) => ({ ...g, containers: g.containers.map(patch) })),
            },
          }
        : o,
    );
  }

  async orchAction(action: OrchAction): Promise<void> {
    const id = this.activeHostId();
    if (!id) return;
    const result = await this.backend.orch.action(id, action);
    // Streaming actions (logs, console) run in the host's terminal — and the
    // shell must actually show it, or the tap looks like a no-op.
    if (result.terminalCommand) {
      void this.terms.run(id, result.terminalCommand);
      this.shellPing.update((n) => n + 1);
    }
    await this.refreshOrch();
  }

  // ---- host / workspace editing --------------------------------------------

  async saveHost(next: Omit<HostConfig, 'id'> & { id?: string }, memberIds: string[]): Promise<void> {
    const saved = await this.backend.hosts.upsert(next);
    await Promise.all(
      this.groups().map((g) =>
        this.backend.hostGroups.setMembership(saved.id, g.id, memberIds.includes(g.id)),
      ),
    );
    if (!this.meta()[saved.id]) {
      this.meta.update((m) => ({ ...m, [saved.id]: { status: 'idle', lastSeen: 'never' } }));
    }
    await this.reload();
    this.editHost.set(null);
  }

  async deleteHost(id: string): Promise<void> {
    await this.backend.hosts.remove(id);
    await this.reload();
    if (this.activeHostId() === id) {
      const first = this.hosts()[0];
      if (first) this.connect(first);
      else this.activeHostId.set(null);
    }
    this.editHost.set(null);
  }

  async saveWs(next: Omit<HostGroup, 'id'> & { id?: string }): Promise<void> {
    const saved = await this.backend.hostGroups.upsert(next);
    await this.reload();
    this.activeWsId.set(saved.id);
    this.editWs.set(null);
  }

  async deleteWs(id: string): Promise<void> {
    await this.backend.hostGroups.remove(id);
    await this.reload();
    if (this.activeWsId() === id) this.activeWsId.set(null);
    this.editWs.set(null);
  }

  /** Drag-to-workspace on the tablet rail: add only, never remove. */
  async addToWorkspace(hostId: string, groupId: string): Promise<void> {
    const g = this.groups().find((x) => x.id === groupId);
    if (!g || g.hostIds.includes(hostId)) return;
    await this.backend.hostGroups.setMembership(hostId, groupId, true);
    await this.reload();
  }

  async toggleMembership(hostId: string, groupId: string): Promise<void> {
    const g = this.groups().find((x) => x.id === groupId);
    if (!g) return;
    await this.backend.hostGroups.setMembership(hostId, groupId, !g.hostIds.includes(hostId));
    await this.reload();
  }

  // ---- blanks --------------------------------------------------------------

  blankHost(): HostConfig {
    return {
      id: '',
      name: '',
      host: '',
      port: 22,
      user: 'root',
      kind: 'docker',
      color: 'teal',
      aliases: [],
      tags: [],
      cwd: '/',
      auth: { method: 'key' },
      endpoints: [{ id: `e${Math.random().toString(36).slice(2, 8)}`, label: '', addr: '', port: 22 }],
      env: [],
      startup: [],
      notes: '',
    };
  }

  blankWs(): HostGroup {
    return { id: '', name: '', color: 'teal', icon: 'layers', desc: '', hostIds: [] };
  }
}
