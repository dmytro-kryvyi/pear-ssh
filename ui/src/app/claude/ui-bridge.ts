import { Injectable, inject } from '@angular/core';
import type {
  ClaudeRevealAction,
  ClaudeTerminalInfo,
  ClaudeUiRequestPayload,
} from '@pear/core';
import { Pear } from '../pear';
import { HostCatalog } from '../hosts';
import { TermTabs } from '../terminal/tabs';
import { TermRegistry } from '../terminal/term-registry';
import { Workspace, dirnameOf } from '../workspace/workspace';
import { OrchStore } from '../orch/store';

const DEFAULT_LINES = 200;
const MAX_LINES = 10_000; // xterm scrollback cap

/**
 * Serves the main process's claude:uiRequest round-trips (read_terminal,
 * reveal_in_app MCP tools). Every request gets exactly one uiRespond, error
 * or not — main times out otherwise. All handlers are synchronous signal
 * work; nothing here mutates anything beyond opening tabs/drawers.
 */
@Injectable({ providedIn: 'root' })
export class ClaudeUiBridge {
  private readonly pear = inject(Pear);
  private readonly catalog = inject(HostCatalog);
  private readonly tabs = inject(TermTabs);
  private readonly registry = inject(TermRegistry);
  private readonly ws = inject(Workspace);
  private readonly orchStore = inject(OrchStore);

  private unsubscribe: (() => void) | null = null;

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.pear.api.claude.onUiRequest(({ id, payload }) => {
      try {
        this.pear.api.claude.uiRespond({ id, ok: true, value: this.dispatch(payload) });
      } catch (err) {
        this.pear.api.claude.uiRespond({
          id,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });
  }

  /** Public for tests: pure dispatch over the injected stores. */
  dispatch(payload: ClaudeUiRequestPayload): unknown {
    switch (payload.kind) {
      case 'listTerminals':
        return this.listTerminals();
      case 'readTerminal':
        return this.readTerminal(payload.terminalId, payload.lines);
      case 'reveal':
        return this.reveal(payload.action);
    }
  }

  /** Only tabs with a live xterm (registered reader) are listed/readable —
   *  the Claude dock's own CLI terminal never enters TermTabs at all. */
  private listTerminals(): ClaudeTerminalInfo[] {
    const activeId = this.tabs.activeId();
    return this.tabs
      .tabs()
      .filter((t) => this.registry.has(t.id))
      .map((t) => ({
        id: t.id,
        hostId: t.hostId,
        hostName: this.catalog.nameOf(t.hostId),
        title: t.title,
        active: t.id === activeId,
      }));
  }

  private readTerminal(terminalId?: string, lines?: number): string {
    const id = terminalId ?? this.tabs.activeId();
    if (!id) throw new Error('No terminal is open');
    const n = Math.max(1, Math.min(MAX_LINES, Math.floor(lines ?? DEFAULT_LINES)));
    const text = this.registry.read(id, n);
    if (text === null) throw new Error(`Unknown terminal '${id}' — call list_terminals`);
    return text;
  }

  private reveal(action: ClaudeRevealAction): { done: true } {
    switch (action.type) {
      case 'open_dir':
        this.openDirTab(action.hostId, action.path);
        break;
      case 'open_file': {
        let pane = this.ws.focusedPane();
        if (!pane) {
          this.ws.newTab(null, action.hostId, dirnameOf(action.path));
          pane = this.ws.focusedPane();
        }
        if (!pane) throw new Error('Workspace is not available');
        this.ws.openFile(pane.id, action.hostId, action.path);
        break;
      }
      case 'open_service_logs':
        this.orchStore.openDrawer({
          hostId: action.hostId,
          serviceName: action.service,
          ...(action.taskId ? { initialTaskId: action.taskId } : {}),
        });
        break;
      case 'focus_host': {
        // Refocus any existing tab of that host before opening a fresh one.
        const panes = this.ws.panes();
        const pane = panes.find((p) => p.tabs.some((t) => t.hostId === action.hostId));
        const tab = pane?.tabs.find((t) => t.hostId === action.hostId);
        if (pane && tab) this.ws.activateTab(pane.id, tab.id);
        else this.ws.newTab(null, action.hostId, '~');
        break;
      }
    }
    return { done: true };
  }

  /** Dir tabs dedupe across all panes, mirroring openToSide's logic. */
  private openDirTab(hostId: string, path: string): void {
    for (const pane of this.ws.panes()) {
      const existing = pane.tabs.find(
        (t) => t.kind === 'dir' && t.hostId === hostId && t.path === path,
      );
      if (existing) {
        this.ws.activateTab(pane.id, existing.id);
        return;
      }
    }
    this.ws.newTab(null, hostId, path);
  }
}
