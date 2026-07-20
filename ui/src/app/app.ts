import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { FacetKind, HostConfig } from '@pear/core';
import { Pear } from './pear';
import { Settings } from './settings';
import { HostCatalog } from './hosts';
import { TerminalPane } from './terminal/terminal';
import { TermTabs, type TermTab } from './terminal/tabs';
import { Workspace } from './workspace/workspace';
import { FsStore } from './workspace/fs-store';
import { PaneGrid } from './workspace/pane-grid';
import { FileOps } from './workspace/ops';
import { HostActions } from './host-actions';
import { OrchPanel } from './orch/orchpanel';
import { OrchStore } from './orch/store';
import { FACET_META } from './orch/facet-meta';
import { PearIcon } from './icons/icon';
import { ContextMenu } from './menu/context-menu';
import { TransferQueue } from './transfers/queue';
import { SettingsModal } from './settings/settings-modal';

const TARGET_RE = /^(?<user>[^@\s]+)@(?<host>[^:\s]+)(?::(?<port>\d+))?$/;

@Component({
  selector: 'app-root',
  imports: [
    FormsModule,
    TerminalPane,
    PaneGrid,
    OrchPanel,
    PearIcon,
    ContextMenu,
    TransferQueue,
    SettingsModal,
  ],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  private readonly pear = inject(Pear);
  private readonly orchStore = inject(OrchStore);
  readonly settings = inject(Settings);
  readonly tabs = inject(TermTabs);
  readonly catalog = inject(HostCatalog);
  readonly ws = inject(Workspace);
  readonly fsStore = inject(FsStore);
  readonly ops = inject(FileOps);
  readonly actions = inject(HostActions);

  readonly bridged = this.pear.available;
  readonly error = signal<string | null>(null);
  readonly settingsOpen = signal(false);

  readonly facetMeta = FACET_META;

  /** Hosts whose terminal channel answered this session. */
  private readonly termConnected = signal<ReadonlySet<string>>(new Set());
  readonly connectedIds = computed<ReadonlySet<string>>(() => {
    const union = new Set(this.termConnected());
    for (const id of this.fsStore.fsConnected()) union.add(id);
    return union;
  });

  /** The whole shell follows the focused pane's host. */
  readonly activeHostId = computed(() => this.ws.focusedLocation()?.hostId ?? null);
  readonly selected = computed(() => this.catalog.byId(this.activeHostId()));

  readonly allHosts = this.catalog.all;
  readonly rootHosts = this.catalog.roots;
  readonly hasLocalHost = computed(() => this.allHosts().some((h) => h.local));

  /** One view-tab per orchestration facet the focused host actually runs. */
  readonly availableFacets = computed<FacetKind[]>(() => {
    const data = this.orchState()?.data;
    if (!data) return [];
    const out: FacetKind[] = [];
    if (data.docker) out.push('docker');
    if (data.swarm) out.push('swarm');
    if (data.proxmox) out.push('proxmox');
    return out;
  });

  /** Facet shown by the focused tab, when it is an orch tab. */
  readonly activeFacet = computed<FacetKind | null>(() => {
    const tab = this.ws.focusedTab();
    return tab?.kind === 'orch' ? (tab.facet ?? null) : null;
  });

  readonly orchState = computed(() => {
    const id = this.activeHostId();
    const state = id ? this.orchStore.states()[id] : undefined;
    return state && state.status !== 'detecting' && state.status !== 'none' ? state : null;
  });

  readonly hostTabs = computed(() => {
    const id = this.activeHostId();
    return id ? this.tabs.tabs().filter((t) => t.hostId === id) : [];
  });
  readonly shellTabs = computed(() => this.hostTabs().filter((t) => t.row === 'shell'));
  readonly orchTabs = computed(() => this.hostTabs().filter((t) => t.row === 'orch'));
  readonly orchRowIcon = computed(() => {
    const kind = this.selected()?.kind;
    return kind === 'swarm' ? 'layers' : kind === 'proxmox' ? 'server' : 'docker';
  });

  // Quick-add form
  target = '';
  hostName = '';
  hostTag = '';

  private readonly discovered = new Set<string>();

  constructor() {
    if (!this.bridged) return;
    void this.catalog.refresh();

    this.pear.api.onHostDisconnected((hostId) => {
      this.termConnected.update((ids) => {
        const next = new Set(ids);
        next.delete(hostId);
        return next;
      });
      this.fsStore.dropHost(hostId);
      this.orchStore.clear(hostId);
      this.discovered.delete(hostId);
      this.tabs.closeHost(hostId);
      // Ephemeral sub-hosts don't outlive their connection (main sends a
      // per-child event too; dropping by parentId here is belt-and-braces).
      this.catalog.subHosts.update((list) =>
        list.filter((s) => s.id !== hostId && s.parentId !== hostId),
      );
      this.ws.closeHost(hostId);
    });

    // Facet discovery on first contact with a host, whichever channel it
    // came through (terminal or filesystem).
    effect(() => {
      for (const id of this.connectedIds()) {
        if (this.discovered.has(id)) continue;
        this.discovered.add(id);
        untracked(() => void this.orchStore.discover(id).then(() => this.catalog.refresh()));
      }
    });

    // The bottom terminal follows the focused pane: same host, same folder.
    effect(() => {
      const loc = this.ws.focusedLocation();
      if (!loc || !loc.path.startsWith('/')) return;
      if (!untracked(() => this.connectedIds().has(loc.hostId))) return;
      untracked(() => this.tabs.navigate(loc.hostId, loc.path));
    });
  }

  /** Sidebar click: focus this host's tab in the focused pane, or open one. */
  openHost(host: HostConfig): void {
    this.error.set(null);
    const pane = this.ws.focusedPane();
    const existing = pane?.tabs.find((t) => t.hostId === host.id && t.kind === 'dir');
    if (pane && existing) {
      this.ws.activateTab(pane.id, existing.id);
      return;
    }
    this.ws.newTab(pane?.id ?? null, host.id, this.fsStore.homes()[host.id] ?? '~');
  }

  async addHost(): Promise<void> {
    const match = TARGET_RE.exec(this.target.trim());
    if (!match?.groups) {
      this.error.set('Quick connect expects user@host or user@host:port');
      return;
    }
    const { user, host, port } = match.groups;
    const saved = await this.pear.api.hosts.upsert({
      name: this.hostName.trim() || host,
      host,
      user,
      port: port ? Number(port) : 22,
      tag: this.hostTag.trim() || undefined,
      kind: 'plain',
    });
    this.target = '';
    this.hostName = '';
    this.hostTag = '';
    this.error.set(null);
    await this.catalog.refresh();
    this.ws.newTab(null, saved.id, '~');
  }

  /** Register this machine as a host and open its files. */
  async addLocalHost(): Promise<void> {
    const saved = await this.pear.api.hosts.addLocal();
    await this.catalog.refresh();
    this.ws.newTab(null, saved.id, '~');
  }

  async removeHost(event: MouseEvent, host: HostConfig): Promise<void> {
    event.stopPropagation();
    await this.pear.api.hosts.remove(host.id);
    this.tabs.closeHost(host.id);
    this.ws.closeHost(host.id);
    this.fsStore.dropHost(host.id);
    await this.catalog.refresh();
  }

  isPinned(host: HostConfig): boolean {
    return this.catalog.hosts().some((h) => h.id === host.id);
  }

  async togglePin(event: MouseEvent, host: HostConfig): Promise<void> {
    event.stopPropagation();
    if (this.isPinned(host)) {
      await this.pear.api.subhosts.unpin(host.id);
    } else {
      await this.pear.api.subhosts.pin(host.id);
    }
    await this.catalog.refresh();
  }

  childrenOf(id: string): HostConfig[] {
    return this.allHosts().filter((h) => h.parentId === id);
  }

  /** Breadcrumb segments for a sub-host chain, root first: ['pve-01', 'ct:103']. */
  pathOf(host: HostConfig): string[] {
    const segments: string[] = [];
    const seen = new Set<string>();
    let current: HostConfig | null = host;
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      if (current.parentId && current.target) {
        const t = current.target;
        segments.unshift(`${t.type === 'lxc' ? 'ct' : 'ctr'}:${t.ref}`);
        const parentId: string = current.parentId;
        current = this.allHosts().find((h) => h.id === parentId) ?? null;
      } else {
        segments.unshift(current.name);
        current = null;
      }
    }
    return segments;
  }

  /** Live terminal count for the sidebar badge (signal read — reactive). */
  termCount(hostId: string): number {
    return this.tabs.tabs().filter((t) => t.hostId === hostId).length;
  }

  /** Jump host of a tunneled (via) host, if any. */
  viaOf(host: HostConfig): HostConfig | null {
    return host.via ? (this.allHosts().find((h) => h.id === host.via) ?? null) : null;
  }

  /** Unambiguous connection-path label — the answer to "where am I". */
  hostLabel(host: HostConfig): string {
    if (host.local) return 'this computer — no SSH';
    if (host.parentId) return this.pathOf(host).join(' › ');
    const base = `${host.user}@${host.host}${host.port !== 22 ? ':' + host.port : ''}`;
    const via = this.viaOf(host);
    return via ? `${base} via ${via.name}` : base;
  }

  onTabOpened(tab: TermTab, termId: string): void {
    this.tabs.attach(tab.id, termId);
    this.termConnected.update((ids) => new Set(ids).add(tab.hostId));
  }

  closeTab(tabId: string): void {
    this.tabs.close(tabId);
  }

  onTabExited(tabId: string): void {
    this.tabs.close(tabId);
  }

  onTermFailed(hostId: string, message: string): void {
    this.tabs.closeHost(hostId);
    this.error.set(message);
  }

  disconnectTerms(): void {
    const id = this.activeHostId();
    if (id) this.tabs.closeHost(id);
  }

  /** Top bar / sidebar expand: open the facet as a tab in the focused pane. */
  openFacet(facet: FacetKind): void {
    const id = this.activeHostId();
    if (id) this.ws.openOrch(this.ws.focusedPane()?.id ?? null, id, facet);
  }

  /** Top bar Files: back to the focused host's directory tab. */
  openFiles(): void {
    const host = this.selected();
    if (host) this.openHost(host);
  }

  readonly termHeight = signal(Math.round(window.innerHeight * 0.3));

  startResize(event: MouseEvent): void {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = this.termHeight();
    const move = (ev: MouseEvent) => {
      const next = startHeight + (startY - ev.clientY);
      this.termHeight.set(Math.max(120, Math.min(window.innerHeight - 220, next)));
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      document.body.style.cursor = '';
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    document.body.style.cursor = 'ns-resize';
  }
}
