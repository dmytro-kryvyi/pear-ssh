import {
  AfterViewInit,
  Component,
  ElementRef,
  OnDestroy,
  effect,
  inject,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import {
  copySelection,
  handleClipboardKeys,
  pasteClipboard,
} from '../terminal/clipboard-keys';
import { Pear } from '../pear';
import { PearIcon } from '../icons/icon';
import { ContextMenuService, type MenuItem } from '../menu/context-menu';
import { TERM_THEME } from '../terminal/terminal';
import { Settings } from '../settings';
import { ClaudeChat } from './chat';
import { ClaudeChatStore } from './chat-store';

type DockState = 'checking' | 'missing' | 'ready';

/**
 * The Claude Code dock: the user's own `claude` CLI running in a local PTY,
 * launched in Pear's workspace dir (which wires it to the pear MCP tools).
 * Pear renders the terminal and nothing else — login, permission prompts,
 * slash commands and sessions are all the CLI's native UX.
 */
@Component({
  selector: 'pear-claude-dock',
  imports: [PearIcon, ClaudeChat],
  templateUrl: './dock.html',
  styleUrl: './dock.scss',
})
export class ClaudeDock implements AfterViewInit, OnDestroy {
  readonly closed = output<void>();

  private readonly termEl = viewChild<ElementRef<HTMLDivElement>>('term');
  private readonly pear = inject(Pear);
  private readonly menu = inject(ContextMenuService);
  readonly settings = inject(Settings);
  readonly chat = inject(ClaudeChatStore);

  readonly state = signal<DockState>('checking');
  readonly mcpReady = signal(true);
  readonly exited = signal(false);
  readonly error = signal<string | null>(null);

  private xterm?: Terminal;
  private fit?: FitAddon;
  private termId?: string;
  private resizeObserver?: ResizeObserver;
  private unsubscribes: Array<() => void> = [];

  constructor() {
    // Terminal-mode lifecycle follows the mode setting: entering terminal
    // mode boots the PTY, leaving it tears the PTY down (the CLI session
    // itself survives — /resume picks it up next time).
    effect(() => {
      const mode = this.settings.claudeMode();
      if (this.state() !== 'ready') return;
      if (mode === 'terminal' && !this.xterm) {
        setTimeout(() => void this.start());
      } else if (mode === 'chat' && this.xterm) {
        this.teardownTerm();
        this.exited.set(false);
      }
    });
  }

  async ngAfterViewInit(): Promise<void> {
    await this.recheck();
  }

  async recheck(): Promise<void> {
    this.state.set('checking');
    try {
      const status = await this.pear.api.claude.status();
      this.mcpReady.set(status.mcpReady);
      this.state.set(status.installed ? 'ready' : 'missing');
    } catch (err) {
      this.state.set('missing');
      this.error.set(cleanIpcError(err));
    }
  }

  openHistory(event: MouseEvent): void {
    void this.chat.loadSessions().then(() => {
      const items: MenuItem[] = this.chat
        .sessions()
        .slice(0, 12)
        .map((s) => ({
          label: s.title,
          onClick: () => void this.chat.resume(s.id),
        }));
      this.menu.open(event.clientX, event.clientY, [
        ...items,
        ...(items.length ? [{ divider: true } as MenuItem] : []),
        { label: 'New session', icon: 'plus', onClick: () => void this.chat.newSession() },
      ]);
    });
  }

  /** (Re)starts the claude PTY with a fresh xterm. */
  async start(): Promise<void> {
    const el = this.termEl()?.nativeElement;
    if (!el) return;
    this.teardownTerm();
    this.exited.set(false);
    this.error.set(null);

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
    xterm.open(el);
    fit.fit();
    this.xterm = xterm;
    this.fit = fit;

    const { term, claude } = this.pear.api;
    try {
      const id = await claude.open({ cols: xterm.cols, rows: xterm.rows });
      this.termId = id;
      this.unsubscribes.push(
        term.onData((tid, data) => {
          if (tid === id) xterm.write(data);
        }),
        term.onExit((tid) => {
          if (tid === id) {
            this.termId = undefined;
            this.exited.set(true);
          }
        }),
      );
      xterm.onData((data) => term.write(id, data));

      this.resizeObserver = new ResizeObserver(() => this.refit());
      this.resizeObserver.observe(el);
      xterm.focus();
    } catch (err) {
      this.error.set(cleanIpcError(err));
      this.exited.set(true);
    }
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

  private refit(): void {
    const el = this.termEl()?.nativeElement;
    if (!this.fit || !this.xterm || !el || el.offsetWidth === 0 || el.offsetHeight === 0) return;
    this.fit.fit();
    if (this.termId) {
      this.pear.api.term.resize(this.termId, { cols: this.xterm.cols, rows: this.xterm.rows });
    }
  }

  private teardownTerm(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = undefined;
    for (const unsub of this.unsubscribes) unsub();
    this.unsubscribes = [];
    if (this.termId) this.pear.api.term.close(this.termId);
    this.termId = undefined;
    this.xterm?.dispose();
    this.xterm = undefined;
    this.fit = undefined;
  }

  ngOnDestroy(): void {
    this.teardownTerm();
  }
}

function cleanIpcError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}
