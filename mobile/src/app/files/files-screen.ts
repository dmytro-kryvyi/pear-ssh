import { Component, DestroyRef, computed, effect, inject, output, signal } from '@angular/core';
import type { FileEntry, TransferJobSnapshot } from '@pear/core';
import { PEAR_BACKEND } from '../backend';
import { PmHeader, PmIconBtn } from '../chrome/chrome';
import { PmIcon } from '../icons/icon';
import type { MobileTransfersConfig } from '../native/backend';
import { PearSession } from '../state/session';
import { fmtBytes, fmtMtime } from '../util/fmt';

/** Files screen — breadcrumb + listing; tapping a file opens the viewer sheet. */
@Component({
  selector: 'pm-files-screen',
  imports: [PmHeader, PmIconBtn, PmIcon],
  templateUrl: './files-screen.html',
  styleUrl: './files-screen.scss',
})
export class PmFilesScreen {
  readonly hostTap = output<void>();

  protected readonly session = inject(PearSession);
  private readonly backend = inject(PEAR_BACKEND);

  protected readonly entries = signal<FileEntry[]>([]);
  protected readonly error = signal('');
  /** A listing is in flight for the current host + path. */
  protected readonly loading = signal(false);
  protected readonly skeletonRows = [58, 40, 66, 34, 50, 44];
  /** Transfer jobs still worth showing (running, or terminal until dismissed). */
  protected readonly jobs = signal<TransferJobSnapshot[]>([]);

  protected readonly parts = computed(() => {
    const p = this.session.path();
    return p === '/' ? [] : p.split('/').filter(Boolean);
  });
  protected readonly sorted = computed(() =>
    [...this.entries()].sort((a, b) =>
      a.kind !== b.kind ? (a.kind === 'dir' ? -1 : 1) : a.name.localeCompare(b.name),
    ),
  );
  protected readonly dirCount = computed(() => this.sorted().filter((e) => e.kind === 'dir').length);
  protected readonly fileCount = computed(() => this.sorted().length - this.dirCount());

  constructor() {
    effect(() => {
      const hostId = this.session.activeHostId();
      const path = this.session.path();
      if (!hostId) return;
      void this.load(hostId, path);
    });
    const offUpdate = this.backend.transfers.onUpdate((job) => {
      this.jobs.update((list) => {
        const i = list.findIndex((j) => j.id === job.id);
        return i >= 0 ? [...list.slice(0, i), job, ...list.slice(i + 1)] : [...list, job];
      });
      // A finished upload into the open directory should show up right away.
      if (job.status === 'done') {
        const hostId = this.session.activeHostId();
        if (hostId) void this.load(hostId, this.session.path());
      }
    });
    inject(DestroyRef).onDestroy(offUpdate);
  }

  private async load(hostId: string, path: string): Promise<void> {
    const current = (): boolean =>
      this.session.activeHostId() === hostId && this.session.path() === path;
    this.loading.set(true);
    try {
      const listing = await this.backend.fs.list(hostId, path);
      if (current()) {
        this.entries.set(listing.entries);
        this.error.set('');
      }
    } catch (err) {
      // Same staleness guard as the success path — a slow failure from a
      // directory the user already left must not clobber the current view.
      if (current()) {
        this.entries.set([]);
        this.error.set(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (current()) this.loading.set(false);
    }
  }

  protected crumb(i: number): string {
    return '/' + this.parts().slice(0, i + 1).join('/');
  }
  protected goUp(): void {
    if (this.session.path() === '/') return;
    this.session.navigate('/' + this.parts().slice(0, -1).join('/'));
  }
  protected open(e: FileEntry): void {
    const base = this.session.path() === '/' ? '' : this.session.path();
    const full = `${base}/${e.name}`;
    if (e.kind === 'dir') this.session.navigate(full);
    else this.session.openFile.set(full);
  }

  // ---- transfers -----------------------------------------------------------

  /** SAF picker → upload into the open directory (native backend only). */
  protected async upload(): Promise<void> {
    const hostId = this.session.activeHostId();
    if (!hostId) return;
    const backend = this.backend as typeof this.backend & Partial<MobileTransfersConfig>;
    if (!backend.pickAndUpload) {
      this.error.set('Uploads need the Android app');
      return;
    }
    try {
      await backend.pickAndUpload(hostId, this.session.path());
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
    }
  }

  /** Queue a copy of one entry into the device's Downloads collection. */
  protected download(e: FileEntry, ev: Event): void {
    ev.stopPropagation();
    const hostId = this.session.activeHostId();
    if (!hostId) return;
    this.backend.transfers
      .download(hostId, this.session.path(), [e.name], 'rename', false)
      .catch((err: unknown) => {
        this.error.set(err instanceof Error ? err.message : String(err));
      });
  }

  protected cancelJob(id: string): void {
    this.backend.transfers.cancel(id);
  }
  protected dismissJob(id: string): void {
    this.jobs.update((list) => list.filter((j) => j.id !== id));
    this.backend.transfers.clearFinished();
  }
  protected jobActive(j: TransferJobSnapshot): boolean {
    return j.status === 'running' || j.status === 'queued';
  }
  protected pct(j: TransferJobSnapshot): number {
    return j.bytesTotal > 0 ? Math.round((j.bytesDone / j.bytesTotal) * 100) : 0;
  }

  protected readonly fmtBytes = fmtBytes;
  protected readonly fmtMtime = fmtMtime;
}
