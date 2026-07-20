import { Injectable, inject, signal } from '@angular/core';
import type { OrchAction, Orchestration } from '@pear/core';
import { Pear } from '../pear';

export interface OrchState {
  status: 'detecting' | 'ready' | 'none' | 'error';
  data?: Orchestration;
  error?: string;
}

/**
 * Per-host orchestration state. Discovery runs in the background when a host
 * connects; the panel is only shown once the host is confirmed to actually
 * run Docker / Swarm / Proxmox ('none' keeps it hidden).
 */
@Injectable({ providedIn: 'root' })
export class OrchStore {
  private readonly pear = inject(Pear);

  readonly states = signal<Readonly<Record<string, OrchState>>>({});

  private set(hostId: string, state: OrchState): void {
    this.states.update((all) => ({ ...all, [hostId]: state }));
  }

  /** Kick off (or re-run) discovery for a freshly connected host. */
  async discover(hostId: string): Promise<void> {
    if (this.states()[hostId]?.status === 'detecting') return;
    this.set(hostId, { status: 'detecting' });
    await this.fetch(hostId);
  }

  /** Refetch state for a host whose discovery already completed. */
  async refresh(hostId: string): Promise<void> {
    const current = this.states()[hostId];
    if (!current || current.status === 'detecting') return;
    await this.fetch(hostId, current.data);
  }

  /**
   * Run an action. Streaming actions resolve with the command to type into
   * the terminal; state-changing ones refetch after letting the engine settle.
   */
  async action(hostId: string, action: OrchAction): Promise<string | undefined> {
    const result = await this.pear.api.orch.action(hostId, action);
    if (result.terminalCommand) return result.terminalCommand;
    await new Promise((resolve) => setTimeout(resolve, 700));
    await this.refresh(hostId);
    return undefined;
  }

  clear(hostId: string): void {
    this.states.update((all) => {
      const { [hostId]: _removed, ...rest } = all;
      return rest;
    });
  }

  private async fetch(hostId: string, previous?: Orchestration): Promise<void> {
    try {
      const data = await this.pear.api.orch.get(hostId);
      const empty = !data.docker && !data.swarm && !data.proxmox;
      this.set(hostId, empty ? { status: 'none' } : { status: 'ready', data });
    } catch (err) {
      // Keep the last good data visible next to the error, if there was any
      this.set(hostId, { status: 'error', error: cleanIpcError(err), data: previous });
    }
  }
}

function cleanIpcError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}
