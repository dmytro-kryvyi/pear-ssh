import { Component, computed, input, output } from '@angular/core';
import type { HostConfig, HostGroup, HostKind, HostStatus } from '@pear/core';
import { PmIcon } from '../icons/icon';
import { wsColor } from '../util/fmt';

// Shared mobile chrome — design src-mobile/chrome.jsx as small Angular atoms.

export const ORCH_TAB: Record<string, string> = {
  docker: 'Containers',
  swarm: 'Cluster',
  proxmox: 'Guests',
  plain: 'Stack',
};
export const ORCH_ICON: Record<string, string> = {
  docker: 'docker',
  swarm: 'layers',
  proxmox: 'server',
  plain: 'docker',
};

export type StateTone = 'ok' | 'warn' | 'err' | 'off';

@Component({
  selector: 'pm-host-dot',
  template: '',
  host: {
    '[style.width.px]': 'size()',
    '[style.height.px]': 'size()',
    '[style.background]': 'color()',
    '[style.boxShadow]': 'glow()',
  },
  styles: ':host { display: inline-block; border-radius: 999px; flex-shrink: 0; }',
})
export class PmHostDot {
  readonly status = input.required<HostStatus>();
  readonly size = input(8);
  readonly color = computed(() =>
    this.status() === 'online' ? 'var(--ok)' : this.status() === 'idle' ? 'var(--warn)' : 'var(--off)',
  );
  readonly glow = computed(() =>
    this.status() === 'online' ? '0 0 0 3px oklch(0.78 0.14 150 / 0.14)' : 'none',
  );
}

const TONE_BG: Record<StateTone, string> = {
  ok: 'var(--ok)',
  warn: 'var(--warn)',
  err: 'var(--err)',
  off: 'var(--off)',
};
const TONE_GLOW: Record<StateTone, string> = {
  ok: '0 0 0 3px oklch(0.78 0.14 150 / 0.16)',
  warn: '0 0 0 3px oklch(0.78 0.14 75 / 0.16)',
  err: '0 0 0 3px oklch(0.68 0.18 25 / 0.16)',
  off: 'none',
};

@Component({
  selector: 'pm-state-dot',
  template: '',
  host: {
    '[style.width.px]': 'size()',
    '[style.height.px]': 'size()',
    '[style.background]': 'TONE_BG[state()]',
    '[style.boxShadow]': 'TONE_GLOW[state()]',
  },
  styles: ':host { display: inline-block; border-radius: 999px; flex-shrink: 0; }',
})
export class PmStateDot {
  readonly state = input.required<StateTone>();
  readonly size = input(8);
  protected readonly TONE_BG = TONE_BG;
  protected readonly TONE_GLOW = TONE_GLOW;
}

@Component({
  selector: 'pm-icon-btn',
  imports: [PmIcon],
  template: `
    <button [class.accent]="accent()" [attr.title]="label()">
      <pm-icon [name]="icon()" [size]="iconSize()" />
      @if (badge()) {
        <span class="badge">{{ badge() }}</span>
      }
    </button>
  `,
  styles: `
    button {
      width: 40px; height: 40px; border-radius: 12px;
      display: grid; place-items: center; position: relative;
      color: var(--fg-1); background: var(--bg-2); border: 1px solid var(--border-soft);
      &.accent { color: var(--claude); background: var(--claude-soft); border-color: oklch(0.72 0.12 45 / 0.3); }
    }
    .badge {
      position: absolute; top: -3px; right: -3px; min-width: 15px; height: 15px; padding: 0 4px;
      border-radius: 999px; background: var(--claude); color: oklch(0.16 0.02 45);
      font-size: 9px; font-weight: 700; display: grid; place-items: center;
      border: 2px solid var(--bg-1);
    }
  `,
})
export class PmIconBtn {
  readonly icon = input.required<string>();
  readonly iconSize = input(18);
  readonly label = input('');
  readonly accent = input(false);
  readonly badge = input<string | number | null>(null);
}

@Component({
  selector: 'pm-seg',
  template: `
    <div class="seg">
      @for (o of options(); track o.v) {
        <button [class.on]="o.v === value()" (click)="valueChange.emit(o.v)">{{ o.l }}</button>
      }
    </div>
  `,
  styles: `
    .seg {
      display: flex; gap: 4px; background: var(--bg-2); border-radius: 12px; padding: 4px;
      border: 1px solid var(--border-soft);
    }
    button {
      flex: 1; min-height: 36px; border-radius: 9px; font-size: 13px; font-weight: 500;
      color: var(--fg-2);
      &.on { font-weight: 600; color: var(--fg-0); background: var(--bg-4); }
    }
  `,
})
export class PmSeg {
  readonly options = input.required<{ v: string; l: string }[]>();
  readonly value = input<string>('');
  readonly valueChange = output<string>();
}

@Component({
  selector: 'pm-header',
  imports: [PmIcon, PmHostDot],
  template: `
    <ng-content select="[slot=left]" />
    <div class="titles">
      <div class="title">{{ title() }}</div>
      @if (host(); as h) {
        <button class="host" (click)="hostTap.emit()" [disabled]="!tappable()">
          <pm-host-dot [status]="hostStatus()" [size]="7" />
          <span class="who">{{ h.user }}&#64;{{ h.name }}</span>
          @if (tappable()) {
            <pm-icon name="chevronDown" [size]="12" />
          }
        </button>
      } @else if (subtitle()) {
        <div class="sub">{{ subtitle() }}</div>
      }
    </div>
    <ng-content select="[slot=right]" />
  `,
  styles: `
    :host {
      flex-shrink: 0; padding: 10px 16px 12px;
      border-bottom: 1px solid var(--border-soft); background: var(--bg-1);
      display: flex; align-items: center; gap: 12px;
    }
    .titles { min-width: 0; flex: 1; }
    .title { font-size: 21px; font-weight: 700; letter-spacing: -0.02em; line-height: 1.1; }
    .host { display: flex; align-items: center; gap: 6px; margin-top: 4px; max-width: 100%; color: var(--fg-3); }
    .who {
      font-family: var(--mono); font-size: 12px; color: var(--fg-2);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .sub { font-size: 12.5px; color: var(--fg-2); margin-top: 3px; }
  `,
})
export class PmHeader {
  readonly title = input.required<string>();
  readonly subtitle = input('');
  readonly host = input<HostConfig | null>(null);
  readonly hostStatus = input<HostStatus>('unknown');
  readonly tappable = input(true);
  readonly hostTap = output<void>();
}

export type MobileTab = 'hosts' | 'files' | 'orch' | 'term' | 'claude';

@Component({
  selector: 'pm-tab-bar',
  imports: [PmIcon],
  template: `
    @for (t of tabs; track t.id) {
      <button
        [class.on]="tab() === t.id"
        [class.claude]="t.id === 'claude'"
        (click)="tabChange.emit(t.id)"
      >
        <pm-icon [name]="iconOf(t)" [size]="22" />
        <span>{{ labelOf(t) }}</span>
      </button>
    }
  `,
  styles: `
    :host {
      flex-shrink: 0; display: flex; align-items: stretch;
      padding: 8px 0 calc(10px + var(--safe-bottom));
      border-top: 1px solid var(--border);
      background: oklch(0.19 0.006 240 / 0.92); backdrop-filter: blur(12px);
    }
    button {
      flex: 1; display: flex; flex-direction: column; align-items: center; gap: 4px;
      color: var(--fg-3); padding-top: 4px; min-height: 46px;
      span { font-size: 10px; font-weight: 500; letter-spacing: 0.01em; }
      &.on { color: var(--accent); span { font-weight: 600; } }
      &.on.claude { color: var(--claude); }
    }
  `,
})
export class PmTabBar {
  readonly tab = input.required<MobileTab>();
  readonly kind = input<HostKind>('docker');
  readonly tabChange = output<MobileTab>();

  protected readonly tabs: { id: MobileTab; label: string | null; icon: string | null }[] = [
    { id: 'hosts', label: 'Hosts', icon: 'server' },
    { id: 'files', label: 'Files', icon: 'folder' },
    { id: 'orch', label: null, icon: null },
    { id: 'term', label: 'Shell', icon: 'terminal' },
    { id: 'claude', label: 'Claude', icon: 'sparkle' },
  ];
  protected iconOf(t: { id: MobileTab; icon: string | null }): string {
    return t.icon ?? ORCH_ICON[this.kind()] ?? 'docker';
  }
  protected labelOf(t: { id: MobileTab; label: string | null }): string {
    return t.label ?? ORCH_TAB[this.kind()] ?? 'Stack';
  }
}

@Component({
  selector: 'pm-sheet',
  template: `
    @if (open()) {
      <div class="wrap">
        <div class="scrim" (click)="closed.emit()"></div>
        <div class="panel" [style.maxHeight]="maxHeight()">
          <div class="grab"><span></span></div>
          <ng-content />
        </div>
      </div>
    }
  `,
  styles: `
    .wrap {
      position: absolute; inset: 0; z-index: 80;
      display: flex; flex-direction: column; justify-content: flex-end;
    }
    .scrim { position: absolute; inset: 0; background: oklch(0.08 0.004 240 / 0.55); animation: fadeIn 0.2s ease; }
    .panel {
      position: relative; background: var(--bg-1);
      border-top-left-radius: 24px; border-top-right-radius: 24px;
      border-top: 1px solid var(--border);
      display: flex; flex-direction: column;
      box-shadow: 0 -20px 50px oklch(0.05 0 0 / 0.5);
      animation: sheetUp 0.28s cubic-bezier(0.22, 1, 0.36, 1);
      padding-bottom: var(--safe-bottom);
    }
    .grab { display: flex; justify-content: center; padding-top: 10px; }
    .grab span { width: 38px; height: 5px; border-radius: 999px; background: var(--bg-4); }
  `,
})
export class PmSheet {
  readonly open = input.required<boolean>();
  readonly maxHeight = input('82%');
  readonly closed = output<void>();
}

@Component({
  selector: 'pm-full-sheet',
  template: '<ng-content />',
  styles: `
    :host {
      position: absolute; inset: 0; z-index: 70; background: var(--bg-1);
      display: flex; flex-direction: column;
      animation: sheetUp 0.3s cubic-bezier(0.22, 1, 0.36, 1);
    }
  `,
})
export class PmFullSheet {}

@Component({
  selector: 'pm-ws-glyph',
  imports: [PmIcon],
  template: '<pm-icon [name]="iconName()" [size]="size()" [style.color]="color()" />',
  styles: ':host { display: inline-flex; }',
})
export class PmWsGlyph {
  readonly ws = input.required<Pick<HostGroup, 'icon' | 'color'>>();
  readonly size = input(15);
  readonly iconName = computed(() => this.ws().icon || 'layers');
  readonly color = computed(() => wsColor(this.ws().color));
}
