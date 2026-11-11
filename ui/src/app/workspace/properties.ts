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
import { modeText, octalOf, parseOctal, type FileInfo } from '@pear/core';
import { PearIcon } from '../icons/icon';
import { Pear } from '../pear';
import { Settings } from '../settings';
import { HostCatalog } from '../hosts';
import { fmtBytes } from '../transfers/format';
import { FsStore } from './fs-store';
import { dirnameOf } from './workspace';

const PERM_MASK = 0o7777;

/**
 * File / folder properties: everything `stat` knows, a folder total on
 * demand, and an editor for mode (rwx grid + special bits + octal) and
 * owner/group that runs chmod/chown on the host.
 */
@Component({
  selector: 'pear-properties',
  imports: [FormsModule, PearIcon],
  templateUrl: './properties.html',
  styleUrl: './properties.scss',
  host: { '(document:keydown.escape)': 'closed.emit()' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PropertiesModal {
  readonly target = input.required<{ hostId: string; path: string }>();
  readonly closed = output<void>();

  private readonly pear = inject(Pear);
  private readonly settings = inject(Settings);
  private readonly catalog = inject(HostCatalog);
  private readonly fsStore = inject(FsStore);

  readonly info = signal<FileInfo | null>(null);
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  /** The deep (du + find) re-fetch for folders. */
  readonly computing = signal(false);

  // ---- editor state ----
  readonly bits = signal(0);
  readonly octal = signal('');
  readonly owner = signal('');
  readonly group = signal('');
  readonly recursive = signal(false);
  readonly applying = signal(false);
  readonly applyError = signal<string | null>(null);

  readonly rows = [
    { label: 'Owner', shift: 6 },
    { label: 'Group', shift: 3 },
    { label: 'Others', shift: 0 },
  ];
  readonly cols = [
    { label: 'Read', bit: 4 },
    { label: 'Write', bit: 2 },
    { label: 'Execute', bit: 1 },
  ];
  readonly special = [
    { label: 'Set UID', mask: 0o4000 },
    { label: 'Set GID', mask: 0o2000 },
    { label: 'Sticky', mask: 0o1000 },
  ];

  readonly hostName = computed(() => this.catalog.nameOf(this.target().hostId));
  readonly location = computed(() => dirnameOf(this.target().path));
  readonly kindText = computed(() => {
    const i = this.info();
    if (!i) return '';
    if (i.kind === 'dir') return 'Folder';
    if (i.kind === 'link') return 'Symbolic link';
    const fmt = i.mode & 0o170000;
    return fmt === 0o060000
      ? 'Block device'
      : fmt === 0o020000
        ? 'Character device'
        : fmt === 0o010000
          ? 'Named pipe'
          : fmt === 0o140000
            ? 'Socket'
            : 'File';
  });
  readonly sizeText = computed(() => {
    const i = this.info();
    if (!i) return '';
    const n = i.kind === 'dir' && i.dir ? i.dir.bytes : i.size;
    const human = fmtBytes(n, this.settings.sizeUnits());
    return n >= 1024 ? `${human} (${n.toLocaleString()} bytes)` : `${n.toLocaleString()} bytes`;
  });
  readonly dirSummary = computed(() => {
    const d = this.info()?.dir;
    if (!d) return '';
    const plural = (n: number, w: string) => `${n.toLocaleString()} ${w}${n === 1 ? '' : 's'}`;
    return `${plural(d.files, 'file')}, ${plural(d.dirs, 'folder')}`;
  });
  readonly previewText = computed(() => {
    const i = this.info();
    return i ? modeText((i.mode & ~PERM_MASK) | this.bits()) : '';
  });
  readonly octalValid = computed(() => parseOctal(this.octal()) !== null);
  readonly dirty = computed(() => {
    const i = this.info();
    if (!i) return false;
    return (
      this.bits() !== (i.mode & PERM_MASK) ||
      this.owner().trim() !== i.owner ||
      this.group().trim() !== i.group
    );
  });

  constructor() {
    effect(() => {
      this.target();
      untracked(() => void this.load(false));
    });
  }

  onBackdrop(event: MouseEvent): void {
    if (event.target === event.currentTarget) this.closed.emit();
  }

  octalText(info: FileInfo): string {
    return octalOf(info.mode);
  }

  fmtTime(ms: number): string {
    return ms ? new Date(ms).toLocaleString() : '—';
  }

  maskOf(shift: number, bit: number): number {
    return bit << shift;
  }

  has(mask: number): boolean {
    return (this.bits() & mask) !== 0;
  }

  toggle(mask: number): void {
    this.bits.update((b) => b ^ mask);
    this.octal.set(octalOf(this.bits()));
  }

  onOctal(text: string): void {
    this.octal.set(text);
    const parsed = parseOctal(text);
    if (parsed !== null) this.bits.set(parsed & PERM_MASK);
  }

  async load(deep: boolean): Promise<void> {
    const { hostId, path } = this.target();
    if (deep) this.computing.set(true);
    else this.loading.set(true);
    this.error.set(null);
    try {
      const info = await this.pear.api.fs.info(hostId, path, deep);
      this.info.set(info);
      if (!deep) this.resetEditor(info);
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.loading.set(false);
      this.computing.set(false);
    }
  }

  private resetEditor(info: FileInfo): void {
    this.bits.set(info.mode & PERM_MASK);
    this.octal.set(octalOf(info.mode));
    this.owner.set(info.owner);
    this.group.set(info.group);
    this.applyError.set(null);
  }

  revert(): void {
    const info = this.info();
    if (info) this.resetEditor(info);
  }

  async apply(): Promise<void> {
    const info = this.info();
    if (!info || !this.dirty() || this.applying()) return;
    const { hostId, path } = this.target();
    const change = {
      ...(this.bits() !== (info.mode & PERM_MASK) ? { mode: this.bits() } : {}),
      ...(this.owner().trim() !== info.owner ? { owner: this.owner().trim() } : {}),
      ...(this.group().trim() !== info.group ? { group: this.group().trim() } : {}),
      recursive: info.kind === 'dir' && this.recursive(),
    };
    this.applying.set(true);
    this.applyError.set(null);
    try {
      await this.pear.api.fs.setPerms(hostId, path, change);
      await this.load(false);
      this.fsStore.invalidate(hostId, dirnameOf(path));
      if (info.kind === 'dir') this.fsStore.invalidate(hostId, path);
    } catch (err) {
      this.applyError.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.applying.set(false);
    }
  }
}
