import { Injectable, inject, signal } from '@angular/core';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { PEAR_BACKEND } from '../backend';

// xterm themes need concrete colors; hex approximations of the oklch tokens
// in styles.scss (same palette as the desktop TERM_THEME).
const TERM_THEME = {
  background: '#16181d',
  foreground: '#f3f4f6',
  cursor: '#7ab8b3',
  cursorAccent: '#16181d',
  selectionBackground: '#7ab8b344',
  black: '#1c1f24',
  red: '#d9776b',
  green: '#7dc98f',
  yellow: '#d9b36b',
  blue: '#7ba3d9',
  magenta: '#b48ad1',
  cyan: '#72bdb7',
  white: '#c6c9ce',
  brightBlack: '#565b63',
  brightRed: '#e89287',
  brightGreen: '#93dba4',
  brightYellow: '#e8c887',
  brightBlue: '#93b8e8',
  brightMagenta: '#c9a3e3',
  brightCyan: '#8ad1cb',
  brightWhite: '#f3f4f6',
};

export type TermStatus = 'opening' | 'open' | 'exited' | 'failed';

export interface TermHandle {
  hostId: string;
  termId: string | null;
  xterm: Terminal;
  fit: FitAddon;
  /** Container the xterm lives in; panes re-append it on attach. */
  el: HTMLDivElement;
  status: ReturnType<typeof signal<TermStatus>>;
  opened: boolean;
  /** In-flight PTY open — single-flight guard for concurrent ensure(). */
  opening?: Promise<void>;
}

/**
 * Owns one live terminal per host: the xterm instance and its DOM element
 * survive tab switches and shell swaps (phone tab ↔ tablet split), only the
 * attachment point changes. Mirrors the desktop TermRegistry idea, sized for
 * mobile's one-terminal-per-host model.
 */
@Injectable({ providedIn: 'root' })
export class TermStore {
  private readonly backend = inject(PEAR_BACKEND);
  private readonly handles = new Map<string, TermHandle>();
  /** Data for termIds the UI hasn't associated yet (open() still in flight). */
  private readonly pending = new Map<string, string[]>();
  readonly openHosts = signal<string[]>([]);

  constructor() {
    this.backend.term.onData((termId, data) => {
      const handle = this.byTermId(termId);
      if (handle) {
        handle.xterm.write(data);
      } else {
        const buf = this.pending.get(termId) ?? [];
        buf.push(data);
        this.pending.set(termId, buf);
      }
    });
    this.backend.term.onExit((termId) => {
      const handle = this.byTermId(termId);
      if (!handle) return;
      handle.termId = null;
      handle.status.set('exited');
      handle.xterm.write('\r\n\x1b[2m[session closed — tap to reconnect]\x1b[0m\r\n');
    });
  }

  private byTermId(termId: string): TermHandle | undefined {
    for (const h of this.handles.values()) if (h.termId === termId) return h;
    return undefined;
  }

  handle(hostId: string): TermHandle | undefined {
    return this.handles.get(hostId);
  }

  /** Get or create the host's terminal; (re)opens the PTY when needed. */
  async ensure(hostId: string, cwd?: string): Promise<TermHandle> {
    let handle = this.handles.get(hostId);
    if (!handle) {
      const el = document.createElement('div');
      el.className = 'term-mount';
      const xterm = new Terminal({
        theme: TERM_THEME,
        fontFamily: '"JetBrains Mono", monospace',
        fontSize: 12.5,
        cursorBlink: true,
        scrollback: 4000,
      });
      const fit = new FitAddon();
      xterm.loadAddon(fit);
      handle = { hostId, termId: null, xterm, fit, el, status: signal<TermStatus>('opening'), opened: false };
      const h = handle;
      xterm.onData((data) => {
        if (h.termId) this.backend.term.write(h.termId, data);
      });
      xterm.onResize(({ cols, rows }) => {
        if (h.termId) this.backend.term.resize(h.termId, { cols, rows });
      });
      this.handles.set(hostId, handle);
      this.openHosts.update((ids) => [...ids, hostId]);
    }
    if (!handle.termId) await this.openOnce(handle, cwd);
    return handle;
  }

  /** Concurrent callers (orch action + the terminal screen's mount effect)
   *  must share one PTY open — a second open would orphan a remote shell
   *  whose output then buffers in `pending` forever. */
  private openOnce(handle: TermHandle, cwd?: string): Promise<void> {
    handle.opening ??= this.open(handle, cwd).finally(() => {
      handle.opening = undefined;
    });
    return handle.opening;
  }

  private async open(handle: TermHandle, cwd?: string): Promise<void> {
    if (handle.termId) return;
    handle.status.set('opening');
    try {
      const size = { cols: handle.xterm.cols || 80, rows: handle.xterm.rows || 24 };
      const termId = await this.backend.term.open(handle.hostId, size, { cwd });
      handle.termId = termId;
      handle.status.set('open');
      const buffered = this.pending.get(termId);
      if (buffered) {
        this.pending.delete(termId);
        for (const chunk of buffered) handle.xterm.write(chunk);
      }
    } catch (err) {
      handle.status.set('failed');
      const message = err instanceof Error ? err.message : String(err);
      handle.xterm.write(`\r\n\x1b[31m${message}\x1b[0m\r\n`);
    }
  }

  /** Reopen after an exit/failure (tap-to-reconnect). */
  async reconnect(hostId: string): Promise<void> {
    const handle = this.handles.get(hostId);
    if (handle && !handle.termId) await this.openOnce(handle);
  }

  /** Mount the host's terminal into a pane and size it to fit. */
  attach(hostId: string, parent: HTMLElement): void {
    const handle = this.handles.get(hostId);
    if (!handle) return;
    parent.appendChild(handle.el);
    if (!handle.opened) {
      handle.xterm.open(handle.el);
      handle.opened = true;
    }
    queueMicrotask(() => handle.fit.fit());
  }

  fitTo(hostId: string): void {
    const handle = this.handles.get(hostId);
    if (handle?.opened && handle.el.isConnected) handle.fit.fit();
  }

  /** Type into the host's terminal (quick keys, orch streaming commands). */
  write(hostId: string, data: string): void {
    const handle = this.handles.get(hostId);
    if (handle?.termId) this.backend.term.write(handle.termId, data);
  }

  /** Ensure a terminal and run a command in it (orch logs/console). */
  async run(hostId: string, command: string): Promise<void> {
    await this.ensure(hostId);
    this.write(hostId, command + '\n');
  }

  focus(hostId: string): void {
    this.handles.get(hostId)?.xterm.focus();
  }

  close(hostId: string): void {
    const handle = this.handles.get(hostId);
    if (!handle) return;
    if (handle.termId) this.backend.term.close(handle.termId);
    handle.xterm.dispose();
    handle.el.remove();
    this.handles.delete(hostId);
    this.openHosts.update((ids) => ids.filter((id) => id !== hostId));
  }
}
