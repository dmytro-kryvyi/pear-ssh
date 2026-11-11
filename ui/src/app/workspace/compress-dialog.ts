import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  archiveKind,
  archiveStem,
  availableFormats,
  defaultFormat,
  type ArchiveFormat,
  type FormatChoice,
} from '@pear/core';
import { PearIcon } from '../icons/icon';
import { HostCatalog } from '../hosts';
import { FileOps } from './ops';

/** Name + format for a new archive of the selection; Create queues the op. */
@Component({
  selector: 'pear-compress-dialog',
  imports: [FormsModule, PearIcon],
  templateUrl: './compress-dialog.html',
  styleUrl: './compress-dialog.scss',
  host: { '(document:keydown.escape)': 'closed.emit()' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CompressDialog {
  readonly req = input.required<{ hostId: string; dir: string; names: string[] }>();
  readonly closed = output<void>();

  private readonly ops = inject(FileOps);
  private readonly catalog = inject(HostCatalog);

  readonly formats = signal<FormatChoice[] | null>(null);
  readonly format = signal<ArchiveFormat | null>(null);
  readonly name = signal('');
  readonly busy = signal(false);

  readonly hostName = computed(() => this.catalog.nameOf(this.req().hostId));
  readonly ext = computed(() => this.formats()?.find((f) => f.format === this.format())?.ext ?? '');
  readonly fullName = computed(() => `${this.name().trim()}.${this.ext()}`);
  readonly valid = computed(() => {
    const n = this.name().trim();
    return !!this.format() && n.length > 0 && !n.includes('/') && n !== '.' && n !== '..';
  });
  readonly itemsText = computed(() => {
    const { names } = this.req();
    return names.length === 1 ? names[0] : `${names.length} items`;
  });

  constructor() {
    effect(() => {
      const r = this.req();
      untracked(() => {
        const single = r.names.length === 1 ? r.names[0] : null;
        let stem = single ?? r.dir.replace(/\/+$/, '').split('/').pop() ?? 'archive';
        if (single) {
          const kind = archiveKind(single);
          stem = kind ? archiveStem(single, kind) : single.replace(/\.[^.]+$/, '') || single;
        }
        this.name.set(stem || 'archive');
        void this.ops.loadTools(r.hostId).then((tools) => {
          this.formats.set(availableFormats(tools));
          this.format.set(defaultFormat(tools));
        });
      });
    });
  }

  onBackdrop(event: MouseEvent): void {
    if (event.target === event.currentTarget) this.closed.emit();
  }

  async create(): Promise<void> {
    const format = this.format();
    if (!this.valid() || !format || this.busy()) return;
    const { hostId, dir, names } = this.req();
    this.busy.set(true);
    try {
      await this.ops.compress(hostId, dir, names, this.fullName(), format);
    } finally {
      this.busy.set(false);
    }
    this.closed.emit();
  }
}
