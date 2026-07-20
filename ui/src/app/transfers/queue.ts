import { Component, inject } from '@angular/core';
import { PearIcon } from '../icons/icon';
import { TransfersStore } from './store';

/** Floating bottom-right card listing queued/running/finished transfers. */
@Component({
  selector: 'pear-transfer-queue',
  imports: [PearIcon],
  templateUrl: './queue.html',
  styleUrl: './queue.scss',
})
export class TransferQueue {
  readonly store = inject(TransfersStore);
}
