import { Component, computed, effect, inject, output, signal } from '@angular/core';
import type { FileEntry } from '@pear/core';
import { PEAR_BACKEND } from '../backend';
import { PmHeader, PmIconBtn } from '../chrome/chrome';
import { PmIcon } from '../icons/icon';
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
  }

  private async load(hostId: string, path: string): Promise<void> {
    try {
      const listing = await this.backend.fs.list(hostId, path);
      if (this.session.activeHostId() === hostId && this.session.path() === path) {
        this.entries.set(listing.entries);
        this.error.set('');
      }
    } catch (err) {
      this.entries.set([]);
      this.error.set(err instanceof Error ? err.message : String(err));
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

  protected readonly fmtBytes = fmtBytes;
  protected readonly fmtMtime = fmtMtime;
}
