import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { HostCatalog } from '../hosts';
import type { RemoteControl } from '@pear/core';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { copySelection, handleClipboardKeys, pasteClipboard } from './clipboard-keys';
import { Pear } from '../pear';
import { Settings } from '../settings';
import { ContextMenuService } from '../menu/context-menu';
import { History } from './history';
import { InlineSuggest } from './suggest';
import { TermRegistry } from './term-registry';
import { TermTabs, type TermTab } from './tabs';

// xterm themes need concrete colors; these are hex approximations of the
// oklch design tokens in styles.scss.
export const TERM_THEME = {
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

/** Server terminals this page already follows (opened or adopted). */
const ADOPTED = new Set<string>();

/** Pane dividers and the dock resizer fire a resize per pointer move; the
 *  shell only needs the final geometry (each one is a SIGWINCH and a prompt
 *  redraw on the host). The local refit still follows every frame. */
const REMOTE_RESIZE_DEBOUNCE_MS = 80;

@Component({
  selector: 'pear-terminal',
  templateUrl: './terminal.html',
  styleUrl: './terminal.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TerminalPane implements AfterViewInit, OnDestroy {
  readonly tab = input.required<TermTab>();
  readonly password = input<string>();
  readonly active = input(false);

  readonly opened = output<string>();
  readonly dirtied = output<void>();
  readonly exited = output<void>();
  readonly failed = output<string>();

  private readonly hostEl = viewChild.required<ElementRef<HTMLDivElement>>('host');
  private readonly pear = inject(Pear);
  private readonly termTabs = inject(TermTabs);
  private readonly history = inject(History);
  private readonly settings = inject(Settings);
  private readonly menu = inject(ContextMenuService);
  private readonly registry = inject(TermRegistry);
  private readonly catalog = inject(HostCatalog);

  /** Shown over the empty xterm until the shell channel is open. */
  readonly connecting = signal(true);
  readonly hostName = computed(() => this.catalog.byId(this.tab().hostId)?.name ?? 'host');

  private xterm?: Terminal;
  private fit?: FitAddon;
  private suggest?: InlineSuggest;
  private termId?: string;
  private resizeObserver?: ResizeObserver;
  private refitFrame: number | null = null;
  private remoteResizeTimer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribes: Array<() => void> = [];
  private reportedDirty = false;

  constructor() {
    // Refit + focus when this tab becomes visible
    effect(() => {
      if (this.active() && this.xterm) {
        setTimeout(() => {
          this.refit();
          this.xterm?.focus();
        });
      }
    });

    effect(() => this.suggest?.setEnabled(this.settings.suggestions()));
  }

  async ngAfterViewInit(): Promise<void> {
    const xterm = new Terminal({
      fontFamily: "'JetBrains Mono', ui-monospace, monospace",
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      scrollback: 10_000,
      theme: TERM_THEME,
    });
    xterm.attachCustomKeyEventHandler((e) => handleClipboardKeys(xterm, e));
    const fit = new FitAddon();
    xterm.loadAddon(fit);
    xterm.open(this.hostEl().nativeElement);
    fit.fit();
    this.xterm = xterm;
    this.fit = fit;
    this.registry.register(this.tab().id, (lines) => readBuffer(xterm, lines));

    const { term } = this.pear.api;
    const tab = this.tab();
    try {
      const size = { cols: xterm.cols, rows: xterm.rows };
      const adopted = await this.adoptSurvivor(tab, size);
      const id =
        adopted ?? (await term.open(tab.hostId, size, { password: this.password() || undefined }));
      this.termId = id;
      ADOPTED.add(id);
      this.connecting.set(false);
      this.opened.emit(id);
      // Re-read from the store: `tab` was snapshotted before the open
      // round-trip, and a bindShell during it (open-terminal-here on a shell
      // still connecting) lands its cd in initialCommand — the input signal
      // may not have re-bound yet, so the snapshot would miss it.
      const live = this.termTabs.byId().get(tab.id) ?? tab;
      // An adopted shell is mid-life — it may be sitting in vim. Never type
      // the tab's opening `cd` into it.
      if (live.initialCommand && !adopted) term.write(id, `${live.initialCommand}\n`);

      const suggest = new InlineSuggest(xterm, {
        lookup: (prefix) => this.history.suggest(prefix, tab.hostId),
        send: (data) => term.write(id, data),
        onCommand: (command) => this.history.record(tab.hostId, command),
      });
      suggest.setEnabled(this.settings.suggestions());
      this.suggest = suggest;
      // Opt-in, and a no-op unless the user enabled the remote-history scan.
      void this.history.importFromHost(tab.hostId);

      this.unsubscribes.push(
        term.onData((tid, data) => {
          if (tid === id) suggest.handleOutput(data);
        }),
        term.onExit((tid) => {
          if (tid === id) {
            this.termId = undefined;
            this.exited.emit();
          }
        }),
      );
      xterm.onData((data) => {
        this.trackDirty(data);
        suggest.handleInput(data);
      });

      this.resizeObserver = new ResizeObserver(() => this.scheduleRefit());
      this.resizeObserver.observe(this.hostEl().nativeElement);
      if (this.active()) xterm.focus();
    } catch (err) {
      this.connecting.set(false);
      this.failed.emit(cleanIpcError(err));
    }
  }

  /** Coalesce a burst of ResizeObserver callbacks into one fit per frame. */
  private scheduleRefit(): void {
    if (this.refitFrame !== null) return;
    this.refitFrame = requestAnimationFrame(() => {
      this.refitFrame = null;
      this.refit();
    });
  }

  onContextMenu(event: MouseEvent): void {
    event.preventDefault();
    const xterm = this.xterm;
    if (!xterm) return;
    this.menu.open(event.clientX, event.clientY, [
      {
        label: 'Copy',
        icon: 'copy',
        shortcut: 'Ctrl+Shift+C',
        disabled: !xterm.hasSelection(),
        onClick: () => copySelection(xterm),
      },
      {
        label: 'Paste',
        icon: 'clipboard',
        shortcut: 'Ctrl+Shift+V',
        onClick: () => {
          void pasteClipboard(xterm);
          xterm.focus();
        },
      },
      { divider: true },
      { label: 'Select All', onClick: () => xterm.selectAll() },
    ]);
  }

  /** First printable keystroke marks the tab as user-owned ("has history"). */
  private trackDirty(data: string): void {
    if (this.reportedDirty) return;
    if (/[\x20-\x7e]/.test(data)) {
      this.reportedDirty = true;
      this.dirtied.emit();
    }
  }

  /**
   * Served by a pear-server, shells outlive the page: a reload (or an iPad
   * evicting the tab) leaves them running there. A plain shell tab picks one
   * back up — scrollback and all — rather than opening a second beside it.
   * Orch tabs exist to run one command (logs, consoles) and always start fresh.
   */
  private async adoptSurvivor(
    tab: TermTab,
    size: { cols: number; rows: number },
  ): Promise<string | undefined> {
    const remote = (this.pear.api as { remote?: RemoteControl }).remote;
    if (!remote || tab.row !== 'shell') return undefined;
    try {
      const survivor = (await remote.listTerminals())
        .filter((t) => t.kind === 'shell' && t.hostId === tab.hostId && !t.exited)
        .filter((t) => !ADOPTED.has(t.termId))
        .sort((a, b) => a.createdAt - b.createdAt)[0];
      if (!survivor) return undefined;
      ADOPTED.add(survivor.termId); // before the await: two tabs open concurrently
      await remote.adoptTerminal(survivor.termId, size);
      return survivor.termId;
    } catch {
      return undefined;
    }
  }

  private refit(): void {
    const el = this.hostEl().nativeElement;
    if (!this.fit || !this.xterm || el.offsetWidth === 0 || el.offsetHeight === 0) return;
    const before = { cols: this.xterm.cols, rows: this.xterm.rows };
    this.fit.fit();
    if (this.xterm.cols === before.cols && this.xterm.rows === before.rows) return;
    if (this.remoteResizeTimer) clearTimeout(this.remoteResizeTimer);
    this.remoteResizeTimer = setTimeout(() => {
      this.remoteResizeTimer = null;
      if (this.termId && this.xterm) {
        this.pear.api.term.resize(this.termId, { cols: this.xterm.cols, rows: this.xterm.rows });
      }
    }, REMOTE_RESIZE_DEBOUNCE_MS);
  }

  ngOnDestroy(): void {
    this.registry.unregister(this.tab().id);
    this.resizeObserver?.disconnect();
    if (this.refitFrame !== null) cancelAnimationFrame(this.refitFrame);
    if (this.remoteResizeTimer) clearTimeout(this.remoteResizeTimer);
    for (const unsub of this.unsubscribes) unsub();
    if (this.termId) this.pear.api.term.close(this.termId);
    this.xterm?.dispose();
  }
}

/** Last N buffer lines (screen + scrollback) as plain text, trailing blank
 *  lines trimmed. translateToString(true) drops right-side padding. */
function readBuffer(xterm: Terminal, lines: number): string {
  const buf = xterm.buffer.active;
  const end = buf.length;
  const start = Math.max(0, end - lines);
  const out: string[] = [];
  for (let i = start; i < end; i++) out.push(buf.getLine(i)?.translateToString(true) ?? '');
  while (out.length && out[out.length - 1] === '') out.pop();
  return out.join('\n');
}

function cleanIpcError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}
