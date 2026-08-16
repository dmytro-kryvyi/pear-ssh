import { Component, input, output, signal } from '@angular/core';
import type { HostColor } from '@pear/core';
import { HOST_COLORS } from '../hosts';
import { PearIcon } from '../icons/icon';

/** Editable list of short strings (aliases, tags) as removable chips. */
@Component({
  selector: 'pear-chips',
  imports: [PearIcon],
  template: `
    <div class="chips">
      @for (item of items(); track item) {
        <span class="chip" [class.ui-font]="!mono()">
          {{ item }}
          <button type="button" (click)="remove(item)" title="Remove">
            <pear-icon name="close" [size]="9" />
          </button>
        </span>
      }
      <input
        [value]="draft()"
        [placeholder]="placeholder()"
        spellcheck="false"
        (input)="draft.set(input.value)"
        (keydown)="onKey($event)"
        (blur)="commit()"
        #input
      />
    </div>
  `,
  styles: `
    .chips { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
    .chip {
      display: flex; align-items: center; gap: 5px;
      padding: 3px 4px 3px 8px; border-radius: 999px;
      background: var(--bg-2); border: 1px solid var(--border-soft);
      font-family: var(--mono); font-size: 11.5px; color: var(--fg-1);
    }
    .chip.ui-font { font-family: inherit; }
    .chip button { display: flex; padding: 2px; border-radius: 999px; color: var(--fg-3); }
    .chip button:hover { color: var(--err); }
    input {
      width: 148px; padding: 5px 8px;
      background: var(--bg-2); border: 1px solid var(--border-soft); border-radius: 6px;
      font-family: var(--mono); font-size: 12px; color: var(--fg-0);
    }
    input::placeholder { color: var(--fg-3); }
  `,
})
export class PearChips {
  readonly items = input.required<string[]>();
  readonly placeholder = input('add');
  readonly mono = input(true);
  readonly changed = output<string[]>();

  readonly draft = signal('');

  onKey(event: KeyboardEvent): void {
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault();
      this.commit();
    } else if (event.key === 'Backspace' && !this.draft() && this.items().length) {
      this.changed.emit(this.items().slice(0, -1));
    }
  }

  commit(): void {
    const value = this.draft().trim().replace(/,+$/, '');
    if (!value) return;
    if (!this.items().includes(value)) this.changed.emit([...this.items(), value]);
    this.draft.set('');
  }

  remove(item: string): void {
    this.changed.emit(this.items().filter((x) => x !== item));
  }
}

/** Segmented single-choice control, matching the settings modal's look. */
@Component({
  selector: 'pear-seg',
  template: `
    <div class="seg-row">
      @for (o of options(); track o.v) {
        <button type="button" class="seg" [class.active]="value() === o.v" (click)="changed.emit(o.v)">
          {{ o.l }}
        </button>
      }
    </div>
  `,
  styles: `
    .seg-row {
      display: inline-flex; gap: 3px; padding: 3px;
      background: var(--bg-2); border: 1px solid var(--border-soft); border-radius: 8px;
    }
    .seg { padding: 5px 11px; border-radius: 6px; font-size: 12px; color: var(--fg-2); white-space: nowrap; cursor: pointer; }
    .seg:hover { color: var(--fg-0); }
    .seg.active { background: var(--bg-4); color: var(--fg-0); }
  `,
})
export class PearSeg {
  readonly options = input.required<{ v: string; l: string }[]>();
  readonly value = input<string | null>(null);
  readonly changed = output<string>();
}

/** Named color palette swatches for hosts and workspaces. */
@Component({
  selector: 'pear-swatches',
  template: `
    <div class="swatches">
      @for (c of colors; track c.key) {
        <button
          type="button"
          class="swatch"
          [class.active]="value() === c.key"
          [style.background]="c.color"
          [title]="c.key"
          (click)="changed.emit(c.key)"
        ></button>
      }
    </div>
  `,
  styles: `
    .swatches { display: flex; gap: 8px; }
    .swatch { width: 20px; height: 20px; border-radius: 999px; border: 2px solid transparent; cursor: pointer; }
    .swatch.active { border-color: var(--fg-0); box-shadow: 0 0 0 1px var(--fg-0); }
  `,
})
export class PearSwatches {
  readonly value = input<HostColor | null>(null);
  readonly changed = output<HostColor>();

  readonly colors = (Object.keys(HOST_COLORS) as HostColor[]).map((key) => ({
    key,
    color: HOST_COLORS[key],
  }));
}
