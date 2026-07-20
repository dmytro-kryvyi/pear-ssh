import { Injectable, computed, signal } from '@angular/core';
import type { FacetKind } from '@pear/core';

export type TabKind = 'dir' | 'file' | 'orch';

export interface WsTab {
  id: string;
  kind: TabKind;
  hostId: string;
  /** Directory for dir tabs ('~' until resolved), file path for file tabs,
   *  '' for orch tabs (their target is the facet, not a path). */
  path: string;
  /** Which orchestration view an orch tab shows. */
  facet?: FacetKind;
}

export interface WsPane {
  id: string;
  /** Relative width across the pane row. */
  flex: number;
  activeTabId: string | null;
  tabs: WsTab[];
}

export interface Clipboard {
  op: 'copy' | 'cut';
  hostId: string;
  dir: string;
  names: string[];
}

export interface FocusedLocation {
  hostId: string;
  /** Directory context: the dir itself, or the containing dir of a file. */
  path: string;
  paneId: string;
  tabId: string;
  kind: TabKind;
}

let nextId = 0;
const paneId = () => `pane-${++nextId}`;
const tabId = () => `wtab-${++nextId}`;

export function dirnameOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i <= 0 ? '/' : path.slice(0, i);
}

const MIN_FLEX = 0.2;

/**
 * The files workspace: a horizontal row of panes, each a strip of tabs, each
 * tab bound to a host + path. The focused pane's location drives the rest of
 * the app (sidebar highlight, orchestration view, bottom terminal).
 */
@Injectable({ providedIn: 'root' })
export class Workspace {
  readonly panes = signal<WsPane[]>([]);
  readonly focusedPaneId = signal<string | null>(null);
  readonly clipboard = signal<Clipboard | null>(null);
  /** Set while a tab or file drag is in flight — drop zones key off it. */
  readonly dragging = signal<'tab' | 'files' | null>(null);

  readonly focusedPane = computed<WsPane | null>(() => {
    const panes = this.panes();
    return panes.find((p) => p.id === this.focusedPaneId()) ?? panes[0] ?? null;
  });

  readonly focusedTab = computed<WsTab | null>(() => {
    const pane = this.focusedPane();
    if (!pane) return null;
    return pane.tabs.find((t) => t.id === pane.activeTabId) ?? pane.tabs[0] ?? null;
  });

  readonly focusedLocation = computed<FocusedLocation | null>(() => {
    const pane = this.focusedPane();
    const tab = this.focusedTab();
    if (!pane || !tab) return null;
    return {
      hostId: tab.hostId,
      path: tab.kind === 'file' ? dirnameOf(tab.path) : tab.path,
      paneId: pane.id,
      tabId: tab.id,
      kind: tab.kind,
    };
  });

  /** Hosts with at least one open tab, in first-seen order. */
  readonly openHostIds = computed<string[]>(() => {
    const seen: string[] = [];
    for (const pane of this.panes()) {
      for (const tab of pane.tabs) {
        if (!seen.includes(tab.hostId)) seen.push(tab.hostId);
      }
    }
    return seen;
  });

  focusPane(id: string): void {
    if (this.panes().some((p) => p.id === id)) this.focusedPaneId.set(id);
  }

  activateTab(paneIdArg: string, tabIdArg: string): void {
    this.updatePane(paneIdArg, (p) => ({ ...p, activeTabId: tabIdArg }));
    this.focusedPaneId.set(paneIdArg);
  }

  /** Point a dir tab at a new directory (also how '~' resolves). */
  navigate(tabIdArg: string, path: string): void {
    this.updateTab(tabIdArg, (t) => ({ ...t, kind: 'dir', path }));
  }

  setTabHost(tabIdArg: string, hostId: string): void {
    this.updateTab(tabIdArg, (t) => ({ ...t, kind: 'dir', hostId, path: '~' }));
  }

  /** Open a new dir tab; creates the first pane when the workspace is empty. */
  newTab(paneIdArg: string | null, hostId: string, path = '~'): string {
    const tab: WsTab = { id: tabId(), kind: 'dir', hostId, path };
    this.insertTab(paneIdArg, tab);
    return tab.id;
  }

  /** Open a file tab next to the active one; refocus an existing match. */
  openFile(paneIdArg: string, hostId: string, path: string): void {
    const pane = this.panes().find((p) => p.id === paneIdArg);
    const existing = pane?.tabs.find(
      (t) => t.kind === 'file' && t.hostId === hostId && t.path === path,
    );
    if (pane && existing) {
      this.activateTab(pane.id, existing.id);
      return;
    }
    this.insertTab(paneIdArg, { id: tabId(), kind: 'file', hostId, path });
  }

  /**
   * Open a path in a pane other than `fromPaneId` — the one to its right when
   * present, otherwise a fresh split. Dir tabs dedupe against an existing tab
   * for the same host+path; files reuse openFile's dedupe.
   */
  openToSide(fromPaneId: string, hostId: string, path: string, kind: 'dir' | 'file'): void {
    const panes = this.panes();
    const at = panes.findIndex((p) => p.id === fromPaneId);
    const other = panes[at + 1] ?? panes.find((p) => p.id !== fromPaneId);
    if (other) {
      if (kind === 'file') {
        this.openFile(other.id, hostId, path);
        return;
      }
      const existing = other.tabs.find(
        (t) => t.kind === 'dir' && t.hostId === hostId && t.path === path,
      );
      if (existing) this.activateTab(other.id, existing.id);
      else this.newTab(other.id, hostId, path);
      return;
    }
    const tab: WsTab = { id: tabId(), kind, hostId, path };
    const np: WsPane = { id: paneId(), flex: 1, activeTabId: tab.id, tabs: [tab] };
    this.panes.update((ps) => {
      const out: WsPane[] = [];
      for (const p of ps) {
        out.push(p);
        if (p.id === fromPaneId) out.push(np);
      }
      return out;
    });
    this.focusedPaneId.set(np.id);
  }

  /** Open an orchestration tab in a pane; refocus an existing match. */
  openOrch(paneIdArg: string | null, hostId: string, facet: FacetKind): void {
    const pane =
      this.panes().find((p) => p.id === paneIdArg) ?? this.focusedPane() ?? undefined;
    const existing = pane?.tabs.find(
      (t) => t.kind === 'orch' && t.hostId === hostId && t.facet === facet,
    );
    if (pane && existing) {
      this.activateTab(pane.id, existing.id);
      return;
    }
    this.insertTab(pane?.id ?? null, { id: tabId(), kind: 'orch', hostId, path: '', facet });
  }

  private insertTab(paneIdArg: string | null, tab: WsTab): void {
    const panes = this.panes();
    const target = panes.find((p) => p.id === paneIdArg) ?? this.focusedPane();
    if (!target) {
      const pane: WsPane = { id: paneId(), flex: 1, activeTabId: tab.id, tabs: [tab] };
      this.panes.set([pane]);
      this.focusedPaneId.set(pane.id);
      return;
    }
    this.updatePane(target.id, (p) => {
      const at = p.tabs.findIndex((t) => t.id === p.activeTabId);
      const tabs = [...p.tabs];
      tabs.splice(at < 0 ? tabs.length : at + 1, 0, tab);
      return { ...p, tabs, activeTabId: tab.id };
    });
    this.focusedPaneId.set(target.id);
  }

  closeTab(tabIdArg: string): void {
    this.panes.update((panes) =>
      this.normalize(
        panes.map((p) => {
          const at = p.tabs.findIndex((t) => t.id === tabIdArg);
          if (at < 0) return p;
          const tabs = p.tabs.filter((t) => t.id !== tabIdArg);
          let active = p.activeTabId;
          if (active === tabIdArg) active = (tabs[at] ?? tabs[at - 1] ?? tabs[0])?.id ?? null;
          return { ...p, tabs, activeTabId: active };
        }),
      ),
    );
  }

  /** Drag a tab onto a strip: reorder within a pane or move across panes. */
  moveTab(tabIdArg: string, destPaneId: string, index: number | null): void {
    this.panes.update((panes) => {
      const src = panes.find((p) => p.tabs.some((t) => t.id === tabIdArg));
      const tab = src?.tabs.find((t) => t.id === tabIdArg);
      if (!src || !tab) return panes;
      if (src.id === destPaneId) {
        return panes.map((p) => {
          if (p.id !== destPaneId) return p;
          const without = p.tabs.filter((t) => t.id !== tabIdArg);
          const at = index === null ? without.length : Math.max(0, Math.min(index, without.length));
          without.splice(at, 0, tab);
          return { ...p, tabs: without, activeTabId: tab.id };
        });
      }
      const moved = panes.map((p) => {
        if (p.id === src.id) {
          const tabs = p.tabs.filter((t) => t.id !== tabIdArg);
          const active = p.activeTabId === tabIdArg ? (tabs[0]?.id ?? null) : p.activeTabId;
          return { ...p, tabs, activeTabId: active };
        }
        if (p.id === destPaneId) {
          const tabs = [...p.tabs];
          const at = index === null ? tabs.length : Math.max(0, Math.min(index, tabs.length));
          tabs.splice(at, 0, tab);
          return { ...p, tabs, activeTabId: tab.id };
        }
        return p;
      });
      return this.normalize(moved);
    });
    this.focusPane(destPaneId);
  }

  /** Drop a tab on a pane's split zone: new pane right of it with that tab. */
  splitWithTab(tabIdArg: string, afterPaneId: string): void {
    const np: WsPane = { id: paneId(), flex: 1, activeTabId: tabIdArg, tabs: [] };
    this.panes.update((panes) => {
      const src = panes.find((p) => p.tabs.some((t) => t.id === tabIdArg));
      const tab = src?.tabs.find((t) => t.id === tabIdArg);
      if (!src || !tab) return panes;
      if (src.id === afterPaneId && src.tabs.length === 1) return panes; // nothing to split
      np.tabs = [tab];
      const out: WsPane[] = [];
      for (const p of panes) {
        if (p.id === src.id) {
          const tabs = p.tabs.filter((t) => t.id !== tabIdArg);
          const active = p.activeTabId === tabIdArg ? (tabs[0]?.id ?? null) : p.activeTabId;
          out.push({ ...p, tabs, activeTabId: active });
        } else {
          out.push(p);
        }
        if (p.id === afterPaneId) out.push(np);
      }
      return this.normalize(out);
    });
    this.focusPane(np.id);
  }

  /** Duplicate the active tab into a fresh pane on the right. */
  splitPane(paneIdArg: string): void {
    const npId = paneId();
    this.panes.update((panes) => {
      const src = panes.find((p) => p.id === paneIdArg);
      const at = src?.tabs.find((t) => t.id === src.activeTabId) ?? src?.tabs[0];
      if (!src || !at) return panes;
      const clone: WsTab = { ...at, id: tabId() };
      const np: WsPane = { id: npId, flex: 1, activeTabId: clone.id, tabs: [clone] };
      const out: WsPane[] = [];
      for (const p of panes) {
        out.push(p);
        if (p.id === paneIdArg) out.push(np);
      }
      return out;
    });
    this.focusPane(npId);
  }

  closePane(paneIdArg: string): void {
    this.panes.update((panes) =>
      panes.length <= 1 ? panes : this.normalize(panes.filter((p) => p.id !== paneIdArg)),
    );
  }

  /** Divider drag between panes i and i+1. */
  setPaneFlexPair(index: number, left: number, right: number): void {
    this.panes.update((panes) =>
      panes.map((p, i) =>
        i === index
          ? { ...p, flex: Math.max(MIN_FLEX, left) }
          : i === index + 1
            ? { ...p, flex: Math.max(MIN_FLEX, right) }
            : p,
      ),
    );
  }

  /** A host went away — its tabs go with it. */
  closeHost(hostId: string): void {
    this.panes.update((panes) =>
      this.normalize(
        panes.map((p) => {
          const tabs = p.tabs.filter((t) => t.hostId !== hostId);
          if (tabs.length === p.tabs.length) return p;
          const active = tabs.some((t) => t.id === p.activeTabId)
            ? p.activeTabId
            : (tabs[0]?.id ?? null);
          return { ...p, tabs, activeTabId: active };
        }),
      ),
    );
  }

  /** Panes emptied by a move/close collapse; focus falls back to a survivor. */
  private normalize(panes: WsPane[]): WsPane[] {
    let out = panes.filter((p) => p.tabs.length > 0);
    if (out.length === 0) out = [];
    const focus = this.focusedPaneId();
    if (focus && !out.some((p) => p.id === focus)) {
      this.focusedPaneId.set(out[0]?.id ?? null);
    }
    return out;
  }

  private updatePane(id: string, fn: (p: WsPane) => WsPane): void {
    this.panes.update((panes) => panes.map((p) => (p.id === id ? fn(p) : p)));
  }

  private updateTab(id: string, fn: (t: WsTab) => WsTab): void {
    this.panes.update((panes) =>
      panes.map((p) =>
        p.tabs.some((t) => t.id === id)
          ? { ...p, tabs: p.tabs.map((t) => (t.id === id ? fn(t) : t)) }
          : p,
      ),
    );
  }
}
