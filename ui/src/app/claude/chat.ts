import {
  AfterViewInit,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { marked } from 'marked';
import type { ClaudeFileDiff } from '@pear/core';
import { PearIcon } from '../icons/icon';
import { ContextMenuService, type MenuItem } from '../menu/context-menu';
import { ClaudeChatStore, type ChatBlock } from './chat-store';

marked.use({ gfm: true, breaks: true });

// Current Claude lineup with context windows (claude-api reference, 2026-06).
const MODELS: { label: string; value: string | null; ctx: string }[] = [
  { label: 'Default', value: null, ctx: '' },
  { label: 'Fable 5', value: 'claude-fable-5', ctx: '1M' },
  { label: 'Opus 4.8', value: 'claude-opus-4-8', ctx: '1M' },
  { label: 'Sonnet 5', value: 'claude-sonnet-5', ctx: '1M' },
  { label: 'Haiku 4.5', value: 'claude-haiku-4-5', ctx: '200K' },
];

interface DiffLine {
  kind: 'same' | 'add' | 'del';
  text: string;
}

/** Line diff (LCS) for the write_file permission card; bails to "all new"
 *  beyond a size cap — permission cards are about seeing the change, not
 *  reviewing megabytes. */
export function diffLines(oldText: string, newText: string, cap = 400): DiffLine[] {
  const a = oldText ? oldText.split('\n') : [];
  const b = newText.split('\n');
  if (a.length > cap || b.length > cap) {
    return b.map((text) => ({ kind: 'add' as const, text }));
  }
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ kind: 'del', text: a[i++] });
    } else {
      out.push({ kind: 'add', text: b[j++] });
    }
  }
  while (i < a.length) out.push({ kind: 'del', text: a[i++] });
  while (j < b.length) out.push({ kind: 'add', text: b[j++] });
  return out;
}

/** Escapes HTML then renders the design's minimal inline markup: **bold**
 *  and `code`. Everything else stays literal. */
export function richText(text: string): string {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return escaped
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

/** The chat transcript + composer for the Claude dock's chat mode. */
@Component({
  selector: 'pear-claude-chat',
  imports: [PearIcon],
  templateUrl: './chat.html',
  styleUrl: './chat.scss',
})
export class ClaudeChat implements AfterViewInit {
  readonly store = inject(ClaudeChatStore);
  private readonly menu = inject(ContextMenuService);

  private readonly bodyEl = viewChild.required<ElementRef<HTMLDivElement>>('body');
  private readonly inputEl = viewChild.required<ElementRef<HTMLTextAreaElement>>('input');

  readonly draft = signal('');
  /** Open/closed state of collapsible blocks, keyed by block id. */
  readonly openBlocks = signal<ReadonlySet<string>>(new Set());
  private pinned = true;

  readonly ctxPct = computed(() =>
    Math.min(100, (this.store.contextTokens() / this.store.ctxMax()) * 100),
  );
  readonly ctxTone = computed(() => (this.ctxPct() > 85 ? 'err' : this.ctxPct() > 65 ? 'warn' : ''));

  constructor() {
    // Stick to the bottom while new content streams in (unless the user
    // scrolled up to read something).
    effect(() => {
      this.store.blocks();
      this.store.busy();
      if (!this.pinned) return;
      setTimeout(() => {
        const el = this.bodyEl().nativeElement;
        el.scrollTop = el.scrollHeight;
      });
    });
  }

  ngAfterViewInit(): void {
    this.store.start();
    setTimeout(() => this.inputEl().nativeElement.focus());
  }

  onScroll(): void {
    const el = this.bodyEl().nativeElement;
    this.pinned = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  }

  rich(text: string): string {
    return richText(text);
  }

  /** Assistant prose is markdown (tables, lists, fences) — render it fully.
   *  Angular's [innerHTML] sanitizer strips anything active. Tables get a
   *  scroll wrapper so wide ones scroll instead of breaking the layout
   *  (display:block on <table> itself would detach thead from tbody). */
  md(text: string): string {
    return marked
      .parse(text, { async: false })
      .replaceAll('<table>', '<div class="tbl-wrap"><table>')
      .replaceAll('</table>', '</table></div>');
  }

  /** 'claude-sonnet-4-5-20250929' → 'sonnet-4-5' for the meter chip. */
  modelLabel(): string {
    const m = this.store.model();
    if (!m) return 'model: default';
    return m.replace(/^claude-/, '').replace(/-\d{8}$/, '');
  }

  openModelMenu(event: MouseEvent): void {
    const items: MenuItem[] = MODELS.map((m) => ({
      label: m.label,
      shortcut: m.ctx,
      onClick: () => this.store.setModel(m.value),
    }));
    this.menu.open(event.clientX, event.clientY, items);
  }

  maxLabel(): string {
    const max = this.store.ctxMax();
    return max >= 1_000_000 ? '1M' : Math.round(max / 1000) + 'k';
  }

  diff(diff: ClaudeFileDiff): DiffLine[] {
    return diffLines(diff.oldText, diff.newText);
  }

  isOpen(id: string, defaultOpen = false): boolean {
    const set = this.openBlocks();
    return set.has(id) ? !defaultOpen : defaultOpen;
  }

  toggle(id: string): void {
    const next = new Set(this.openBlocks());
    if (next.has(id)) next.delete(id);
    else next.add(id);
    this.openBlocks.set(next);
  }

  grow(event: Event): void {
    const el = event.target as HTMLTextAreaElement;
    this.draft.set(el.value);
    el.style.height = 'auto';
    el.style.height = Math.min(120, el.scrollHeight) + 'px';
  }

  onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      this.send();
    }
  }

  send(): void {
    const text = this.draft().trim();
    if (!text || this.store.busy()) return;
    this.draft.set('');
    const el = this.inputEl().nativeElement;
    el.value = '';
    el.style.height = 'auto';
    this.pinned = true;
    void this.store.send(text);
  }

  stop(): void {
    this.store.interrupt();
  }

  pick(requestId: string, question: string, label: string): void {
    this.store.answerQuestion(requestId, { [question]: label });
  }

  toggleAutoApprove(): void {
    this.store.setAutoApprove(!this.store.autoApprove());
  }

  trackBlock(block: ChatBlock): string {
    return block.id;
  }

  tokensLabel(): string {
    return (this.store.contextTokens() / 1000).toFixed(1) + 'k';
  }
}
