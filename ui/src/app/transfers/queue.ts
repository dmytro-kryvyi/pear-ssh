import { Component, inject } from '@angular/core';
import type { TransferJobSnapshot } from '@pear/core';
import { PearIcon } from '../icons/icon';
import { TransfersStore } from './store';
import { Clipboard } from '../clipboard';
import { ContextMenuService } from '../menu/context-menu';
import { copyItem } from '../menu/menu-items';

/** Floating bottom-right card listing queued/running/finished transfers. */
@Component({
  selector: 'pear-transfer-queue',
  imports: [PearIcon],
  templateUrl: './queue.html',
  styleUrl: './queue.scss',
})
export class TransferQueue {
  readonly store = inject(TransfersStore);
  private readonly clipboard = inject(Clipboard);
  private readonly menu = inject(ContextMenuService);

  onJobMenu(event: MouseEvent, job: TransferJobSnapshot): void {
    event.preventDefault();
    const active = job.status === 'queued' || job.status === 'running';
    this.menu.open(event.clientX, event.clientY, [
      { label: 'Cancel', icon: 'close', disabled: !active, danger: active, onClick: () => this.store.cancel(job.id) },
      { divider: true },
      copyItem('Copy error', job.error, this.clipboard),
      copyItem('Copy name', job.label, this.clipboard),
      copyItem('Copy source path', job.src.dir, this.clipboard, 'path'),
      copyItem('Copy destination path', job.dest.dir, this.clipboard, 'path'),
      { divider: true },
      { label: 'Clear finished', onClick: () => this.store.clearFinished() },
    ]);
  }
}
