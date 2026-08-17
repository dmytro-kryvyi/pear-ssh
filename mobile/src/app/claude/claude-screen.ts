import {
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { PmHeader, PmIconBtn, PmSheet } from '../chrome/chrome';
import { PmIcon } from '../icons/icon';
import { PearSession } from '../state/session';
import { CTX_MAX } from './claude-demo';
import { CLAUDE_STORE } from './claude-store';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Same lineup as the desktop model menu; null = the CLI's default. */
const MODELS: { label: string; value: string | null }[] = [
  { label: 'Default', value: null },
  { label: 'Fable 5', value: 'claude-fable-5' },
  { label: 'Opus 4.8', value: 'claude-opus-4-8' },
  { label: 'Sonnet 5', value: 'claude-sonnet-5' },
  { label: 'Haiku 4.5', value: 'claude-haiku-4-5' },
];

/** Claude assistant screen — transcript chat over the scripted M1 demo store. */
@Component({
  selector: 'pm-claude-screen',
  imports: [PmHeader, PmIconBtn, PmIcon, PmSheet],
  templateUrl: './claude-screen.html',
  styleUrl: './claude-screen.scss',
})
export class PmClaudeScreen {
  readonly hostTap = output<void>();

  protected readonly session = inject(PearSession);
  protected readonly chat = inject(CLAUDE_STORE);
  private readonly sanitizer = inject(DomSanitizer);

  protected readonly input = signal('');
  protected readonly menuOpen = signal(false);
  protected readonly expanded = signal<Record<string, boolean>>({});

  private readonly body = viewChild<ElementRef<HTMLDivElement>>('body');
  private readonly ta = viewChild<ElementRef<HTMLTextAreaElement>>('ta');

  protected readonly pct = computed(() => Math.min(100, (this.chat.tokens() / CTX_MAX) * 100));
  protected readonly meterColor = computed(() =>
    this.pct() > 85 ? 'var(--err)' : this.pct() > 65 ? 'var(--warn)' : 'var(--claude)',
  );
  protected readonly tokensText = computed(() => `${(this.chat.tokens() / 1000).toFixed(1)}k / 200k`);

  constructor() {
    effect(() => {
      this.chat.messages();
      this.chat.busy();
      const el = this.body()?.nativeElement;
      if (el) queueMicrotask(() => (el.scrollTop = el.scrollHeight));
    });
  }

  protected openMenu(): void {
    this.chat.refreshSessions();
    this.menuOpen.set(!this.menuOpen());
  }

  protected pickClaudeHost(id: string): void {
    this.chat.hostPick?.set(id);
  }

  protected readonly models = MODELS;
  protected pickModel(value: string | null): void {
    this.chat.modelPick?.set(value);
  }

  private readonly richCache = new Map<string, SafeHtml>();
  protected rich(text: string): SafeHtml {
    let html = this.richCache.get(text);
    if (!html) {
      const rendered = esc(text)
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/`([^`]+)`/g, '<code>$1</code>');
      html = this.sanitizer.bypassSecurityTrustHtml(rendered);
      this.richCache.set(text, html);
    }
    return html;
  }

  protected isOpen(id: string, fallback = false): boolean {
    return this.expanded()[id] ?? fallback;
  }
  protected toggle(id: string, fallback = false): void {
    this.expanded.update((e) => ({ ...e, [id]: !(e[id] ?? fallback) }));
  }

  protected onEnter(event: KeyboardEvent): void {
    if (event.shiftKey) return;
    event.preventDefault();
    this.send();
  }

  protected send(): void {
    const text = this.input().trim();
    if (!text || this.chat.busy()) return;
    this.input.set('');
    const el = this.ta()?.nativeElement;
    if (el) el.style.height = 'auto';
    this.chat.send(text);
  }

  protected grow(event: Event): void {
    const el = event.target as HTMLTextAreaElement;
    this.input.set(el.value);
    el.style.height = 'auto';
    el.style.height = `${Math.min(96, el.scrollHeight)}px`;
  }

  protected loadSession(sessionId: string): void {
    this.chat.load(sessionId);
    this.menuOpen.set(false);
  }
  protected newSession(): void {
    this.chat.newSession();
    this.menuOpen.set(false);
    setTimeout(() => this.ta()?.nativeElement.focus(), 0);
  }

  protected tonePillClass(status: string): string {
    if (status === 'running') return 'run';
    if (status === 'error' || status === 'denied') return 'err';
    return 'ok';
  }
}
