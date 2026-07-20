import { Injectable, computed, effect, inject, signal } from '@angular/core';
import type { TransferJobSnapshot } from '@pear/core';
import { Pear } from '../pear';
import { Settings } from '../settings';
import { HostCatalog } from '../hosts';
import { FsStore } from '../workspace/fs-store';

const DONE_LINGER_MS = 4000;

/** Mirror of the main-process transfer queue, fed by transfer:update events. */
@Injectable({ providedIn: 'root' })
export class TransfersStore {
  private readonly pear = inject(Pear);
  private readonly settings = inject(Settings);
  private readonly catalog = inject(HostCatalog);
  private readonly fsStore = inject(FsStore);

  private readonly jobs = signal<Record<string, TransferJobSnapshot>>({});
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  readonly list = computed(() => Object.values(this.jobs()));
  readonly activeCount = computed(
    () => this.list().filter((j) => j.status === 'queued' || j.status === 'running').length,
  );
  readonly hasFinished = computed(() =>
    this.list().some((j) => j.status !== 'queued' && j.status !== 'running'),
  );

  constructor() {
    if (!this.pear.available) return;
    void this.pear.api.transfers.list().then((jobs) => {
      this.jobs.update((all) => {
        const next = { ...all };
        for (const job of jobs) next[job.id] = next[job.id] ?? job;
        return next;
      });
    });
    this.pear.api.transfers.onUpdate((job) => this.apply(job));
    effect(() => this.pear.api.transfers.setMaxParallel(this.settings.maxParallel()));
  }

  private apply(job: TransferJobSnapshot): void {
    const previous = this.jobs()[job.id];
    this.jobs.update((all) => ({ ...all, [job.id]: job }));
    if (job.status === 'done' && previous?.status !== 'done') {
      // The files landed — anyone looking at the affected dirs sees them.
      if (job.dest.hostId) this.fsStore.invalidate(job.dest.hostId, job.dest.dir);
      if (job.op === 'move' && job.src.hostId) {
        this.fsStore.invalidate(job.src.hostId, job.src.dir);
      }
      this.timers.set(
        job.id,
        setTimeout(() => this.drop(job.id), DONE_LINGER_MS),
      );
    }
  }

  private drop(id: string): void {
    this.timers.delete(id);
    this.jobs.update((all) => {
      const next = { ...all };
      delete next[id];
      return next;
    });
  }

  cancel(id: string): void {
    this.pear.api.transfers.cancel(id);
  }

  clearFinished(): void {
    this.pear.api.transfers.clearFinished();
    for (const job of this.list()) {
      if (job.status !== 'queued' && job.status !== 'running') this.drop(job.id);
    }
  }

  /** Overall fraction 0..1 — two-stage jobs average their stages. */
  progress(job: TransferJobSnapshot): number {
    if (job.status === 'done') return 1;
    if (!job.bytesTotal) return 0;
    const stageFraction = Math.min(1, job.bytesDone / job.bytesTotal);
    return job.stages === 2 ? (job.stage + stageFraction) / 2 : stageFraction;
  }

  fromName(job: TransferJobSnapshot): string {
    return this.catalog.nameOf(job.src.hostId);
  }

  toName(job: TransferJobSnapshot): string {
    return this.catalog.nameOf(job.dest.hostId);
  }

  stageLabel(job: TransferJobSnapshot): string {
    switch (job.status) {
      case 'queued':
        return 'Queued';
      case 'done':
        return job.op === 'move' ? 'Moved' : 'Transferred';
      case 'error':
        return job.error ?? 'Failed';
      case 'canceled':
        return 'Canceled';
      default:
        return job.stage === 0 && job.dest.hostId !== null && job.src.hostId !== null
          ? `Downloading from ${this.fromName(job)}`
          : job.dest.hostId === null
            ? `Downloading from ${this.fromName(job)}`
            : `Uploading to ${this.toName(job)}`;
    }
  }
}
