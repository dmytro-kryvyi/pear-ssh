import { Component, computed, effect, inject, input, signal } from '@angular/core';
import type { HostConfig, HostGroup } from '@pear/core';
import { PmHostDot, PmSeg, PmWsGlyph } from '../chrome/chrome';
import { PmIcon } from '../icons/icon';
import { PearSession } from '../state/session';
import { PmEditorShell, type EditorSection } from './editor-shell';
import { PmCheckRow, PmColors } from './forms';

const SECTIONS: EditorSection[] = [
  { id: 'about', label: 'Details', icon: 'pencil' },
  { id: 'hosts', label: 'Hosts', icon: 'server' },
];

/** Workspace (host group) editor — sheet on phone, modal on tablet. */
@Component({
  selector: 'pm-workspace-editor',
  imports: [PmEditorShell, PmSeg, PmColors, PmCheckRow, PmWsGlyph, PmHostDot, PmIcon],
  templateUrl: './workspace-editor.html',
  styleUrl: './workspace-editor.scss',
})
export class PmWorkspaceEditor {
  readonly workspace = input.required<HostGroup>();
  readonly wide = input(false);

  protected readonly session = inject(PearSession);
  protected readonly sections = SECTIONS;
  protected readonly section = signal('about');
  protected readonly query = signal('');
  protected readonly draft = signal<HostGroup | null>(null);

  protected readonly d = computed(() => this.draft() ?? this.workspace());
  protected readonly isNew = computed(() => !this.workspace().name);
  protected readonly list = computed(() => {
    const q = this.query().trim().toLowerCase();
    return this.session
      .hosts()
      .filter((h) => !q || h.name.toLowerCase().includes(q) || h.host.toLowerCase().includes(q));
  });

  constructor() {
    effect(() => {
      this.draft.set(structuredClone(this.workspace()));
      this.section.set('about');
      this.query.set('');
    });
  }

  protected set<K extends keyof HostGroup>(key: K, value: HostGroup[K]): void {
    this.draft.set({ ...this.d(), [key]: value });
  }

  protected toggleHost(h: HostConfig): void {
    const ids = this.d().hostIds;
    this.set('hostIds', ids.includes(h.id) ? ids.filter((x) => x !== h.id) : [...ids, h.id]);
  }

  protected editHost(h: HostConfig): void {
    this.session.editHost.set(structuredClone(h));
  }

  protected close(): void {
    this.session.editWs.set(null);
  }

  protected async save(): Promise<void> {
    const d = this.d();
    await this.session.saveWs({ ...d, name: d.name.trim() || 'Untitled workspace' });
  }

  protected async remove(): Promise<void> {
    await this.session.deleteWs(this.d().id);
  }
}
