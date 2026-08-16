import { Component, computed, inject, output, signal } from '@angular/core';
import type { HostConfig } from '@pear/core';
import { PmSeg } from '../chrome/chrome';
import { PearSession } from '../state/session';
import { PmHostRow } from './host-row';

/** Host switcher body inside a bottom sheet — scoped to the active workspace. */
@Component({
  selector: 'pm-host-picker',
  imports: [PmSeg, PmHostRow],
  template: `
    <div class="head">
      <span class="sec-label" style="margin: 0">Switch host</span>
      @if (session.activeWs(); as ws) {
        <div class="seg-wrap">
          <pm-seg
            [options]="[{ v: 'ws', l: ws.name }, { v: 'all', l: 'All' }]"
            [value]="scope()"
            (valueChange)="scope.set($event)"
          />
        </div>
      }
    </div>
    <div class="list noscroll">
      @for (h of list(); track h.id) {
        <pm-host-row
          [h]="h"
          [active]="h.id === session.activeHostId()"
          (tap)="connect.emit($event)"
          (edit)="edit.emit($event)"
        />
      }
    </div>
  `,
  styles: `
    .head { display: flex; align-items: center; gap: 10px; padding: 14px 16px 10px; }
    .seg-wrap { margin-left: auto; width: 190px; }
    .list {
      overflow-y: auto; padding: 0 16px 24px;
      display: flex; flex-direction: column; gap: 8px;
    }
  `,
})
export class PmHostPicker {
  readonly connect = output<HostConfig>();
  readonly edit = output<HostConfig>();

  protected readonly session = inject(PearSession);
  protected readonly scope = signal<'ws' | 'all' | string>('ws');

  protected readonly list = computed(() => {
    const ws = this.session.activeWs();
    return this.scope() === 'ws' && ws ? this.session.wsHosts() : this.session.hosts();
  });
}
