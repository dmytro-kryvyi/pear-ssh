import { Component, computed, inject, input, output, signal } from '@angular/core';
import type { DockerDiskRow, HostConfig } from '@pear/core';
import { PearIcon } from '../icons/icon';
import { OrchStore, type DockerDfState } from '../orch/store';
import { bytes } from '../orch/format';

const TYPE_LABEL: Record<DockerDiskRow['type'], string> = {
  containers: 'Containers',
  images: 'Images',
  volumes: 'Volumes',
  buildCache: 'Build cache',
};

/** Anything under this isn't worth a prune. */
const MIN_RECLAIM = 1024 * 1024;

/**
 * Collapsed `docker system df` strip on the docker page. Fetches lazily on
 * first expand (df walks the image store — seconds on a busy host) and the
 * result is cached in OrchStore so it survives tab switches.
 */
@Component({
  selector: 'pear-docker-disk',
  imports: [PearIcon],
  templateUrl: './docker-disk.html',
  styleUrl: './docker-disk.scss',
})
export class DockerDisk {
  readonly host = input.required<HostConfig>();
  readonly prune = output<void>();

  private readonly store = inject(OrchStore);
  readonly open = signal(false);

  readonly df = computed<DockerDfState | undefined>(
    () => this.store.dockerDf()[this.host().id],
  );
  readonly rows = computed(() => this.df()?.rows ?? []);
  readonly total = computed(() => this.rows().reduce((n, r) => n + (r.size ?? 0), 0));
  readonly reclaimable = computed(() =>
    this.rows().reduce((n, r) => n + (r.reclaimable ?? 0), 0),
  );
  readonly canPrune = computed(() => this.reclaimable() >= MIN_RECLAIM);

  toggle(): void {
    this.open.update((v) => !v);
    const st = this.df();
    if (this.open() && !st?.rows && !st?.loading) this.refresh();
  }

  refresh(): void {
    void this.store.fetchDockerDf(this.host().id);
  }

  usedShare(r: DockerDiskRow): number {
    if (!r.size) return 0;
    return ((r.size - (r.reclaimable ?? 0)) / r.size) * 100;
  }

  label(r: DockerDiskRow): string {
    return TYPE_LABEL[r.type];
  }

  readonly bytes = bytes;
}
