import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { PearIcon } from '../icons/icon';
import { Editor } from '../editor/editor';
import { HostCatalog } from '../hosts';
import { HostActions } from '../host-actions';
import { OrchPage } from '../orch/orchpage';
import { OrchStore } from '../orch/store';
import { FACET_META } from '../orch/facet-meta';
import { FileList } from './filelist';
import { Settings } from '../settings';
import { TerminalPane } from '../terminal/terminal';
import { TermTabs, type TermTab } from '../terminal/tabs';
import { TransfersPage } from '../transfers/page';
import { Workspace, isHostTab, type HostTab, type WsPane, type WsTab } from './workspace';

const TAB_MIME = 'application/x-pear-tab';

interface TabDragPayload {
  tabId: string;
}

/** One workspace pane: a VS Code-style tab strip over a dir list, an editor,
 *  or an orchestration view. */
@Component({
  selector: 'pear-pane',
  imports: [PearIcon, FileList, Editor, OrchPage, TerminalPane, TransfersPage],
  templateUrl: './pane.html',
  styleUrl: './pane.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '[style.flex]': 'pane().flex',
    '[class.focused]': 'focused()',
    '(mousedown)': 'ws.focusPane(pane().id)',
  },
})
export class Pane {
  readonly pane = input.required<WsPane>();
  readonly focused = input.required<boolean>();

  readonly ws = inject(Workspace);
  readonly catalog = inject(HostCatalog);
  readonly actions = inject(HostActions);
  readonly tabs = inject(TermTabs);
  readonly settings = inject(Settings);
  private readonly orchStore = inject(OrchStore);

  /** Tab index the dragged tab would land at, for the insertion marker. */
  readonly dragOverIndex = signal<number | null>(null);
  readonly splitHover = signal(false);

  readonly activeTab = computed<WsTab | null>(() => {
    const p = this.pane();
    return p.tabs.find((t) => t.id === p.activeTabId) ?? p.tabs[0] ?? null;
  });

  /** The host a new tab or shell in this pane should target: the active
   *  host tab's, else any host tab here, else the first host open anywhere. */
  readonly hostFor = computed<string | null>(() => {
    const active = this.activeTab();
    if (active && isHostTab(active)) return active.hostId;
    return this.pane().tabs.find(isHostTab)?.hostId ?? this.ws.openHostIds()[0] ?? null;
  });

  tabLabel(tab: WsTab): string {
    if (tab.kind === 'transfers') return 'Transfers';
    if (tab.kind === 'orch') return tab.facet ? FACET_META[tab.facet].tab : 'Orchestration';
    if (tab.kind === 'term') return this.termTabFor(tab)?.title ?? 'terminal';
    if (tab.path === '~' || tab.path === '/') return tab.path;
    return tab.path.split('/').filter(Boolean).pop() ?? tab.path;
  }

  tabIcon(tab: WsTab): string {
    if (tab.kind === 'transfers') return 'swap';
    if (tab.kind === 'orch') return tab.facet ? FACET_META[tab.facet].icon : 'cube';
    if (tab.kind === 'term') return this.termTabFor(tab)?.row === 'orch' ? 'logs' : 'terminal';
    return tab.kind === 'file' ? 'fileCode' : 'folder';
  }

  tabTitle(tab: WsTab): string {
    if (tab.kind === 'transfers') return 'Transfers';
    const what =
      tab.kind === 'orch'
        ? (tab.facet ?? 'orchestration')
        : tab.kind === 'term'
          ? (this.termTabFor(tab)?.title ?? 'terminal')
          : tab.path;
    return `${this.catalog.nameOf(tab.hostId)} : ${what}`;
  }

  // ---- in-pane terminals ---------------------------------------------------

  /** Term tabs in this pane; rendered persistently so switching tabs never
   *  tears the shell down (that would close the backend PTY). */
  readonly termTabs = computed<HostTab[]>(() =>
    this.pane().tabs.filter((t): t is HostTab => t.kind === 'term'),
  );

  /** The backing shell for a term tab, looked up in TermTabs. */
  termTabFor(tab: WsTab): TermTab | null {
    if (!isHostTab(tab) || !tab.termTabId) return null;
    return this.tabs.byId().get(tab.termTabId) ?? null;
  }

  /** Open a shell inside this pane (in-pane placement). */
  openTerminal(): void {
    const host = this.hostFor();
    if (!host) return;
    const termTabId = this.tabs.createShell(host);
    this.ws.openTermTab(this.pane().id, host, termTabId);
  }

  onTermOpened(tab: TermTab, termId: string): void {
    this.tabs.attach(tab.id, termId);
  }

  /** Close a tab from the strip; term tabs also dispose their backing shell. */
  closeTab(tab: WsTab): void {
    if (tab.kind === 'term' && tab.termTabId) this.tabs.close(tab.termTabId);
    this.ws.closeTab(tab.id);
  }

  /** Close this pane, disposing any shells it holds first. */
  closePane(): void {
    for (const t of this.termTabs()) if (t.termTabId) this.tabs.close(t.termTabId);
    this.ws.closePane(this.pane().id);
  }

  /** Orchestration state for the active orch tab's host, once discovered. */
  readonly orchState = computed(() => {
    const tab = this.activeTab();
    if (!tab || tab.kind !== 'orch') return null;
    const state = this.orchStore.states()[tab.hostId];
    return state && state.status !== 'detecting' && state.status !== 'none' ? state : null;
  });

  newTab(): void {
    const host = this.hostFor();
    if (host) this.ws.newTab(this.pane().id, host);
  }

  // ---- tab drag ------------------------------------------------------------

  onTabDragStart(event: DragEvent, tab: WsTab): void {
    const payload: TabDragPayload = { tabId: tab.id };
    event.dataTransfer?.setData(TAB_MIME, JSON.stringify(payload));
    event.dataTransfer!.effectAllowed = 'move';
    this.ws.dragging.set('tab');
  }

  onTabDragEnd(): void {
    this.ws.dragging.set(null);
    this.dragOverIndex.set(null);
    this.splitHover.set(false);
  }

  private acceptsTab(event: DragEvent): boolean {
    return !!event.dataTransfer && Array.from(event.dataTransfer.types).includes(TAB_MIME);
  }

  onTabDragOver(event: DragEvent, index: number): void {
    if (!this.acceptsTab(event)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer!.dropEffect = 'move';
    this.dragOverIndex.set(index);
  }

  onStripDragOver(event: DragEvent): void {
    if (!this.acceptsTab(event)) return;
    event.preventDefault();
    this.dragOverIndex.set(this.pane().tabs.length);
  }

  onTabDrop(event: DragEvent, index: number | null): void {
    if (!this.acceptsTab(event)) return;
    event.preventDefault();
    event.stopPropagation();
    this.dragOverIndex.set(null);
    this.ws.dragging.set(null);
    const raw = event.dataTransfer?.getData(TAB_MIME);
    if (!raw) return;
    const { tabId } = JSON.parse(raw) as TabDragPayload;
    this.ws.moveTab(tabId, this.pane().id, index);
  }

  // ---- split-by-drop zone --------------------------------------------------

  onSplitDragOver(event: DragEvent): void {
    if (!this.acceptsTab(event)) return;
    event.preventDefault();
    this.splitHover.set(true);
  }

  onSplitDrop(event: DragEvent): void {
    if (!this.acceptsTab(event)) return;
    event.preventDefault();
    this.splitHover.set(false);
    this.ws.dragging.set(null);
    const raw = event.dataTransfer?.getData(TAB_MIME);
    if (!raw) return;
    const { tabId } = JSON.parse(raw) as TabDragPayload;
    this.ws.splitWithTab(tabId, this.pane().id);
  }
}
