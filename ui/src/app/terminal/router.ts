import { Injectable, inject } from '@angular/core';
import { Settings } from '../settings';
import { Workspace, type WsPane, type WsTab } from '../workspace/workspace';
import { TermTabs, type TermTab } from './tabs';

/**
 * Placement-aware routing for features that open or target a terminal
 * (file-list "open terminal here", orchestration streams). With the bottom
 * dock visible these delegate straight to TermTabs; with in-pane placement
 * the dock is hidden, so the same requests must land in a workspace pane —
 * otherwise the tab is created in a model nothing renders.
 */
@Injectable({ providedIn: 'root' })
export class TermRouter {
  private readonly tabs = inject(TermTabs);
  private readonly ws = inject(Workspace);
  private readonly settings = inject(Settings);

  private inPane(): boolean {
    return this.settings.termPlacement() === 'in-pane';
  }

  /** Every pane tab that wraps a live TermTab, with its owners. */
  private paneTerms(): { pane: WsPane; wsTab: WsTab; term: TermTab }[] {
    const byId = this.tabs.byId();
    return this.ws
      .paneTermRefs()
      .flatMap(({ pane, wsTab, termTabId }) => {
        const term = byId.get(termTabId);
        return term ? [{ pane, wsTab, term }] : [];
      });
  }

  /** Open (or focus) a shell at a folder — the "open terminal here" action. */
  openShell(hostId: string, path: string): void {
    if (!this.inPane()) {
      this.tabs.navigate(hostId, path);
      return;
    }
    const shells = this.paneTerms().filter(
      (e) => e.term.hostId === hostId && e.term.row === 'shell',
    );
    const bound = shells.find((e) => e.term.cwd === path);
    if (bound) {
      this.ws.activateTab(bound.pane.id, bound.wsTab.id);
      return;
    }
    // A pristine shell (never typed in, not yet bound) is bound in place with
    // a single cd — the dock's smart-follow rule, but scoped to the pane the
    // user is acting in: repurposing a blank shell they placed in ANOTHER
    // pane would mutate it and yank focus across the layout.
    const focusedPaneId = this.ws.focusedPane()?.id;
    const pristine = shells.find(
      (e) => e.pane.id === focusedPaneId && e.term.cwd === null && !e.term.dirty,
    );
    if (pristine) {
      this.tabs.bindShell(pristine.term.id, path);
      this.ws.activateTab(pristine.pane.id, pristine.wsTab.id);
      return;
    }
    this.ws.openTermTab(null, hostId, this.tabs.createShell(hostId, path));
  }

  /** Open a dedicated stream tab (logs, service ps, prune, ...). */
  openOrch(hostId: string, command: string, title: string): void {
    if (!this.inPane()) {
      this.tabs.openOrch(hostId, command, title);
      return;
    }
    // Mirror the dock's replace semantics: the old stream may have ended, so
    // only a fresh run is guaranteed to show current output. Insert the fresh
    // tab into the SAME pane before closing the old one — close-first would
    // collapse a pane whose only tab was the stream, relocating the refresh.
    const existing = this.paneTerms().find(
      (e) =>
        e.term.hostId === hostId && e.term.row === 'orch' && e.term.initialCommand === command,
    );
    const fresh = this.tabs.createOrch(hostId, command, title);
    this.ws.openTermTab(existing?.pane.id ?? null, hostId, fresh);
    if (existing) {
      this.tabs.close(existing.term.id);
      this.ws.closeTab(existing.wsTab.id);
    }
  }
}
