import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { FacetKind, HostConfig, HostGroup, HostKind } from '@pear/core';
import { Pear } from './pear';
import { Settings } from './settings';
import { HostCatalog } from './hosts';
import { HostGroups } from './hosts/groups';
import { HostEditor } from './hosts/host-editor';
import { WorkspaceEditor } from './hosts/workspace-editor';
import { SshImport } from './hosts/ssh-import';
import { SshConfigImporter } from './hosts/ssh-config-importer';
import { WorkspaceSwitcher, HOST_DRAG_TYPE } from './hosts/workspace-switcher';
import { TerminalPane } from './terminal/terminal';
import { TermTabs, type TermTab } from './terminal/tabs';
import { Workspace } from './workspace/workspace';
import { FsStore } from './workspace/fs-store';
import { PropertiesModal } from './workspace/properties';
import { CompressDialog } from './workspace/compress-dialog';
import { PaneGrid } from './workspace/pane-grid';
import { FileOps } from './workspace/ops';
import { HostActions } from './host-actions';
import { Notices } from './notices';
import { Clipboard } from './clipboard';
import { ContextMenuService } from './menu/context-menu';
import { copyItem, editMenuFor, editableFieldOf } from './menu/menu-items';
import { TermRouter } from './terminal/router';
import { sshCommand } from '@pear/core';
import type { MenuItem } from './menu/context-menu';
import { OrchPanel } from './orch/orchpanel';
import { OrchStore } from './orch/store';
import { TasksDrawer } from './orch/tasks-drawer';
import { FACET_KINDS, FACET_META } from './orch/facet-meta';
import { PearIcon } from './icons/icon';
import { ContextMenu } from './menu/context-menu';
import { TransferQueue } from './transfers/queue';
import { TransfersStore } from './transfers/store';
import { SettingsModal } from './settings/settings-modal';
import { MonitorStore } from './monitor/store';
import { HostMeter } from './monitor/host-meter';
import { ClaudeDock } from './claude/dock';
import { ClaudeUiBridge } from './claude/ui-bridge';
import { RemoteLink } from './remote/link';

/** `user@host[:port]`, or a bare token resolved as an ~/.ssh/config alias. */
const TARGET_RE = /^(?:(?<user>[^@\s]+)@)?(?<host>[^@:\s]+)(?::(?<port>\d+))?$/;

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
    PropertiesModal,
    CompressDialog,
    SettingsModal,
    HostMeter,
    ClaudeDock,
    TasksDrawer,
    HostEditor,
    WorkspaceEditor,
    WorkspaceSwitcher,
    SshImport,
  ],
  templateUrl: './app.html',
  styleUrl: './app.scss',
  // Every piece of state this template reads is a signal, so OnPush is free —
  // and it is what keeps a monitor tick or a Claude token from re-checking
  // the whole shell (sidebar rows, file lists, panes) on every change.
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class App {
  private readonly pear = inject(Pear);
  private readonly importer = inject(SshConfigImporter);
  readonly orchStore = inject(OrchStore);
  private readonly monitor = inject(MonitorStore);
  readonly settings = inject(Settings);
  readonly tabs = inject(TermTabs);
  readonly catalog = inject(HostCatalog);
  readonly ws = inject(Workspace);
  readonly fsStore = inject(FsStore);
  readonly ops = inject(FileOps);
  readonly actions = inject(HostActions);
  readonly hostGroups = inject(HostGroups);
  readonly link = inject(RemoteLink);
  readonly transfers = inject(TransfersStore);

  readonly bridged = this.pear.available;
  readonly error = signal<string | null>(null);
  readonly settingsOpen = signal(false);
  readonly sshImportOpen = signal(false);

  /** Host being edited in the modal ('new' = blank draft). */
  readonly editHost = signal<HostConfig | 'new' | null>(null);
  /** Workspace (host group) being edited ('new' = blank draft). */
  readonly editGroup = signal<HostGroup | 'new' | null>(null);
  /** Host id being dragged from the sidebar (shows the workspace drop list). */
  readonly dragHostId = signal<string | null>(null);
  readonly dragOverGroup = signal<string | null>(null);

  readonly notices = inject(Notices);
  private readonly clipboard = inject(Clipboard);
  private readonly menu = inject(ContextMenuService);
  private readonly expectedDisconnects = new Set<string>();

  readonly facetMeta = FACET_META;

  /** A host is terminal-connected once one of its tabs has an open channel
   *  (termId set on attach) — true for both the dock and in-pane terminals. */
  readonly connectedIds = computed<ReadonlySet<string>>(() => {
    const union = new Set<string>();
    for (const t of this.tabs.tabs()) if (t.termId) union.add(t.hostId);
    for (const id of this.fsStore.fsConnected()) union.add(id);
    return union;
  });

  /** The whole shell follows the focused pane's host. */
  readonly activeHostId = computed(() => this.ws.focusedLocation()?.hostId ?? null);
  readonly selected = computed(() => this.catalog.byId(this.activeHostId()));

  readonly allHosts = this.catalog.all;
  readonly rootHosts = this.catalog.visibleRoots;
  readonly hasLocalHost = computed(() => this.allHosts().some((h) => h.local));

  /** One view-tab per orchestration facet the focused host actually runs. */
  readonly availableFacets = computed<FacetKind[]>(() => {
    const data = this.orchState()?.data;
    return data ? FACET_KINDS.filter((kind) => !!data[kind]) : [];
  });

  /** Facet shown by the focused tab, when it is an orch tab. */
  readonly activeFacet = computed<FacetKind | null>(() => {
    const tab = this.ws.focusedTab();
    return tab?.kind === 'orch' ? (tab.facet ?? null) : null;
  });
  readonly transfersActive = computed(() => this.ws.focusedTab()?.kind === 'transfers');

  openTransfers(): void {
    this.ws.openTransfers();
  }

  readonly orchState = computed(() => {
    const id = this.activeHostId();
    const state = id ? this.orchStore.states()[id] : undefined;
    return state && state.status !== 'detecting' && state.status !== 'none' ? state : null;
  });
  /** Facet discovery still running for the focused host (sidebar hint). */
  readonly orchDetecting = computed(() => {
    const id = this.activeHostId();
    return !!id && this.orchStore.states()[id]?.status === 'detecting';
  });

  /** Hosts whose first SSH connection is still being made. */
  readonly connectingIds = this.fsStore.connecting;

  /** Live terminals per host, for the sidebar badge — counted once per
   *  tabs change, not once per row per change-detection pass. */
  readonly termCounts = computed<ReadonlyMap<string, number>>(() => {
    const counts = new Map<string, number>();
    for (const t of this.tabs.tabs()) counts.set(t.hostId, (counts.get(t.hostId) ?? 0) + 1);
    return counts;
  });
  readonly pinnedIds = this.catalog.pinnedIds;

  /** Bottom dock shows every host's shells at once, decoupled from the focused
   *  pane, when the user picks the per-host terminal placement. */
  readonly perHostTerms = computed(() => this.settings.termPlacement() === 'per-host');

  /** The host the dock's chrome (+ new, label, close) acts on: the active
   *  tab's host in per-host mode, otherwise the focused pane's host. */
  readonly dockHost = computed(() => {
    if (this.perHostTerms()) {
      const active = this.tabs.tabs().find((t) => t.id === this.tabs.activeId());
      return this.catalog.byId(active?.hostId ?? null) ?? this.selected();
    }
    return this.selected();
  });

  /** TermTab ids that live inside a workspace pane (in-pane placement) — the
   *  bottom dock must never also show them. */
  private readonly paneTermIds = computed<ReadonlySet<string>>(
    () => new Set(this.ws.paneTermRefs().map((r) => r.termTabId)),
  );

  readonly hostTabs = computed(() => {
    const owned = this.paneTermIds();
    const dockTabs = this.tabs.tabs().filter((t) => !owned.has(t.id));
    if (this.perHostTerms()) return dockTabs;
    const id = this.activeHostId();
    return id ? dockTabs.filter((t) => t.hostId === id) : [];
  });
  readonly shellTabs = computed(() => this.hostTabs().filter((t) => t.row === 'shell'));
  readonly orchTabs = computed(() => this.hostTabs().filter((t) => t.row === 'orch'));

  /** All dock-eligible tabs (every host, both rows) — the body renders these
   *  and toggles visibility, so switching a tab never rebuilds its terminal. */
  readonly dockTabs = computed(() => {
    const owned = this.paneTermIds();
    return this.tabs.tabs().filter((t) => !owned.has(t.id));
  });

  /** The bottom dock is shown unless terminals live in panes (in-pane mode). */
  readonly showDock = computed(
    () => this.settings.termPlacement() !== 'in-pane' && this.dockTabs().length > 0,
  );
  readonly orchRowIcon = computed(() => this.kindIcon(this.dockHost()?.kind ?? 'plain'));

  /** Sidebar/dock glyph for a host's dominant facet ('plain' shows the default). */
  kindIcon(kind: HostKind): string {
    return kind === 'plain' ? FACET_META.docker.icon : FACET_META[kind].icon;
  }

  /** In per-host mode a tab is active purely by id; in shared mode it must
   *  also belong to the focused pane's host (the only host the dock shows). */
  isTabActive(t: TermTab): boolean {
    if (t.id !== this.tabs.activeId()) return false;
    return this.perHostTerms() || t.hostId === this.activeHostId();
  }

  /** Tab caption: host-prefixed in per-host mode so shells stay distinguishable. */
  tabCaption(t: TermTab): string {
    if (!this.perHostTerms()) return t.title;
    const host = this.catalog.byId(t.hostId);
    return host ? `${host.name} · ${t.title}` : t.title;
  }

  // Quick-add form
  target = '';
  hostName = '';
  hostTag = '';

  private readonly discovered = new Set<string>();

  constructor() {
    if (!this.bridged) return;
    void this.catalog.refresh();
    // Electron gives text fields no native menu. Any component that owns its
    // right-click has already called preventDefault by the time this bubble
    // listener runs; everything else that is a plain text field gets the
    // standard Cut / Copy / Paste / Select all. xterm and Monaco keep their
    // own handling (their hidden textareas must not get this menu). In a
    // browser (Pear server) the native input menu is better — it can paste
    // on plain http, which the async clipboard API cannot — so skip this.
    if (!this.link.remote) document.addEventListener('contextmenu', (e) => {
      if (e.defaultPrevented) return;
      const field = editableFieldOf(e.target);
      if (!field || field.closest('.xterm, .monaco-editor')) return;
      e.preventDefault();
      this.menu.open(e.clientX, e.clientY, editMenuFor(field, this.clipboard));
    });
    // Serve read_terminal / reveal_in_app round-trips from the main process.
    inject(ClaudeUiBridge).start();

    this.pear.api.onHostDisconnected((hostId) => {
      if (this.expectedDisconnects.has(hostId)) {
        this.expectedDisconnects.delete(hostId);
      } else if (this.connectedIds().has(hostId)) {
        const host = this.catalog.byId(hostId);
        // A dying parent takes its sub-hosts with it — one notice is enough.
        for (const child of this.childrenOf(hostId)) this.expectedDisconnects.add(child.id);
        this.showNotice(`Lost connection to ${host?.name ?? hostId}`);
      }
      this.fsStore.dropHost(hostId);
      this.orchStore.clear(hostId);
      this.monitor.drop(hostId);
      this.discovered.delete(hostId);
      this.tabs.closeHost(hostId);
      // Ephemeral sub-hosts don't outlive their connection (main sends a
      // per-child event too; dropping by parent link here is belt-and-braces).
      this.catalog.subHosts.update((list) =>
        list.filter((s) => s.id !== hostId && s.parentId !== hostId && s.via !== hostId),
      );
      this.ws.closeHost(hostId);
    });

    // Mirror the focused workspace location to the Claude integration so
    // its list_hosts can mark which host/dir the user is looking at.
    effect(() => {
      const loc = this.ws.focusedLocation();
      this.pear.api.claude.setFocus(
        loc ? { hostId: loc.hostId, ...(loc.path.startsWith('/') ? { path: loc.path } : {}) } : null,
      );
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

    // Bottom-dock placement reacts to the focused pane:
    //  - shared: the terminal follows it (same host, cd to same folder);
    //  - per-host: the host just gets one shell the first time it's visited,
    //    with no cd and no stealing of the user's chosen active tab;
    //  - in-pane: no bottom dock at all, so nothing here.
    effect(() => {
      const placement = this.settings.termPlacement();
      if (placement === 'in-pane') return;
      const loc = this.ws.focusedLocation();
      if (!loc || !loc.path.startsWith('/')) return;
      if (!untracked(() => this.connectedIds().has(loc.hostId))) return;
      untracked(() => {
        if (placement === 'per-host') {
          const hasShell = this.tabs
            .tabs()
            .some((t) => t.hostId === loc.hostId && t.row === 'shell');
          if (!hasShell) this.tabs.newShell(loc.hostId);
        } else {
          this.tabs.navigate(loc.hostId, loc.path);
        }
      });
    });

    // Resource monitor targets: every connected host when the sidebar shows
    // micro-meters, otherwise just the hosts with open workspace tabs. Only
    // connected hosts — sampling rides the existing SSH connection.
    effect(() => {
      const connected = this.connectedIds();
      const targets = this.settings.sidebarVitals()
        ? connected
        : new Set(this.ws.openHostIds().filter((id) => connected.has(id)));
      untracked(() => this.monitor.setTargets(targets));
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
    this.ws.newTab(pane?.id ?? null, host.id, host.cwd || (this.fsStore.homes()[host.id] ?? '~'));
  }

  async addHost(): Promise<void> {
    const match = TARGET_RE.exec(this.target.trim());
    if (!match?.groups) {
      this.error.set('Quick connect expects user@host[:port] or an ~/.ssh/config alias');
      return;
    }
    const { user, host, port } = match.groups;
    const entries = await this.pear.api.hosts.sshConfigEntries();
    const entry = entries.find((e) => e.alias === host);
    if (!entry && !user) {
      this.error.set(`'${host}' is not an ~/.ssh/config alias — use user@host[:port]`);
      return;
    }
    const tag = this.hostTag.trim();
    const tags = tag ? [tag] : undefined;
    let saved: HostConfig;
    try {
      saved = entry
        ? // Typed user/port override the config's values; a ProxyJump chain
          // is materialised as jump hosts (reused when already in the catalog).
          await this.importer.importEntry(entry, entries, {
            name: this.hostName.trim() || undefined,
            user: user ?? undefined,
            port: port ? Number(port) : undefined,
            tags,
          })
        : await this.pear.api.hosts.upsert({
            name: this.hostName.trim() || host,
            host,
            user: user!,
            port: port ? Number(port) : 22,
            tags,
            kind: 'plain',
          });
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
      return;
    }
    this.target = '';
    this.hostName = '';
    this.hostTag = '';
    this.error.set(null);
    await this.catalog.refresh();
    this.ws.newTab(null, saved.id, '~');
  }

  // ---- host / workspace editors --------------------------------------------

  openHostEditor(event: MouseEvent | null, host: HostConfig): void {
    event?.stopPropagation();
    this.editHost.set(host);
  }

  editorHost(): HostConfig | null {
    const value = this.editHost();
    return value === 'new' ? null : value;
  }

  editorGroup(): HostGroup | null {
    const value = this.editGroup();
    return value === 'new' ? null : value;
  }

  async onEditorRemoved(id: string): Promise<void> {
    const host = this.catalog.byId(id);
    this.editHost.set(null);
    if (host) await this.removeHostById(host);
  }

  onEditorConnect(id: string): void {
    this.editHost.set(null);
    const host = this.catalog.byId(id);
    if (host) this.openHost(host);
  }

  /** Workspace editor asked to edit one of its member hosts — switch modals. */
  onGroupEditHost(id: string): void {
    this.editGroup.set(null);
    const host = this.catalog.byId(id);
    if (host) this.editHost.set(host);
  }

  // ---- drag host onto a workspace ------------------------------------------

  onHostDragStart(event: DragEvent, host: HostConfig): void {
    event.dataTransfer?.setData(HOST_DRAG_TYPE, host.id);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copy';
    this.dragHostId.set(host.id);
  }

  onHostDragEnd(): void {
    this.dragHostId.set(null);
    this.dragOverGroup.set(null);
  }

  onGroupDragOver(event: DragEvent, groupId: string): void {
    event.preventDefault();
    this.dragOverGroup.set(groupId);
  }

  async onGroupDrop(event: DragEvent, group: HostGroup): Promise<void> {
    event.preventDefault();
    const hostId = event.dataTransfer?.getData(HOST_DRAG_TYPE) || this.dragHostId();
    this.dragHostId.set(null);
    this.dragOverGroup.set(null);
    if (hostId) await this.hostGroups.setMembership(hostId, group.id, true);
  }

  inGroup(hostId: string | null, group: HostGroup): boolean {
    return hostId ? group.hostIds.includes(hostId) : false;
  }

  /** Tooltip for the short-label badge: full identity at a glance. */
  shortTitle(host: HostConfig): string {
    const parts = [host.name];
    if (host.tags?.length) parts.push(host.tags.join(', '));
    const groups = this.hostGroups.groupsOf(host.id).map((g) => g.name);
    if (groups.length) parts.push(groups.join(', '));
    return parts.join(' · ');
  }

  /** Register this machine as a host and open its files. */
  async addLocalHost(): Promise<void> {
    const saved = await this.pear.api.hosts.addLocal();
    await this.catalog.refresh();
    this.ws.newTab(null, saved.id, '~');
  }

  /** Deliberate removals stay silent; this is for surprises. */
  private showNotice(text: string): void {
    this.notices.show(text, 'error');
  }

  async removeHost(event: MouseEvent, host: HostConfig): Promise<void> {
    event.stopPropagation();
    await this.removeHostById(host);
  }

  private async removeHostById(host: HostConfig): Promise<void> {
    this.expectedDisconnects.add(host.id);
    for (const child of this.childrenOf(host.id)) this.expectedDisconnects.add(child.id);
    await this.pear.api.hosts.remove(host.id);
    this.tabs.closeHost(host.id);
    this.ws.closeHost(host.id);
    this.fsStore.dropHost(host.id);
    await this.catalog.refresh();
  }

  isPinned(host: HostConfig): boolean {
    return this.pinnedIds().has(host.id);
  }

  async togglePin(event: MouseEvent, host: HostConfig): Promise<void> {
    event.stopPropagation();
    await this.setPinned(host, !this.isPinned(host));
  }

  private async setPinned(host: HostConfig, pinned: boolean): Promise<void> {
    if (pinned) await this.pear.api.subhosts.pin(host.id);
    else await this.pear.api.subhosts.unpin(host.id);
    await this.catalog.refresh();
  }

  /**
   * Transitive descendants for the sidebar, parent-first: exec sub-hosts
   * (parentId) and tunneled via-hosts alike. Flat — nesting depth is not
   * rendered, only membership under the root.
   */
  childrenOf(id: string): HostConfig[] {
    return this.catalog.childrenOf(id);
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
        current = this.catalog.byId(current.parentId);
      } else {
        segments.unshift(current.name);
        current = null;
      }
    }
    return segments;
  }

  /** Live terminal count for the sidebar badge (signal read — reactive). */
  termCount(hostId: string): number {
    return this.termCounts().get(hostId) ?? 0;
  }

  /** Jump host of a tunneled (via) host, if any. */
  viaOf(host: HostConfig): HostConfig | null {
    return host.via ? this.catalog.byId(host.via) : null;
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

  private readonly termRouter = inject(TermRouter);

  /** Right-click on a root host row. */
  onHostMenu(event: MouseEvent, h: HostConfig): void {
    event.preventDefault();
    const addr = h.local ? '' : `${h.user}@${h.host}${h.port !== 22 ? ':' + h.port : ''}`;
    const ssh = sshCommand(h, (id) => this.allHosts().find((x) => x.id === id));
    this.menu.open(event.clientX, event.clientY, [
      { label: 'Open files', icon: 'folderOpen', onClick: () => this.openHost(h) },
      { label: 'New shell', icon: 'terminal', onClick: () => this.termRouter.newShell(h.id, h.cwd ?? null) },
      { divider: true },
      { label: 'Edit host…', icon: 'pencil', onClick: () => this.editHost.set(h) },
      copyItem('Copy address', h.local ? '' : h.host, this.clipboard),
      copyItem('Copy user@host', addr, this.clipboard, 'address'),
      copyItem('Copy ssh command', ssh, this.clipboard, 'command'),
      { divider: true },
      {
        label: 'Close shells',
        disabled: this.termCount(h.id) === 0,
        onClick: () => this.tabs.closeHost(h.id),
      },
      { label: 'Remove host', icon: 'trash', danger: true, onClick: () => void this.removeHostById(h) },
    ]);
  }

  /** Right-click on a sub-host (container / CT / via) row. */
  onSubHostMenu(event: MouseEvent, c: HostConfig): void {
    event.preventDefault();
    const pinned = this.isPinned(c);
    const ref = c.target ? c.target.ref : `${c.user}@${c.host}`;
    const items: MenuItem[] = [
      { label: 'Open files', icon: 'folderOpen', onClick: () => this.openHost(c) },
      { label: 'New shell', icon: 'terminal', onClick: () => this.termRouter.newShell(c.id) },
      { divider: true },
      copyItem('Copy name', c.name, this.clipboard),
      copyItem(c.target ? (c.target.type === 'lxc' ? 'Copy CT id' : 'Copy container ref') : 'Copy user@host', ref, this.clipboard, 'ref'),
      { divider: true },
      {
        label: pinned ? 'Unpin (forget after restart)' : 'Pin (keep after restart)',
        icon: pinned ? 'pinFilled' : 'pin',
        onClick: () => void this.setPinned(c, !pinned),
      },
    ];
    if (pinned) items.push({ label: 'Edit host…', icon: 'pencil', onClick: () => this.editHost.set(c) });
    items.push({ label: 'Remove', icon: 'trash', danger: true, onClick: () => void this.removeHostById(c) });
    this.menu.open(event.clientX, event.clientY, items);
  }

  /** Right-click on a bottom-dock terminal tab. */
  onDockTabMenu(event: MouseEvent, t: TermTab): void {
    event.preventDefault();
    const siblings = this.tabs.tabs().filter((x) => x.hostId === t.hostId && x.row === t.row);
    this.menu.open(event.clientX, event.clientY, [
      { label: 'Close', icon: 'close', onClick: () => this.tabs.close(t.id) },
      {
        label: 'Close others',
        disabled: siblings.length < 2,
        onClick: () => siblings.filter((x) => x.id !== t.id).forEach((x) => this.tabs.close(x.id)),
      },
      { label: 'Close all for host', onClick: () => this.tabs.closeHost(t.hostId) },
      { divider: true },
      { label: 'New shell here', icon: 'terminal', onClick: () => this.tabs.newShell(t.hostId, t.cwd) },
      copyItem('Copy working directory', t.cwd, this.clipboard, 'path'),
      ...(t.row === 'orch' ? [copyItem('Copy command', t.initialCommand, this.clipboard)] : []),
    ]);
  }

  /** Right-click on the dock's host label. */
  onDockLabelMenu(event: MouseEvent, host: HostConfig): void {
    event.preventDefault();
    this.menu.open(event.clientX, event.clientY, [
      { label: 'New shell', icon: 'terminal', onClick: () => this.tabs.newShell(host.id) },
      { label: 'Close shells', onClick: () => this.tabs.closeHost(host.id) },
      { divider: true },
      copyItem('Copy connection label', this.hostLabel(host), this.clipboard, 'label'),
    ]);
  }

  onToastMenu(event: MouseEvent, text: string): void {
    event.preventDefault();
    this.menu.open(event.clientX, event.clientY, [copyItem('Copy message', text, this.clipboard)]);
  }

  disconnectTerms(): void {
    const id = this.perHostTerms() ? (this.dockHost()?.id ?? null) : this.activeHostId();
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
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      document.body.style.cursor = '';
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    document.body.style.cursor = 'ns-resize';
  }

  startClaudeResize(event: MouseEvent): void {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = this.settings.claudeWidth();
    const move = (ev: MouseEvent) => {
      const next = startWidth + (startX - ev.clientX);
      this.settings.claudeWidth.set(Math.max(320, Math.min(620, next)));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      document.body.style.cursor = '';
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    document.body.style.cursor = 'ew-resize';
  }
}
