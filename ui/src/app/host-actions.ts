import { Injectable, inject } from '@angular/core';
import type { HostConfig } from '@pear/core';
import { Pear } from './pear';
import { HostCatalog } from './hosts';
import { TermTabs } from './terminal/tabs';
import { Workspace } from './workspace/workspace';
import type { OrchTermCommand, PromotedVm } from './orch/orchpanel';

/**
 * Reactions to orchestration events, shared by every place an orch view can
 * live (sidebar panel, orch pane tabs): stream commands go to the bottom
 * terminal, new sub-hosts / promoted VMs open as workspace tabs.
 */
@Injectable({ providedIn: 'root' })
export class HostActions {
  private readonly pear = inject(Pear);
  private readonly catalog = inject(HostCatalog);
  private readonly tabs = inject(TermTabs);
  private readonly ws = inject(Workspace);

  orchCommand(hostId: string, cmd: OrchTermCommand): void {
    this.tabs.openOrch(hostId, cmd.command, cmd.title);
  }

  /** A sub-host was registered by an orch view — open its files. */
  jumpedIn(config: HostConfig): void {
    this.catalog.subHosts.update((list) => [...list.filter((s) => s.id !== config.id), config]);
    this.ws.newTab(this.ws.focusedPane()?.id ?? null, config.id, '~');
  }

  /** A VM's IP was detected — create a real host and open it. */
  async promoted(vm: PromotedVm): Promise<void> {
    const saved = await this.pear.api.hosts.upsert({
      name: vm.name,
      host: vm.ip,
      user: 'root',
      port: 22,
      kind: 'plain',
      via: vm.viaId,
    });
    await this.catalog.refresh();
    this.ws.newTab(null, saved.id, '~');
  }
}
