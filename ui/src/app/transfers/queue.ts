import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { PearIcon } from '../icons/icon';
import { Workspace } from '../workspace/workspace';
import { TransfersStore } from './store';

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

  openTab(): void {
    this.ws.openTransfers();
  }
}
