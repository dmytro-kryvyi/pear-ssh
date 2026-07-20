import {
  AfterViewInit,
  Component,
  ElementRef,
  OnDestroy,
  effect,
  inject,
  input,
  output,
  viewChild,
} from '@angular/core';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Pear } from '../pear';
import { Settings } from '../settings';
import { History } from './history';
import { InlineSuggest } from './suggest';
import type { TermTab } from './tabs';

// xterm themes need concrete colors; these are hex approximations of the
// oklch design tokens in styles.scss.
const THEME = {
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

@Component({
  selector: 'pear-terminal',
  templateUrl: './terminal.html',
  styleUrl: './terminal.scss',
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
  private readonly history = inject(History);
  private readonly settings = inject(Settings);

  private xterm?: Terminal;
  private fit?: FitAddon;
  private suggest?: InlineSuggest;
  private termId?: string;
  private resizeObserver?: ResizeObserver;
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
      theme: THEME,
    });
    const fit = new FitAddon();
    xterm.loadAddon(fit);
    xterm.open(this.hostEl().nativeElement);
    fit.fit();
    this.xterm = xterm;
    this.fit = fit;

    const { term } = this.pear.api;
    const tab = this.tab();
    try {
      const id = await term.open(
        tab.hostId,
        { cols: xterm.cols, rows: xterm.rows },
        this.password(),
      );
      this.termId = id;
      this.opened.emit(id);
      if (tab.initialCommand) term.write(id, `${tab.initialCommand}\n`);

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

      this.resizeObserver = new ResizeObserver(() => this.refit());
      this.resizeObserver.observe(this.hostEl().nativeElement);
      if (this.active()) xterm.focus();
    } catch (err) {
      this.failed.emit(cleanIpcError(err));
    }
  }

  /** First printable keystroke marks the tab as user-owned ("has history"). */
  private trackDirty(data: string): void {
    if (this.reportedDirty) return;
    if (/[\x20-\x7e]/.test(data)) {
      this.reportedDirty = true;
      this.dirtied.emit();
    }
  }

  private refit(): void {
    const el = this.hostEl().nativeElement;
    if (!this.fit || !this.xterm || el.offsetWidth === 0 || el.offsetHeight === 0) return;
    this.fit.fit();
    if (this.termId) {
      this.pear.api.term.resize(this.termId, { cols: this.xterm.cols, rows: this.xterm.rows });
    }
  }

  ngOnDestroy(): void {
    this.resizeObserver?.disconnect();
    for (const unsub of this.unsubscribes) unsub();
    if (this.termId) this.pear.api.term.close(this.termId);
    this.xterm?.dispose();
  }
}

function cleanIpcError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}
