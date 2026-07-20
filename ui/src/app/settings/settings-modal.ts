import { Component, inject, output, signal } from '@angular/core';
import { ACCENTS, Settings, type Accent } from '../settings';
import { PearIcon } from '../icons/icon';

export type SettingsSection = 'general' | 'files' | 'transfers' | 'terminal' | 'keyboard';

const SECTIONS: { id: SettingsSection; label: string; icon: string }[] = [
  { id: 'general', label: 'General', icon: 'settings' },
  { id: 'files', label: 'File browser', icon: 'folder' },
  { id: 'transfers', label: 'Transfers', icon: 'swap' },
  { id: 'terminal', label: 'Terminal', icon: 'terminal' },
  { id: 'keyboard', label: 'Keyboard', icon: 'activity' },
];

const SHORTCUTS: [string, string][] = [
  ['Open / enter folder', 'Enter / dbl-click'],
  ['Delete selection', 'Del'],
  ['Rename', 'F2'],
  ['Copy / Cut / Paste', 'Ctrl C / X / V'],
  ['Extend selection', 'Shift · Ctrl-click'],
];

/** App settings as a centered modal with a section nav. */
@Component({
  selector: 'pear-settings-modal',
  imports: [PearIcon],
  templateUrl: './settings-modal.html',
  styleUrl: './settings-modal.scss',
})
export class SettingsModal {
  readonly closed = output<void>();
  readonly settings = inject(Settings);

  readonly sections = SECTIONS;
  readonly shortcuts = SHORTCUTS;
  readonly section = signal<SettingsSection>('general');

  readonly accents = Object.entries(ACCENTS).map(([key, value]) => ({
    key: key as Accent,
    color: value.main,
  }));

  sectionLabel(): string {
    return SECTIONS.find((s) => s.id === this.section())!.label;
  }

  termPlacementHint(): string {
    switch (this.settings.termPlacement()) {
      case 'per-host':
        return 'One tab per connected host at the bottom; switch freely. (Coming soon — shared is active today.)';
      case 'in-pane':
        return 'No bottom dock — terminals open inside panes. (Coming soon — shared is active today.)';
      default:
        return 'One terminal docked at the bottom, following the focused pane.';
    }
  }
}
