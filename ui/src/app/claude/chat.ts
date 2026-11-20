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
import type { ClaudeFileDiff, ClaudeQuestion } from '@pear/core';
import { PearIcon } from '../icons/icon';
import { ContextMenuService, type MenuItem } from '../menu/context-menu';
import { Settings } from '../settings';
import { Clipboard } from '../clipboard';
import { selectContents, selectionText } from '../menu/menu-items';
import { ClaudeChatStore, type ChatBlock } from './chat-store';
import { ModelPicker } from './model-picker';

marked.use({ gfm: true, breaks: true });

/** Option label for the free-text choice every AskUserQuestion allows. */
const OTHER = '__other__';

type QuestionBlock = Extract<ChatBlock, { kind: 'question' }>;

/** Unsubmitted answers of one question card, keyed by question text. */
interface QuestionDraft {
  picks: Record<string, string[]>;
  other: Record<string, string>;
}

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
  imports: [PearIcon, ModelPicker],
  templateUrl: './chat.html',
  styleUrl: './chat.scss',
})
export class ClaudeChat implements AfterViewInit {
  readonly store = inject(ClaudeChatStore);
  private readonly menu = inject(ContextMenuService);
  private readonly settings = inject(Settings);
  private readonly clipboard = inject(Clipboard);

  private readonly bodyEl = viewChild.required<ElementRef<HTMLDivElement>>('body');
  private readonly inputEl = viewChild.required<ElementRef<HTMLTextAreaElement>>('input');

  readonly draft = signal('');
  /** Open/closed state of collapsible blocks, keyed by block id. */
  readonly openBlocks = signal<ReadonlySet<string>>(new Set());
  /** Answers being composed on question cards, keyed by requestId. */
  readonly qDrafts = signal<ReadonlyMap<string, QuestionDraft>>(new Map());
  readonly pickerOpen = signal(false);
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
    return wrapCodeBlocks(
      marked
        .parse(text, { async: false })
        .replaceAll('<table>', '<div class="tbl-wrap"><table>')
        .replaceAll('</table>', '</table></div>'),
    );
  }

  /** Clicks inside rendered markdown: the Copy control on fenced blocks is
   *  plain HTML (the sanitizer strips <button>), so it is handled here. */
  onBodyClick(event: MouseEvent): void {
    const copy = (event.target as HTMLElement | null)?.closest<HTMLElement>('.code-copy');
    if (!copy) return;
    const pre = copy.closest('.code-wrap')?.querySelector('pre');
    if (!pre) return;
    void this.clipboard.copy(pre.textContent ?? '').then(() => {
      copy.textContent = 'Copied';
      copy.classList.add('done');
      setTimeout(() => {
        copy.textContent = 'Copy';
        copy.classList.remove('done');
      }, 1200);
    });
  }

  /** The chip: the picked entry's name when the CLI list knows it, else the
   *  id the CLI reported ('claude-sonnet-4-5-20250929' → 'sonnet-4-5'). */
  modelLabel(): string {
    const picked = this.settings.claudeModel();
    const known = this.store.models()?.find((m) => m.value === (picked || 'default'));
    if (known) return known.displayName.replace(/ \(recommended\)$/i, '');
    const m = this.store.model();
    if (!m) return 'default';
    return m.replace(/^claude-/, '').replace(/-\d{8}$/, '').replace(/\[1m\]$/, '');
  }

  onContextMenu(event: MouseEvent): void {
    event.preventDefault();
    const target = event.target as HTMLElement | null;
    const selection = selectionText();
    const copy = (text: string, what = 'text') => void this.clipboard.copy(text, what);
    const items: MenuItem[] = [
      {
        label: 'Copy',
        icon: 'copy',
        shortcut: 'Ctrl+C',
        disabled: !selection,
        onClick: () => copy(selection, 'selection'),
      },
    ];
    // A fenced code block under the pointer: copy just that.
    const pre = target?.closest<HTMLElement>('pre');
    if (pre) items.push({ label: 'Copy code block', onClick: () => copy(pre.textContent ?? '', 'code block') });
    // The enclosing block, by id, so copies use the source text (markdown,
    // tool output) rather than whatever the DOM rendered it into.
    const blockId = target?.closest<HTMLElement>('[data-block-id]')?.dataset['blockId'];
    const block = blockId ? this.store.blocks().find((b) => b.id === blockId) : undefined;
    if (block?.kind === 'text') {
      items.push({ label: 'Copy message as Markdown', onClick: () => copy(block.text, 'message') });
    } else if (block?.kind === 'user') {
      items.push({ label: 'Copy message', onClick: () => copy(block.text, 'message') });
    } else if (block?.kind === 'think') {
      items.push({ label: 'Copy thinking', onClick: () => copy(block.text, 'thinking') });
    } else if (block?.kind === 'tool') {
      items.push({
        label: 'Copy output',
        disabled: !block.output,
        onClick: () => copy(block.output, 'output'),
      });
      items.push({ label: 'Copy command', onClick: () => copy(block.display, 'command') });
    } else if (block?.kind === 'permission') {
      items.push({ label: 'Copy command', onClick: () => copy(block.display, 'command') });
    } else if (block?.kind === 'error') {
      items.push({ label: 'Copy error', onClick: () => copy(block.text, 'error') });
    }
    items.push({ divider: true });
    items.push({
      label: 'Select all',
      shortcut: 'Ctrl+A',
      onClick: () => selectContents(this.bodyEl().nativeElement),
    });
    this.menu.open(event.clientX, event.clientY, items);
  }

  /** Toggle the model picker popover (chip click or context-bar right-click). */
  openModelMenu(event: MouseEvent): void {
    event.preventDefault();
    this.pickerOpen.update((open) => !open);
  }

  // ---- question cards -------------------------------------------------------

  readonly OTHER = OTHER;

  private draftOf(requestId: string): QuestionDraft {
    return this.qDrafts().get(requestId) ?? { picks: {}, other: {} };
  }

  private setDraft(requestId: string, draft: QuestionDraft): void {
    const next = new Map(this.qDrafts());
    next.set(requestId, draft);
    this.qDrafts.set(next);
  }

  isPicked(requestId: string, question: string, label: string): boolean {
    return (this.draftOf(requestId).picks[question] ?? []).includes(label);
  }

  /** Radio semantics for single-select, checkbox for multiSelect. */
  togglePick(requestId: string, q: ClaudeQuestion, label: string): void {
    const d = this.draftOf(requestId);
    const have = d.picks[q.question] ?? [];
    const picks = q.multiSelect
      ? have.includes(label)
        ? have.filter((l) => l !== label)
        : [...have, label]
      : [label];
    this.setDraft(requestId, { ...d, picks: { ...d.picks, [q.question]: picks } });
  }

  setOther(requestId: string, question: string, text: string): void {
    const d = this.draftOf(requestId);
    this.setDraft(requestId, { ...d, other: { ...d.other, [question]: text } });
  }

  otherText(requestId: string, question: string): string {
    return this.draftOf(requestId).other[question] ?? '';
  }

  /** The answer one question would submit now — '' when incomplete. */
  private answerFor(requestId: string, q: ClaudeQuestion): string {
    const d = this.draftOf(requestId);
    const picks = d.picks[q.question] ?? [];
    const labels = picks.filter((l) => l !== OTHER);
    if (picks.includes(OTHER)) {
      const text = (d.other[q.question] ?? '').trim();
      if (!text) return '';
      labels.push(text);
    }
    return labels.join(', ');
  }

  canSubmit(b: QuestionBlock): boolean {
    return b.questions.every((q) => this.answerFor(b.requestId, q) !== '');
  }

  submitQuestions(b: QuestionBlock): void {
    if (!this.canSubmit(b)) return;
    const choices: Record<string, string> = {};
    for (const q of b.questions) choices[q.question] = this.answerFor(b.requestId, q);
    this.store.answerQuestion(b.requestId, choices);
  }

  dismissQuestions(b: QuestionBlock): void {
    this.store.dismissQuestion(b.requestId);
  }

  /** A settled card with no choices was dismissed (or replayed stale). */
  isDismissed(b: QuestionBlock): boolean {
    return b.choices !== null && Object.keys(b.choices).length === 0;
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

/**
 * Give every fenced block a header strip: the language tag marked left on
 * the <code> element, and a Copy control. Only sanitizer-safe markup (span,
 * class, role, tabindex, title) so it survives [innerHTML].
 */
export function wrapCodeBlocks(html: string): string {
  return html.replace(
    /<pre><code(?: class="language-([^"]*)")?>/g,
    (_m, lang: string | undefined) =>
      '<div class="code-wrap"><div class="code-hd">' +
      `<span class="code-lang">${lang ?? ''}</span>` +
      '<span class="code-copy" role="button" tabindex="0" title="Copy code">Copy</span>' +
      `</div><pre><code${lang ? ` class="language-${lang}"` : ''}>`,
  ).replaceAll('</code></pre>', '</code></pre></div>');
}
