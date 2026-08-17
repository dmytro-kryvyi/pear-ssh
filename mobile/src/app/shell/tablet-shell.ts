import { Component, computed, effect, inject, signal } from '@angular/core';
import type { HostConfig } from '@pear/core';
import { ORCH_ICON, ORCH_TAB, PmWsGlyph } from '../chrome/chrome';
import { PmClaudeScreen } from '../claude/claude-screen';
import { PmHostEditor } from '../editors/host-editor';
import { PmWorkspaceEditor } from '../editors/workspace-editor';
import { PmFileEditor } from '../files/file-editor';
import { PmFilesScreen } from '../files/files-screen';
import { PmHostRow } from '../hosts/host-row';
import { PmIcon } from '../icons/icon';
import { PmOrchScreen } from '../orch/orch-screen';
import { PearSession } from '../state/session';
import { PmTerminalScreen } from '../terminal/terminal-screen';

type TabletView = 'files' | 'orch' | 'claude';

/** Deep-link/dev entry: #view=claude opens that view on boot. */
function initialView(): TabletView {
  const m = /view=(\w+)/.exec(location.hash);
  const v = m?.[1] as TabletView | undefined;
  return v && ['files', 'orch', 'claude'].includes(v) ? v : 'files';
}

/**
 * Tablet shell — persistent workspace/host rail beside a working pane, with an
 * optional terminal split (design src-tablet/app.jsx). Reuses the phone screens.
 */
@Component({
  selector: 'pm-tablet-shell',
  imports: [
    PmIcon,
    PmWsGlyph,
    PmHostRow,
    PmFilesScreen,
    PmFileEditor,
    PmOrchScreen,
    PmTerminalScreen,
    PmClaudeScreen,
    PmHostEditor,
    PmWorkspaceEditor,
  ],
  templateUrl: './tablet-shell.html',
  styleUrl: './tablet-shell.scss',
})
export class PmTabletShell {
  protected readonly session = inject(PearSession);
  protected readonly view = signal<TabletView>(initialView());
  protected readonly split = signal(true);
  protected readonly query = signal('');
  protected readonly dragId = signal<string | null>(null);
  protected readonly overWs = signal<string | null>(null);

  constructor() {
    // Logs/console actions type into the terminal — make sure the split
    // showing it is open.
    effect(() => {
      if (this.session.shellPing() > 0) this.split.set(true);
    });
  }

  protected readonly list = computed(() => {
    const q = this.query().trim().toLowerCase();
    const pool = q ? this.session.hosts() : this.session.wsHosts();
    if (!q) return pool;
    return pool.filter(
      (h) =>
        h.name.toLowerCase().includes(q) ||
        h.host.toLowerCase().includes(q) ||
        (h.aliases ?? []).some((a) => a.toLowerCase().includes(q)),
    );
  });

  protected readonly views = computed(() => {
    const kind = this.session.host()?.kind ?? 'docker';
    return [
      { id: 'files' as const, label: 'Files', icon: 'folder' },
      { id: 'orch' as const, label: ORCH_TAB[kind] ?? 'Stack', icon: ORCH_ICON[kind] ?? 'docker' },
      { id: 'claude' as const, label: 'Claude', icon: 'sparkle' },
    ];
  });

  protected connect(h: HostConfig): void {
    this.session.connect(h);
  }
  protected editHost(h: HostConfig): void {
    this.session.editHost.set(structuredClone(h));
  }
  protected editActiveHost(): void {
    const h = this.session.host();
    if (h) this.editHost(h);
  }
  protected editWs(id: string): void {
    const ws = this.session.groups().find((w) => w.id === id);
    if (ws) this.session.editWs.set(structuredClone(ws));
  }

  protected onDragOver(event: DragEvent, wsId: string): void {
    if (!this.dragId()) return;
    event.preventDefault();
    this.overWs.set(wsId);
  }

  protected drop(wsId: string): void {
    const hostId = this.dragId();
    if (hostId) void this.session.addToWorkspace(hostId, wsId);
    this.dragId.set(null);
    this.overWs.set(null);
  }
}
