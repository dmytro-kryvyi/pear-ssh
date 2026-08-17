import { Component, effect, inject, signal } from '@angular/core';
import type { HostConfig } from '@pear/core';
import { PmSheet, PmTabBar, type MobileTab } from '../chrome/chrome';
import { PmClaudeScreen } from '../claude/claude-screen';
import { PmHostEditor } from '../editors/host-editor';
import { PmWorkspaceEditor } from '../editors/workspace-editor';
import { PmFileEditor } from '../files/file-editor';
import { PmFilesScreen } from '../files/files-screen';
import { PmHostPicker } from '../hosts/host-picker';
import { PmHostsScreen } from '../hosts/hosts-screen';
import { PmOrchScreen } from '../orch/orch-screen';
import { PearSession } from '../state/session';
import { PmTerminalScreen } from '../terminal/terminal-screen';

/** Deep-link/dev entry: #tab=claude opens that tab on boot. */
function initialTab(): MobileTab {
  const m = /tab=(\w+)/.exec(location.hash);
  const t = m?.[1] as MobileTab | undefined;
  return t && ['hosts', 'files', 'orch', 'term', 'claude'].includes(t) ? t : 'files';
}

/** Phone shell — bottom tab bar, screen routing, sheets (design src-mobile/app.jsx). */
@Component({
  selector: 'pm-phone-shell',
  imports: [
    PmTabBar,
    PmSheet,
    PmHostsScreen,
    PmHostPicker,
    PmFilesScreen,
    PmFileEditor,
    PmOrchScreen,
    PmTerminalScreen,
    PmClaudeScreen,
    PmHostEditor,
    PmWorkspaceEditor,
  ],
  templateUrl: './phone-shell.html',
  styleUrl: './phone-shell.scss',
})
export class PmPhoneShell {
  protected readonly session = inject(PearSession);
  protected readonly tab = signal<MobileTab>(initialTab());
  protected readonly pickerOpen = signal(false);

  constructor() {
    // Logs/console actions type into the terminal — jump there so the
    // output is actually visible.
    effect(() => {
      if (this.session.shellPing() > 0) this.tab.set('term');
    });
  }

  protected connect(h: HostConfig): void {
    this.pickerOpen.set(false);
    this.session.connect(h);
    this.tab.set('files');
  }

  protected editFromPicker(h: HostConfig): void {
    this.pickerOpen.set(false);
    this.session.editHost.set(structuredClone(h));
  }
}
