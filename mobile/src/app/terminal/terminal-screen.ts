import {
  Component,
  ElementRef,
  OnDestroy,
  computed,
  effect,
  inject,
  input,
  output,
  viewChild,
} from '@angular/core';
import { PmHeader, PmIconBtn } from '../chrome/chrome';
import { PmIcon } from '../icons/icon';
import { PearSession } from '../state/session';
import { TermStore } from './term-store';

const QUICK = ['sudo ', 'ls -la', 'cd ..', 'cat ', '|', '~', '/', '-'];

const KEYS: { label: string; seq: string }[] = [
  { label: 'Esc', seq: '\x1b' },
  { label: 'Tab', seq: '\t' },
  { label: '^C', seq: '\x03' },
  { label: '^D', seq: '\x04' },
  { label: '^L', seq: '\x0c' },
  { label: '←', seq: '\x1b[D' },
  { label: '↑', seq: '\x1b[A' },
  { label: '↓', seq: '\x1b[B' },
  { label: '→', seq: '\x1b[C' },
];

/**
 * Terminal screen — real xterm.js over the backend PTY (M3). The xterm
 * instances live in TermStore and survive shell/tab switches; this
 * component is just the mount point plus the design's quick-key row and
 * the Esc/Tab/^C/arrows accessory bar.
 */
@Component({
  selector: 'pm-terminal-screen',
  imports: [PmHeader, PmIconBtn, PmIcon],
  templateUrl: './terminal-screen.html',
  styleUrl: './terminal-screen.scss',
})
export class PmTerminalScreen implements OnDestroy {
  readonly compact = input(false);
  readonly hostTap = output<void>();

  protected readonly session = inject(PearSession);
  protected readonly store = inject(TermStore);
  protected readonly quick = QUICK;
  protected readonly keys = KEYS;

  private readonly mount = viewChild<ElementRef<HTMLDivElement>>('mount');
  private observer?: ResizeObserver;

  protected readonly status = computed(() => {
    this.store.openHosts();
    const id = this.session.activeHostId();
    return id ? (this.store.handle(id)?.status() ?? null) : null;
  });

  protected readonly tabs = computed(() => {
    const open = this.store.openHosts();
    const active = this.session.activeHostId();
    const ids = active && !open.includes(active) ? [...open, active] : open;
    return ids
      .map((id) => this.session.hosts().find((h) => h.id === id))
      .filter((h) => h !== undefined);
  });

  constructor() {
    effect(() => {
      const hostId = this.session.activeHostId();
      const el = this.mount()?.nativeElement;
      if (!hostId || !el) return;
      void this.store.ensure(hostId).then(() => {
        if (this.session.activeHostId() !== hostId) return;
        el.replaceChildren();
        this.store.attach(hostId, el);
        this.observer?.disconnect();
        this.observer = new ResizeObserver(() => this.store.fitTo(hostId));
        this.observer.observe(el);
      });
    });
  }

  ngOnDestroy(): void {
    this.observer?.disconnect();
  }

  protected send(seq: string): void {
    const id = this.session.activeHostId();
    if (!id) return;
    if (this.status() === 'exited' || this.status() === 'failed') {
      void this.store.reconnect(id);
      return;
    }
    this.store.write(id, seq);
    this.store.focus(id);
  }

  protected clear(): void {
    this.send('\x0c');
  }

  protected reconnect(): void {
    const id = this.session.activeHostId();
    if (id) void this.store.reconnect(id);
  }

  protected switchTo(hostId: string): void {
    const host = this.session.hosts().find((h) => h.id === hostId);
    if (host) this.session.connect(host);
  }

  protected statusLabel(): string {
    switch (this.status()) {
      case 'opening': return 'connecting…';
      case 'open': return 'connected';
      case 'exited': return 'closed';
      case 'failed': return 'failed';
      default: return '';
    }
  }
}
