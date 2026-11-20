import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import type { TransferJobSnapshot } from '@pear/core';
import { PearIcon } from '../icons/icon';
import { Workspace } from '../workspace/workspace';
import { TransfersStore } from './store';
import { Clipboard } from '../clipboard';
import { ContextMenuService } from '../menu/context-menu';
import { copyItem } from '../menu/menu-items';

/**
 * Floating bottom-right card: the notification side of transfers. Active
 * jobs, failures and just-finished ones, with Cancel per row. Closable — the
 * Transfers tab keeps everything, and the card comes back by itself when a
 * new job starts or one fails.
 */
@Component({
  selector: 'pear-transfer-queue',
  imports: [PearIcon],
  templateUrl: './queue.html',
  styleUrl: './queue.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TransferQueue {
  readonly store = inject(TransfersStore);
  private readonly ws = inject(Workspace);
  private readonly clipboard = inject(Clipboard);
  private readonly menu = inject(ContextMenuService);

  openTab(): void {
    this.ws.openTransfers();
  }

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
