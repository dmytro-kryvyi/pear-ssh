import { Injectable, inject, signal } from '@angular/core';
import { Pear } from '../pear';

export type TermRow = 'shell' | 'orch';

export interface TermTab {
  id: string;
  hostId: string;
  row: TermRow;
  title: string;
  /** Shell tabs: the folder this tab is bound to (null until first navigation). */
  cwd: string | null;
  /** Typed into the shell right after it opens (cd, docker logs, ...). */
  initialCommand: string | null;
  /** User has typed in this terminal — navigation must not repurpose it. */
  dirty: boolean;
  /** Backend terminal id, present once the shell channel is open. */
  termId?: string;
}

function shq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function baseName(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? '/';
}

let nextId = 0;
const newId = () => `tab-${++nextId}`;

/**
 * Terminal tab state. Shell-row tabs follow file-browser navigation:
 * a folder that already has a tab reactivates it (history intact) and an
 * abandoned clean tab is reclaimed; a tab's folder binding is permanent —
 * only the pristine initial shell is bound in place, otherwise navigation
 * to an unbound folder opens a fresh tab (replacing the active one when it
 * is clean). A tab the user has typed in is never repurposed or closed by
 * navigation. Orch-row tabs host docker/swarm/proxmox streams so they
 * never collide with user shells.
 */
@Injectable({ providedIn: 'root' })
export class TermTabs {
  private readonly pear = inject(Pear);

  readonly tabs = signal<TermTab[]>([]);
  readonly activeId = signal<string | null>(null);

  /** Resolved home dir per host — fresh shells open there, so they get
   *  bound to it and navigating home refocuses them. */
  private readonly homes = new Map<string, string>();

  /** Make sure a connected host has at least one shell tab, and activate it. */
  ensureShell(hostId: string): void {
    const shells = this.tabs().filter((t) => t.hostId === hostId && t.row === 'shell');
    if (shells.length === 0) {
      const home = this.homes.get(hostId) ?? null;
      this.add({ id: newId(), hostId, row: 'shell', title: 'bash', cwd: home, initialCommand: null, dirty: false });
      return;
    }
    const active = this.tabs().find((t) => t.id === this.activeId());
    if (!active || active.hostId !== hostId) this.activeId.set(shells[0].id);
  }

  /** The file browser resolved the host's home dir. Bind the initial shell
   *  to it — it already sits there, so no cd is written; navigating back
   *  home then refocuses that tab instead of spawning a new one. */
  bindHome(hostId: string, path: string): void {
    this.homes.set(hostId, path);
    const shells = this.tabs().filter((t) => t.hostId === hostId && t.row === 'shell');
    if (shells.some((t) => t.cwd === path)) return;
    const unbound = shells.find((t) => t.cwd === null && !t.initialCommand);
    if (unbound) this.update(unbound.id, { cwd: path });
  }

  newShell(hostId: string, cwd: string | null = null): void {
    this.add({
      id: newId(),
      hostId,
      row: 'shell',
      title: cwd ? baseName(cwd) : 'bash',
      cwd,
      initialCommand: cwd ? `cd ${shq(cwd)}` : null,
      dirty: false,
    });
  }

  /** Open (or reactivate) a dedicated stream tab for an orchestration action. */
  openOrch(hostId: string, command: string, title: string): void {
    const existing = this.tabs().find(
      (t) => t.hostId === hostId && t.row === 'orch' && t.initialCommand === command,
    );
    if (existing) {
      this.activeId.set(existing.id);
      return;
    }
    this.add({
      id: newId(),
      hostId,
      row: 'orch',
      title,
      cwd: null,
      initialCommand: command,
      dirty: false,
    });
  }

  /** The smart follow: called when the user navigates the file browser. */
  navigate(hostId: string, path: string): void {
    const shells = this.tabs().filter((t) => t.hostId === hostId && t.row === 'shell');
    const activeTab = this.tabs().find((t) => t.id === this.activeId());
    const active =
      activeTab && activeTab.hostId === hostId && activeTab.row === 'shell' ? activeTab : null;

    if (active?.cwd === path) return; // already there — no duplicate cd

    const existing = shells.find((t) => t.cwd === path);
    if (existing) {
      // activeId first, so close() doesn't run its fallback activation.
      this.activeId.set(existing.id);
      // Reclaim an abandoned navigation-created tab; a pristine `+ new`
      // shell (cwd null) was opened deliberately, so it stays.
      if (active && !active.dirty && active.cwd !== null) this.close(active.id);
      return;
    }

    if (active && !active.dirty) {
      if (active.cwd === null) {
        // Pristine initial shell — bind it with its single cd.
        this.update(active.id, { cwd: path, title: baseName(path) });
        if (active.termId) this.pear.api.term.write(active.termId, `cd ${shq(path)}\n`);
        return;
      }
      // Clean but bound to another folder: replace with a fresh tab —
      // no accumulated cd scrollback or shell history.
      this.close(active.id);
    }
    this.newShell(hostId, path);
  }

  /** Component reports its backend terminal id once the shell is open. */
  attach(tabId: string, termId: string): void {
    this.update(tabId, { termId });
  }

  markDirty(tabId: string): void {
    this.update(tabId, { dirty: true });
  }

  close(tabId: string): void {
    const closing = this.tabs().find((t) => t.id === tabId);
    this.tabs.update((all) => all.filter((t) => t.id !== tabId));
    if (this.activeId() === tabId && closing) {
      const siblings = this.tabs().filter((t) => t.hostId === closing.hostId);
      const sameRow = siblings.filter((t) => t.row === closing.row);
      this.activeId.set(sameRow.at(-1)?.id ?? siblings.at(-1)?.id ?? null);
    }
  }

  closeHost(hostId: string): void {
    const active = this.tabs().find((t) => t.id === this.activeId());
    this.tabs.update((all) => all.filter((t) => t.hostId !== hostId));
    if (active?.hostId === hostId) this.activeId.set(null);
  }

  private add(tab: TermTab): void {
    this.tabs.update((all) => [...all, tab]);
    this.activeId.set(tab.id);
  }

  private update(tabId: string, patch: Partial<TermTab>): void {
    this.tabs.update((all) => all.map((t) => (t.id === tabId ? { ...t, ...patch } : t)));
  }
}
