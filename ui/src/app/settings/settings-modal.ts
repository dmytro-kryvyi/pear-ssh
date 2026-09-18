import { Component, inject, output, signal } from '@angular/core';
import { ACCENTS, Settings, type Accent } from '../settings';
import { PearIcon } from '../icons/icon';
import { RemoteLink } from '../remote/link';

export type SettingsSection =
  | 'general'
  | 'files'
  | 'transfers'
  | 'terminal'
  | 'monitor'
  | 'claude'
  | 'keyboard';

const SECTIONS: { id: SettingsSection; label: string; icon: string }[] = [
  { id: 'general', label: 'General', icon: 'settings' },
  { id: 'files', label: 'File browser', icon: 'folder' },
  { id: 'transfers', label: 'Transfers', icon: 'swap' },
  { id: 'terminal', label: 'Terminal', icon: 'terminal' },
  { id: 'monitor', label: 'Monitoring', icon: 'cpu' },
  { id: 'claude', label: 'Claude Code', icon: 'sparkle' },
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
  readonly link = inject(RemoteLink);

  passwordAuth(): boolean {
    return this.link.remote?.hello()?.features['passwordAuth'] === true;
  }

  /** boot.js (served by pear-server) reads ?ui= and remembers it per device. */
  switchUi(to: 'mobile' | 'auto'): void {
    location.assign(to === 'mobile' ? '/m/?ui=mobile' : '/?ui=auto');
  }

  async signOut(): Promise<void> {
    await fetch('/api/logout', { method: 'POST' });
    location.assign('/login');
  }

  readonly sections = SECTIONS;
  readonly shortcuts = SHORTCUTS;
  readonly section = signal<SettingsSection>('general');

  readonly accents = Object.entries(ACCENTS).map(([key, value]) => ({
    key: key as Accent,
    color: value.main,
  }));

  /** Close on true backdrop presses only. A method call (not a boolean
   *  expression) — a binding that evaluates to `false` makes Angular call
   *  preventDefault(), which on mousedown blocks native input focus. */
  onBackdrop(event: MouseEvent): void {
    if (event.target === event.currentTarget) this.closed.emit();
  }

  sectionLabel(): string {
    return SECTIONS.find((s) => s.id === this.section())!.label;
  }

  claudeModeHint(): string {
    return this.settings.claudeMode() === 'chat'
      ? 'Rendered conversation: cards for commands, approvals, and questions.'
      : 'The claude CLI in a plain terminal — full TUI, slash commands and all.';
  }

  termPlacementHint(): string {
    switch (this.settings.termPlacement()) {
      case 'per-host':
        return 'Every connected host keeps its own shell in the bottom dock; switch freely, and navigating a pane never hijacks the terminal.';
      case 'in-pane':
        return 'No bottom dock — open a terminal inside any pane with the ⌗ button in its tab strip.';
      default:
        return 'One terminal docked at the bottom, following the focused pane.';
    }
  }
}
