import { Injectable, computed, inject, signal } from '@angular/core';
import { autoShort, type HostColor, type HostConfig } from '@pear/core';
import { Pear } from './pear';
import { Settings } from './settings';
import { HostGroups } from './hosts/groups';

/** Deterministic per-host accent for tab dots — stable across sessions. */
const HOST_HUES = [190, 240, 295, 75, 25, 150, 330, 50];

/** Named palette for explicit host/workspace colors (design's WS_COLORS). */
export const HOST_COLORS: Record<HostColor, string> = {
  red: 'oklch(0.68 0.16 25)',
  amber: 'oklch(0.78 0.14 75)',
  green: 'oklch(0.74 0.14 150)',
  teal: 'oklch(0.72 0.09 190)',
  blue: 'oklch(0.70 0.12 245)',
  violet: 'oklch(0.68 0.14 300)',
};

/**
 * The host inventory as a root service: persisted hosts plus session-scoped
 * sub-hosts, addressable from any component (panes, transfers, menus) rather
 * than only through the app shell.
 */
@Injectable({ providedIn: 'root' })
export class HostCatalog {
  private readonly pear = inject(Pear);
  private readonly settings = inject(Settings);
  private readonly groups = inject(HostGroups);

  readonly hosts = signal<HostConfig[]>([]);
  /** Session-scoped sub-hosts (jump-in targets, not yet pinned). */
  readonly subHosts = signal<HostConfig[]>([]);

  /** Sidebar search: matches names, addresses, aliases, tags and users. */
  readonly query = signal('');
  /** False until the first inventory load answered — the sidebar shows
   *  placeholder rows rather than "no hosts" while the bridge is still
   *  connecting (the PWA queues calls until its WebSocket is up). */
  readonly loaded = signal(false);

  readonly all = computed(() => [...this.hosts(), ...this.subHosts()]);
  /** id → host; every byId() in a template row goes through this instead of
   *  a linear scan per row per change-detection pass. */
  private readonly index = computed(() => new Map(this.all().map((h) => [h.id, h])));
  /** Persisted (pinned) host ids — sub-hosts not in here are session-only. */
  readonly pinnedIds = computed<ReadonlySet<string>>(() => new Set(this.hosts().map((h) => h.id)));
  /**
   * Children per parent (exec sub-hosts and tunneled via-hosts alike),
   * transitively flattened under each root in parent-first order — one pass
   * over the inventory, shared by every sidebar row.
   */
  readonly descendants = computed<ReadonlyMap<string, HostConfig[]>>(() => {
    const direct = new Map<string, HostConfig[]>();
    for (const h of this.all()) {
      for (const link of [h.parentId, h.via]) {
        if (!link) continue;
        const list = direct.get(link);
        if (list) list.push(h);
        else direct.set(link, [h]);
      }
    }
    const out = new Map<string, HostConfig[]>();
    for (const root of this.all()) {
      const flat: HostConfig[] = [];
      const seen = new Set([root.id]);
      const queue = [root.id];
      while (queue.length) {
        for (const h of direct.get(queue.shift()!) ?? []) {
          if (seen.has(h.id)) continue;
          seen.add(h.id);
          flat.push(h);
          queue.push(h.id);
        }
      }
      out.set(root.id, flat);
    }
    return out;
  });
  /**
   * Top-level sidebar rows. A tunneled (via) host nests under its jump host
   * like an exec sub-host does — unless the jump host is gone (orphan), in
   * which case it surfaces as a root so it stays reachable.
   */
  readonly roots = computed(() =>
    this.all().filter(
      (h) => !h.parentId && !(h.via && this.all().some((j) => j.id === h.via)),
    ),
  );

  /**
   * Roots after search and workspace scoping. Searching looks across ALL
   * hosts (ignoring the active workspace); otherwise the active group scopes
   * the list. A root stays visible when any of its descendants match.
   */
  readonly visibleRoots = computed(() => {
    const q = this.query().trim().toLowerCase();
    if (q) {
      return this.roots().filter(
        (h) => this.matches(h, q) || this.descendantsOf(h.id).some((c) => this.matches(c, q)),
      );
    }
    const group = this.groups.byId(this.settings.activeGroup());
    if (!group) return this.roots();
    return this.roots().filter((h) => group.hostIds.includes(h.id));
  });

  byId(id: string | null): HostConfig | null {
    return id ? (this.index().get(id) ?? null) : null;
  }

  /** Transitive sub-hosts of a root, parent-first (see `descendants`). */
  childrenOf(id: string): HostConfig[] {
    return this.descendants().get(id) ?? [];
  }

  nameOf(id: string | null): string {
    if (id === null) return 'my machine';
    return this.byId(id)?.name ?? 'unknown host';
  }

  color(id: string): string {
    const named = this.byId(id)?.color;
    if (named && HOST_COLORS[named]) return HOST_COLORS[named];
    let hash = 0;
    for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
    const hue = HOST_HUES[Math.abs(hash) % HOST_HUES.length];
    return `oklch(0.72 0.11 ${hue})`;
  }

  /** Badge label for tight rows: explicit `short` or derived initials. */
  shortOf(host: HostConfig): string {
    return host.short || autoShort(host.name);
  }

  matches(h: HostConfig, q: string): boolean {
    const hay = [
      h.name,
      h.short ?? '',
      h.host,
      h.user,
      ...(h.aliases ?? []),
      ...(h.tags ?? []),
      ...(h.endpoints ?? []).map((e) => e.addr),
    ];
    return hay.some((s) => s.toLowerCase().includes(q));
  }

  private descendantsOf(id: string): HostConfig[] {
    return this.childrenOf(id);
  }

  /** Reload the inventory. The three calls are independent, so they go out
   *  together — one round-trip, not three, which matters over a WebSocket. */
  async refresh(): Promise<void> {
    try {
      const [hosts, subHosts] = await Promise.all([
        this.pear.api.hosts.list(),
        this.pear.api.subhosts.list(),
        this.groups.refresh(),
      ]);
      this.hosts.set(hosts);
      this.subHosts.set(subHosts);
    } finally {
      this.loaded.set(true);
    }
  }
}
