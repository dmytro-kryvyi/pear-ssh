import { Component, DestroyRef, ElementRef, computed, inject, output } from '@angular/core';
import type { ClaudeModelInfo } from '@pear/core';
import { PearIcon } from '../icons/icon';
import { Settings } from '../settings';
import { ClaudeChatStore } from './chat-store';

/** Shown only when the CLI can't be asked for its list. Aliases, not ids,
 *  so every CLI version resolves them to its own current models. */
export const FALLBACK_MODELS: ClaudeModelInfo[] = [
  { value: 'default', displayName: 'Default', description: "the CLI's default" },
  { value: 'opus', displayName: 'Opus' },
  { value: 'sonnet', displayName: 'Sonnet' },
  { value: 'haiku', displayName: 'Haiku' },
  { value: 'fable', displayName: 'Fable' },
];

export interface ModelRow {
  info: ClaudeModelInfo;
  /** Display name, disambiguated with the version when the CLI lists two
   *  entries under the same name ("Fable 5.1" / "Fable 5"). */
  label: string;
  /** Right-hand hint: the resolved model, or the CLI version a disabled
   *  entry needs. */
  hint: string;
  selected: boolean;
}

/** 'claude-fable-5-1[1m]' → '5.1'; '' when the id carries no version. */
function versionOf(resolved: string | undefined): string {
  const m = /-(\d+)(?:-(\d+))?(?:-\d{8})?(?:\[1m\])?$/.exec(resolved ?? '');
  return m ? (m[2] ? `${m[1]}.${m[2]}` : m[1]) : '';
}

/** 'claude-opus-5[1m]' → 'opus-5 · 1M'. */
function shortId(resolved: string | undefined): string {
  if (!resolved) return '';
  const oneM = resolved.includes('[1m]');
  return (
    resolved.replace(/\[1m\]$/, '').replace(/^claude-/, '').replace(/-\d{8}$/, '') +
    (oneM ? ' · 1M' : '')
  );
}

export function toRows(models: ClaudeModelInfo[], current: string): ModelRow[] {
  const counts = new Map<string, number>();
  for (const m of models) counts.set(m.displayName, (counts.get(m.displayName) ?? 0) + 1);
  return models.map((info) => {
    const dup = (counts.get(info.displayName) ?? 0) > 1;
    const version = versionOf(info.resolvedModel);
    const label = dup && version && !info.displayName.includes(version)
      ? `${info.displayName} ${version}`
      : info.displayName;
    let hint = shortId(info.resolvedModel);
    if (info.disabled) {
      const need = /update to ([\d.]+)\+?/i.exec(info.description ?? '');
      hint = need ? `needs CLI ${need[1]}` : 'unavailable';
    }
    return { info, label, hint, selected: info.value === current };
  });
}

/**
 * The model picker popover for the chat's context bar: the installed CLI's
 * own list (name, blurb, resolved model), the current choice ticked, and
 * entries the CLI disables shown with the version they need.
 */
@Component({
  selector: 'pear-model-picker',
  imports: [PearIcon],
  templateUrl: './model-picker.html',
  styleUrl: './model-picker.scss',
})
export class ModelPicker {
  readonly store = inject(ClaudeChatStore);
  private readonly settings = inject(Settings);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  readonly closed = output<void>();

  readonly rows = computed(() => {
    const current = this.settings.claudeModel() || 'default';
    return toRows(this.store.models() ?? FALLBACK_MODELS, current);
  });
  readonly loading = computed(() => this.store.models() === null && !this.store.modelsError());
  readonly fallback = computed(() => this.store.models() === null && !!this.store.modelsError());

  constructor() {
    void this.store.loadModels();
    const el = this.host.nativeElement;
    const down = (e: MouseEvent) => {
      // The chip that opened us is outside the popover; its own click
      // toggles, so only strangers close.
      if (!el.contains(e.target as Node) && !(e.target as HTMLElement).closest('.model-chip')) {
        this.closed.emit();
      }
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') this.closed.emit();
    };
    window.addEventListener('mousedown', down, true);
    window.addEventListener('keydown', key);
    inject(DestroyRef).onDestroy(() => {
      window.removeEventListener('mousedown', down, true);
      window.removeEventListener('keydown', key);
    });
  }

  pick(row: ModelRow): void {
    if (row.info.disabled) return;
    this.store.setModel(row.info.value === 'default' ? null : row.info.value);
    this.closed.emit();
  }

  refresh(): void {
    void this.store.loadModels(true);
  }
}
