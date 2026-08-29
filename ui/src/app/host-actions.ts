import { Injectable, inject } from '@angular/core';
import type { HostConfig } from '@pear/core';
import { HostCatalog } from './hosts';
import { TermRouter } from './terminal/router';
import { Workspace } from './workspace/workspace';
import type { OrchTermCommand } from './orch/orchpanel';

/**
 * Reactions to orchestration events, shared by every place an orch view can
 * live (sidebar panel, orch pane tabs): stream commands go to the bottom
 * terminal, new sub-hosts open as workspace tabs.
 */
@Injectable({ providedIn: 'root' })
export class HostActions {
  private readonly catalog = inject(HostCatalog);
  private readonly router = inject(TermRouter);
  private readonly ws = inject(Workspace);

  orchCommand(hostId: string, cmd: OrchTermCommand): void {
    this.router.openOrch(hostId, cmd.command, cmd.title);
  }

  /** A sub-host was registered by an orch view — open its files. */
  jumpedIn(config: HostConfig): void {
    this.catalog.subHosts.update((list) => [...list.filter((s) => s.id !== config.id), config]);
    this.ws.newTab(this.ws.focusedPane()?.id ?? null, config.id, '~');
  }
}
