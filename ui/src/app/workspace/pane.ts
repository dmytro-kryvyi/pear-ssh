import { Component, computed, inject, input, signal } from '@angular/core';
import { PearIcon } from '../icons/icon';
import { Editor } from '../editor/editor';
import { HostCatalog } from '../hosts';
import { HostActions } from '../host-actions';
import { OrchPage } from '../orch/orchpage';
import { OrchStore } from '../orch/store';
import { FACET_META } from '../orch/facet-meta';
import { FileList } from './filelist';
import { Workspace, type WsPane, type WsTab } from './workspace';

const TAB_MIME = 'application/x-pear-tab';

interface TabDragPayload {
  tabId: string;
}

/** One workspace pane: a VS Code-style tab strip over a dir list, an editor,
 *  or an orchestration view. */
@Component({
  selector: 'pear-pane',
  imports: [PearIcon, FileList, Editor, OrchPage],
  templateUrl: './pane.html',
  styleUrl: './pane.scss',
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
  private readonly orchStore = inject(OrchStore);

  /** Tab index the dragged tab would land at, for the insertion marker. */
  readonly dragOverIndex = signal<number | null>(null);
  readonly splitHover = signal(false);

  readonly activeTab = computed<WsTab | null>(() => {
    const p = this.pane();
    return p.tabs.find((t) => t.id === p.activeTabId) ?? p.tabs[0] ?? null;
  });

  tabLabel(tab: WsTab): string {
    if (tab.kind === 'orch') return tab.facet ? FACET_META[tab.facet].tab : 'Orchestration';
    if (tab.path === '~' || tab.path === '/') return tab.path;
    return tab.path.split('/').filter(Boolean).pop() ?? tab.path;
  }

  tabIcon(tab: WsTab): string {
    if (tab.kind === 'orch') return tab.facet ? FACET_META[tab.facet].icon : 'cube';
    return tab.kind === 'file' ? 'fileCode' : 'folder';
  }

  tabTitle(tab: WsTab): string {
    const what = tab.kind === 'orch' ? (tab.facet ?? 'orchestration') : tab.path;
    return `${this.catalog.nameOf(tab.hostId)} : ${what}`;
  }

  /** Orchestration state for the active orch tab's host, once discovered. */
  readonly orchState = computed(() => {
    const tab = this.activeTab();
    if (!tab || tab.kind !== 'orch') return null;
    const state = this.orchStore.states()[tab.hostId];
    return state && state.status !== 'detecting' && state.status !== 'none' ? state : null;
  });

  newTab(): void {
    const host = this.activeTab()?.hostId ?? this.ws.focusedTab()?.hostId;
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
