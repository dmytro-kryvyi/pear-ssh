import { Component, computed, inject, output, signal } from '@angular/core';
import type { SshConfigEntry } from '@pear/core';
import { Pear } from '../pear';
import { HostCatalog } from '../hosts';
import { PearIcon } from '../icons/icon';

interface ImportRow {
  entry: SshConfigEntry;
  checked: boolean;
  /** Why the row can't be imported, or null when it can. */
  blocked: 'exists' | 'proxyjump' | null;
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

  readonly closed = output<void>();

  readonly rows = signal<ImportRow[]>([]);
  readonly loading = signal(true);
  readonly importing = signal(false);
  readonly error = signal<string | null>(null);

  readonly checkedCount = computed(() => this.rows().filter((r) => r.checked).length);

  constructor() {
    void this.load();
  }

  private async load(): Promise<void> {
    const entries = await this.pear.api.hosts.sshConfigEntries();
    const hosts = this.catalog.all().filter((h) => !h.local);
    this.rows.set(
      entries.map((entry) => {
        const blocked: ImportRow['blocked'] = entry.proxyJump
          ? 'proxyjump'
          : hosts.some(
                (h) =>
                  h.aliases?.includes(entry.alias) ||
                  (h.host === entry.host && h.user === (entry.user ?? h.user)),
              )
            ? 'exists'
            : null;
        return { entry, blocked, checked: blocked === null };
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

  badge(row: ImportRow): string {
    return row.blocked === 'exists' ? 'already added' : 'ProxyJump';
  }

  async import(): Promise<void> {
    if (this.importing()) return;
    this.importing.set(true);
    this.error.set(null);
    const failed: string[] = [];
    for (const { entry } of this.rows().filter((r) => r.checked)) {
      try {
        await this.pear.api.hosts.upsert({
          name: entry.alias,
          host: entry.host,
          user: entry.user ?? 'root',
          port: entry.port ?? 22,
          aliases: [entry.alias],
          auth: entry.identityFile
            ? { method: 'key', privateKeyPath: entry.identityFile }
            : undefined,
          kind: 'plain',
        });
      } catch {
        failed.push(entry.alias);
      }
    }
    await this.catalog.refresh();
    this.importing.set(false);
    if (failed.length) this.error.set(`Failed: ${failed.join(', ')}`);
    else this.closed.emit();
  }
}
