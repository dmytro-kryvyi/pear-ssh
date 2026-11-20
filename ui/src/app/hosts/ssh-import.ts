import { Component, computed, inject, output, signal } from '@angular/core';
import type { SshConfigEntry } from '@pear/core';
import { Pear } from '../pear';
import { HostCatalog } from '../hosts';
import { PearIcon } from '../icons/icon';
import { SshConfigImporter } from './ssh-config-importer';
import { Clipboard } from '../clipboard';
import { ContextMenuService } from '../menu/context-menu';
import { copyItem } from '../menu/menu-items';

interface ImportRow {
  entry: SshConfigEntry;
  checked: boolean;
  /** Why the row can't be imported, or null when it can. */
  blocked: 'exists' | null;
  /** Jump chain summary ("via a → b"), or null when the entry dials direct. */
  via: string | null;
}

/** Picker over ~/.ssh/config Host entries: check the ones to add as hosts. */
@Component({
  selector: 'pear-ssh-import',
  imports: [PearIcon],
  templateUrl: './ssh-import.html',
  styleUrl: './ssh-import.scss',
})
export class SshImport {
  private readonly pear = inject(Pear);
  private readonly catalog = inject(HostCatalog);
  private readonly importer = inject(SshConfigImporter);
  private readonly clipboard = inject(Clipboard);
  private readonly menu = inject(ContextMenuService);

  onRowMenu(event: MouseEvent, row: ImportRow): void {
    event.preventDefault();
    event.stopPropagation();
    const setAll = (checked: boolean) =>
      this.rows.update((rows) => rows.map((r) => (r.blocked ? r : { ...r, checked })));
    this.menu.open(event.clientX, event.clientY, [
      { label: row.checked ? 'Uncheck' : 'Check', icon: 'check', disabled: !!row.blocked, onClick: () => this.toggle(row) },
      { label: 'Check all', onClick: () => setAll(true) },
      { label: 'Uncheck all', onClick: () => setAll(false) },
      { divider: true },
      copyItem('Copy alias', row.entry.alias, this.clipboard),
      copyItem('Copy target', this.target(row.entry), this.clipboard),
      copyItem('Copy key path', row.entry.identityFile, this.clipboard, 'key path'),
      copyItem('Copy ProxyJump', row.entry.proxyJump, this.clipboard, 'ProxyJump'),
    ]);
  }

  readonly closed = output<void>();

  readonly rows = signal<ImportRow[]>([]);
  readonly loading = signal(true);
  readonly importing = signal(false);
  readonly error = signal<string | null>(null);

  readonly checkedCount = computed(() => this.rows().filter((r) => r.checked).length);

  constructor() {
    void this.load();
  }

  private entries: SshConfigEntry[] = [];

  private async load(): Promise<void> {
    this.entries = await this.pear.api.hosts.sshConfigEntries();
    const hosts = this.catalog.all();
    this.rows.set(
      this.entries.map((entry) => {
        const blocked: ImportRow['blocked'] = this.importer.existingFor(entry, hosts)
          ? 'exists'
          : null;
        const hops = this.importer.hopsOf(entry);
        const via = hops.length ? 'via ' + hops.map((h) => h.host).join(' → ') : null;
        return { entry, blocked, via, checked: blocked === null };
      }),
    );
    this.loading.set(false);
  }

  /** Close on true backdrop presses only. A method call (not a boolean
   *  expression) — a binding that evaluates to `false` makes Angular call
   *  preventDefault(), which on mousedown blocks native input focus. */
  onBackdrop(event: MouseEvent): void {
    if (event.target === event.currentTarget) this.closed.emit();
  }

  toggle(row: ImportRow): void {
    if (row.blocked) return;
    this.rows.update((rows) =>
      rows.map((r) => (r === row ? { ...r, checked: !r.checked } : r)),
    );
  }

  target(entry: SshConfigEntry): string {
    return `${entry.user ?? '?'}@${entry.host}${entry.port && entry.port !== 22 ? ':' + entry.port : ''}`;
  }

  keyName(entry: SshConfigEntry): string {
    return entry.identityFile?.split('/').pop() ?? '';
  }

  /** Jump hosts a checked, not-yet-added entry needs: created alongside it. */
  async import(): Promise<void> {
    if (this.importing()) return;
    this.importing.set(true);
    this.error.set(null);
    const items = this.rows()
      .filter((r) => r.checked)
      .map((r) => ({ entry: r.entry }));
    const { failed } = await this.importer.importEntries(items, this.entries);
    await this.catalog.refresh();
    this.importing.set(false);
    if (failed.length) {
      this.error.set(failed.map((f) => `${f.alias}: ${f.error}`).join('; '));
    } else {
      this.closed.emit();
    }
  }
}
