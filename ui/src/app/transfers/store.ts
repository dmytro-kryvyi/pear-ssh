import { Injectable, computed, effect, inject, signal } from '@angular/core';
import type { TransferJobSnapshot } from '@pear/core';
import { Pear } from '../pear';
import { Settings } from '../settings';
import { HostCatalog } from '../hosts';
import { FsStore } from '../workspace/fs-store';
import { compactProgress, fmtBytes, fmtDuration } from './format';

/** How long a finished job stays in the toast before it drops to the tab only. */
const DONE_LINGER_MS = 4000;

export type TransferDirection = 'download' | 'upload' | 'relay';

export const isActive = (j: TransferJobSnapshot): boolean =>
  j.status === 'queued' || j.status === 'running';

/**
 * Mirror of the engine's transfer queue, fed by transfer:update events.
 *
 * Jobs stay here until the user clears them (the Transfers tab is the full
 * history for the session); the toast is a view over the same list that only
 * shows what is still worth a glance — active jobs, failures, and recent
 * successes for a few seconds — and can be dismissed until something new
 * happens.
 */
@Injectable({ providedIn: 'root' })
export class TransfersStore {
  private readonly pear = inject(Pear);
  private readonly settings = inject(Settings);
  private readonly catalog = inject(HostCatalog);
  private readonly fsStore = inject(FsStore);

  private readonly jobs = signal<Record<string, TransferJobSnapshot>>({});
  /** Done jobs whose toast linger expired. */
  private readonly hiddenFromToast = signal<ReadonlySet<string>>(new Set());
  /** Cancel clicked, engine not yet confirmed — the optimistic "Cancelling…". */
  private readonly cancelling = signal<ReadonlySet<string>>(new Set());
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  /** The user closed the toast; it comes back on the next new job or failure. */
  readonly toastDismissed = signal(false);

  readonly list = computed(() => Object.values(this.jobs()));
  /** Newest first — what every view renders. */
  readonly newestFirst = computed(() => [...this.list()].reverse());
  readonly active = computed(() => this.list().filter(isActive));
  readonly finished = computed(() => this.list().filter((j) => !isActive(j)));
  readonly failed = computed(() =>
    this.list().filter((j) => j.status === 'error' || j.status === 'canceled'),
  );
  readonly activeCount = computed(() => this.active().length);
  readonly hasFinished = computed(() => this.finished().length > 0);

  readonly toastList = computed(() => {
    const hidden = this.hiddenFromToast();
    return this.newestFirst().filter((j) => !hidden.has(j.id));
  });
  readonly toastVisible = computed(() => !this.toastDismissed() && this.toastList().length > 0);

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
    const newlyFailed = job.status === 'error' && previous?.status !== 'error';
    if (!previous || newlyFailed) {
      // Something worth a look: bring the toast back if it was dismissed.
      this.toastDismissed.set(false);
      this.unhide(job.id);
    }
    if (!isActive(job) && this.cancelling().has(job.id)) {
      this.cancelling.update((ids) => without(ids, job.id));
    }
    if (job.status === 'done' && previous?.status !== 'done') {
      // The files landed — anyone looking at the affected dirs sees them.
      if (job.dest.hostId) this.fsStore.invalidate(job.dest.hostId, job.dest.dir);
      if (job.op === 'move' && job.src.hostId) {
        this.fsStore.invalidate(job.src.hostId, job.src.dir);
      }
      this.timers.set(
        job.id,
        setTimeout(() => this.hide(job.id), DONE_LINGER_MS),
      );
    }
  }

  private hide(id: string): void {
    this.timers.delete(id);
    this.hiddenFromToast.update((ids) => new Set(ids).add(id));
  }

  private unhide(id: string): void {
    if (this.hiddenFromToast().has(id)) this.hiddenFromToast.update((ids) => without(ids, id));
  }

  private drop(id: string): void {
    const timer = this.timers.get(id);
    if (timer) clearTimeout(timer);
    this.timers.delete(id);
    this.jobs.update((all) => {
      const next = { ...all };
      delete next[id];
      return next;
    });
    this.hiddenFromToast.update((ids) => without(ids, id));
    this.cancelling.update((ids) => without(ids, id));
  }

  // ---- actions -------------------------------------------------------------

  cancel(id: string): void {
    const job = this.jobs()[id];
    if (!job || !isActive(job)) return;
    this.cancelling.update((ids) => new Set(ids).add(id));
    this.pear.api.transfers.cancel(id);
  }

  cancelAll(): void {
    for (const job of this.active()) this.cancel(job.id);
  }

  /** Forget one finished job (the engine's copy goes on the next clear). */
  remove(id: string): void {
    const job = this.jobs()[id];
    if (job && !isActive(job)) this.drop(id);
  }

  clearFinished(): void {
    this.pear.api.transfers.clearFinished();
    for (const job of this.finished()) this.drop(job.id);
  }

  dismissToast(): void {
    this.toastDismissed.set(true);
  }

  // ---- presentation --------------------------------------------------------

  isCancelling(job: TransferJobSnapshot): boolean {
    return isActive(job) && (this.cancelling().has(job.id) || !!job.cancelRequested);
  }

  /** Overall fraction 0..1 — two-stage jobs average their stages. */
  progress(job: TransferJobSnapshot): number {
    if (job.status === 'done') return 1;
    if (!job.bytesTotal) return 0;
    const stageFraction = Math.min(1, job.bytesDone / job.bytesTotal);
    return job.stages === 2 ? (job.stage + stageFraction) / 2 : stageFraction;
  }

  direction(job: TransferJobSnapshot): TransferDirection {
    if (job.dest.hostId === null) return 'download';
    if (job.src.hostId === null) return 'upload';
    return 'relay';
  }

  fromName(job: TransferJobSnapshot): string {
    return this.catalog.nameOf(job.src.hostId);
  }

  toName(job: TransferJobSnapshot): string {
    return this.catalog.nameOf(job.dest.hostId);
  }

  /** What the job is doing, in words — phase-aware while running. */
  statusText(job: TransferJobSnapshot): string {
    switch (job.status) {
      case 'queued':
        return this.isCancelling(job) ? 'Cancelling…' : 'Queued';
      case 'done':
        return job.op === 'move' ? 'Moved' : 'Transferred';
      case 'error':
        return 'Failed';
      case 'canceled':
        return 'Canceled';
    }
    if (this.isCancelling(job)) return 'Cancelling…';
    switch (job.phase) {
      case 'listing':
        return 'Listing files…';
      case 'verifying':
        return 'Verifying checksum…';
      case 'pushing':
        return 'Copying into container…';
      case 'pulling':
        return 'Copying out of container…';
      case 'finalizing':
        return 'Removing source…';
      default: {
        // Stage 0 of a relay and a plain download both pull from the source.
        const pulling = job.dest.hostId === null || (job.stages === 2 && job.stage === 0);
        return pulling ? `Downloading from ${this.fromName(job)}` : `Uploading to ${this.toName(job)}`;
      }
    }
  }

  /** Second line: live numbers while running, a summary once settled. */
  detailText(job: TransferJobSnapshot): string {
    const units = this.settings.sizeUnits();
    switch (job.status) {
      case 'running':
        return compactProgress(job, units);
      case 'done': {
        const took = fmtDuration(job);
        return `${fmtBytes(job.bytesTotal, units)}${took ? ` in ${took}` : ''}`;
      }
      case 'error':
        return job.error ?? '';
      default:
        return '';
    }
  }
}

function without(ids: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(ids);
  next.delete(id);
  return next;
}
