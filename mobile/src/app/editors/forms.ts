import { Component, input, output, signal } from '@angular/core';
import type { HostColor } from '@pear/core';
import { PmIcon } from '../icons/icon';
import { WS_COLORS } from '../util/fmt';

// Touch form atoms shared by the host and workspace editors
// (design src-mobile/editors.jsx).

@Component({
  selector: 'pm-chips',
  imports: [PmIcon],
  template: `
    <div class="wrap">
      @for (t of items(); track t) {
        <span class="m-chip" [class.ui]="!mono()">
          {{ t }}
          <button (click)="remove(t)"><pm-icon name="close" [size]="10" /></button>
        </span>
      }
      <input
        [value]="draft()"
        (input)="draft.set($any($event.target).value)"
        (blur)="add()"
        (keydown.enter)="$event.preventDefault(); add()"
        [placeholder]="placeholder()"
      />
    </div>
  `,
  styles: `
    .wrap { display: flex; flex-wrap: wrap; gap: 7px; }
    .m-chip.ui { font-family: var(--ui); }
    .m-chip button {
      width: 22px; height: 22px; border-radius: 999px;
      display: grid; place-items: center;
      background: var(--bg-4); color: var(--fg-2);
    }
    input {
      width: 132px; min-height: 34px; padding: 6px 11px;
      border-radius: 999px; font-size: 12.5px;
      background: var(--bg-2); border: 1px solid var(--border-soft);
      font-family: var(--mono); color: var(--fg-0);
    }
  `,
})
export class PmChips {
  readonly items = input.required<string[]>();
  readonly placeholder = input('add');
  readonly mono = input(true);
  readonly itemsChange = output<string[]>();

  protected readonly draft = signal('');

  protected add(): void {
    const v = this.draft().trim();
    if (v && !this.items().includes(v)) this.itemsChange.emit([...this.items(), v]);
    this.draft.set('');
  }
  protected remove(t: string): void {
    this.itemsChange.emit(this.items().filter((x) => x !== t));
  }
}

@Component({
  selector: 'pm-colors',
  template: `
    <div class="wrap">
      @for (c of colors; track c) {
        <button [class.on]="c === value()" [style.background]="palette[c]" (click)="valueChange.emit(c)"></button>
      }
    </div>
  `,
  styles: `
    .wrap { display: flex; gap: 10px; flex-wrap: wrap; }
    button {
      width: 34px; height: 34px; border-radius: 999px;
      border: 3px solid transparent;
      &.on { border-color: var(--bg-1); box-shadow: 0 0 0 2px var(--fg-0); }
    }
  `,
})
export class PmColors {
  readonly value = input<HostColor>('teal');
  readonly valueChange = output<HostColor>();
  protected readonly palette = WS_COLORS;
  protected readonly colors = Object.keys(WS_COLORS) as HostColor[];
}

@Component({
  selector: 'pm-check-row',
  imports: [PmIcon],
  template: `
    <button class="row" [class.on]="on()" (click)="tap.emit()">
      <span class="box">
        @if (on()) {
          <pm-icon name="check" [size]="13" />
        }
      </span>
      <ng-content select="[slot=glyph]" />
      <div class="body">
        <div class="title">{{ title() }}</div>
        @if (meta()) {
          <div class="meta">{{ meta() }}</div>
        }
      </div>
      <ng-content select="[slot=right]" />
    </button>
  `,
  styles: `
    .row {
      display: flex; align-items: center; gap: 11px;
      width: 100%; text-align: left; min-height: 54px; padding: 10px 13px;
      border-radius: 13px; margin-bottom: 7px;
      background: var(--bg-2); border: 1px solid var(--border-soft);
      &.on { background: var(--accent-soft); border-color: var(--accent-line); }
    }
    .box {
      width: 22px; height: 22px; border-radius: 7px; flex-shrink: 0;
      display: grid; place-items: center;
      border: 1.5px solid var(--border); color: oklch(0.16 0.02 190);
      .on & { background: var(--accent); border-color: var(--accent); }
    }
    .body { min-width: 0; flex: 1; }
    .title { font-size: 14.5px; font-weight: 600; }
    .meta {
      font-size: 12px; color: var(--fg-3); margin-top: 2px;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
  `,
})
export class PmCheckRow {
  readonly on = input.required<boolean>();
  readonly title = input.required<string>();
  readonly meta = input('');
  readonly tap = output<void>();
}
