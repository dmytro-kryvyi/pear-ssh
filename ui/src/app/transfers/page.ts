import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import type { TransferJobSnapshot } from '@pear/core';
import { PearIcon } from '../icons/icon';
import { Settings } from '../settings';
import { fmtBytes, fmtRate, fmtSeconds } from './format';
import { TransfersStore } from './store';

type Filter = 'all' | 'active' | 'done' | 'failed';

/** The full transfers view, as a workspace tab: every job of the session in
 *  a table with bytes, speed, ETA and per-row Cancel / Remove. */
@Component({
  selector: 'pear-transfers-page',
  imports: [PearIcon],
  templateUrl: './page.html',
  styleUrl: './page.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TransfersPage {
  readonly store = inject(TransfersStore);
  readonly settings = inject(Settings);

  readonly filter = signal<Filter>('all');
  readonly filters: { key: Filter; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'active', label: 'Active' },
    { key: 'done', label: 'Done' },
    { key: 'failed', label: 'Failed' },
  ];
  readonly parallelChoices = [1, 2, 3, 6];

  readonly shown = computed<TransferJobSnapshot[]>(() => {
    const all = this.store.newestFirst();
    switch (this.filter()) {
      case 'active':
        return all.filter((j) => j.status === 'queued' || j.status === 'running');
      case 'done':
        return all.filter((j) => j.status === 'done');
      case 'failed':
        return all.filter((j) => j.status === 'error' || j.status === 'canceled');
      default:
        return all;
    }
  });

  count(key: Filter): number {
    switch (key) {
      case 'active':
        return this.store.activeCount();
      case 'done':
        return this.store.finished().length - this.store.failed().length;
      case 'failed':
        return this.store.failed().length;
      default:
        return this.store.list().length;
    }
  }

  pct(job: TransferJobSnapshot): number {
    return Math.round(this.store.progress(job) * 100);
  }

  bytesText(job: TransferJobSnapshot): string {
    const units = this.settings.sizeUnits();
    if (!job.bytesTotal && job.status !== 'done') return '—';
    if (job.status === 'running') {
      return `${fmtBytes(job.bytesDone, units)} / ${fmtBytes(job.bytesTotal, units)}`;
    }
    return fmtBytes(job.bytesTotal, units);
  }

  speedText(job: TransferJobSnapshot): string {
    return job.status === 'running' && job.bytesPerSec ? fmtRate(job.bytesPerSec, this.settings.sizeUnits()) : '—';
  }

  etaText(job: TransferJobSnapshot): string {
    return job.status === 'running' ? fmtSeconds(job.etaSec) || '—' : '—';
  }

  filesText(job: TransferJobSnapshot): string {
    if (!job.fileCount || job.fileCount <= 1) return '';
    return job.status === 'running' && job.fileIndex
      ? `${job.fileIndex}/${job.fileCount} files`
      : `${job.fileCount} files`;
  }

  tone(job: TransferJobSnapshot): 'ok' | 'warn' | 'err' | 'off' {
    switch (job.status) {
      case 'done':
        return 'ok';
      case 'error':
        return 'err';
      case 'canceled':
        return 'off';
      case 'running':
        return this.store.isCancelling(job) ? 'warn' : 'ok';
      default:
        return 'off';
    }
  }

  icon(job: TransferJobSnapshot): string {
    const dir = this.store.direction(job);
    return dir === 'download' ? 'download' : dir === 'upload' ? 'upload' : 'swap';
  }
}
