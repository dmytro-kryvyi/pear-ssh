import { Component, computed, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { HostColor, HostGroup } from '@pear/core';
import { HOST_COLORS, HostCatalog } from '../hosts';
import { HostGroups } from './groups';
import { Settings } from '../settings';
import { PearSwatches } from './forms';
import { PearIcon } from '../icons/icon';

const ICON_OPTIONS: { v: HostGroup['icon']; l: string }[] = [
  { v: 'layers', l: 'Stack' },
  { v: 'server', l: 'Rack' },
  { v: 'cpu', l: 'Chip' },
  { v: 'lightning', l: 'Bolt' },
  { v: 'docker', l: 'Whale' },
];

/** Editor for one host group ("workspace"): identity plus member hosts. */
@Component({
  selector: 'pear-workspace-editor',
  imports: [FormsModule, PearIcon, PearSwatches],
  templateUrl: './workspace-editor.html',
  styleUrl: './workspace-editor.scss',
})
export class WorkspaceEditor {
  private readonly settings = inject(Settings);
  readonly catalog = inject(HostCatalog);
  readonly groups = inject(HostGroups);

  /** null = create a new workspace. */
  readonly group = input.required<HostGroup | null>();

  readonly closed = output<void>();
  readonly saved = output<HostGroup>();
  readonly editHost = output<string>();

  readonly iconOptions = ICON_OPTIONS;
  readonly filter = signal('');
  readonly hostIds = signal<string[]>([]);
  readonly saving = signal(false);

  name = '';
  color: HostColor = 'teal';
  icon: HostGroup['icon'] = 'layers';
  desc = '';

  ngOnInit(): void {
    const g = this.group();
    if (g) {
      this.name = g.name;
      this.color = g.color;
      this.icon = g.icon;
      this.desc = g.desc ?? '';
      this.hostIds.set([...g.hostIds]);
    }
  }

  /** Close on true backdrop presses only. A method call (not a boolean
   *  expression) — a binding that evaluates to `false` makes Angular call
   *  preventDefault(), which on mousedown blocks native input focus. */
  onBackdrop(event: MouseEvent): void {
    if (event.target === event.currentTarget) this.closed.emit();
  }

  readonly isNew = computed(() => this.group() === null);

  /** Persisted root hosts only — sub-hosts follow their root implicitly. */
  readonly candidates = computed(() => {
    const q = this.filter().trim().toLowerCase();
    const roots = this.catalog.roots().filter((h) => this.catalog.hosts().some((p) => p.id === h.id));
    return q ? roots.filter((h) => this.catalog.matches(h, q)) : roots;
  });

  colorOf(key: HostColor): string {
    return HOST_COLORS[key];
  }

  toggle(hostId: string): void {
    this.hostIds.update((ids) =>
      ids.includes(hostId) ? ids.filter((id) => id !== hostId) : [...ids, hostId],
    );
  }

  async save(): Promise<void> {
    if (this.saving()) return;
    this.saving.set(true);
    try {
      const saved = await this.groups.upsert({
        ...(this.group() ? { id: this.group()!.id } : {}),
        name: this.name.trim() || 'Untitled workspace',
        color: this.color,
        icon: this.icon,
        desc: this.desc.trim() || undefined,
        hostIds: this.hostIds(),
      });
      this.settings.activeGroup.set(saved.id);
      this.saved.emit(saved);
    } finally {
      this.saving.set(false);
    }
  }

  async remove(): Promise<void> {
    const g = this.group();
    if (!g) return;
    await this.groups.remove(g.id);
    if (this.settings.activeGroup() === g.id) this.settings.activeGroup.set('all');
    this.closed.emit();
  }
}
