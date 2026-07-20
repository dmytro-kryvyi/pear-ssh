import { Injectable, inject, signal } from '@angular/core';
import { bestSuggestion, normalizeCommand, type HistoryEntry } from '@pear/core';
import { Pear } from '../pear';
import { Settings } from '../settings';

/**
 * Command history for inline suggestions.
 *
 * The whole entry list is held in the renderer: matching happens on every
 * keystroke and must not cross an IPC boundary. Writes go the other way,
 * fire-and-forget, and are mirrored locally so a command suggests itself
 * immediately rather than after the next reload.
 */
@Injectable({ providedIn: 'root' })
export class History {
  private readonly pear = inject(Pear);
  private readonly settings = inject(Settings);

  private entries: HistoryEntry[] = [];
  /** Hosts already scanned this session, so reconnects do not rescan. */
  private readonly scanned = new Set<string>();

  /** Bumped on every change, for anything that wants to render the history. */
  readonly revision = signal(0);

  constructor() {
    void this.load();
  }

  async load(): Promise<void> {
    if (!this.pear.available) return;
    this.entries = await this.pear.api.history.list();
    this.revision.update((r) => r + 1);
  }

  /** Synchronous: this is the hot path behind ghost text. */
  suggest(prefix: string, hostId: string): string | undefined {
    return bestSuggestion(this.entries, prefix, hostId);
  }

  record(hostId: string, raw: string): void {
    if (!this.pear.available) return;
    // Apply the same filter the store does, so the local copy cannot start
    // suggesting a command that was deliberately never written to disk.
    const command = normalizeCommand(raw);
    if (!command) return;
    this.pear.api.history.record(hostId, command);
    this.mirror(hostId, command);
  }

  /**
   * Scans the host's own shell history files, but only with the user's
   * consent — this reads files on their server, so it stays behind the
   * "scan remote shell history" setting and never runs on its own.
   */
  async importFromHost(hostId: string): Promise<void> {
    if (!this.pear.available) return;
    if (!this.settings.scanRemoteHistory()) return;
    if (this.scanned.has(hostId)) return;
    this.scanned.add(hostId);
    try {
      const { added } = await this.pear.api.history.importFromHost(hostId);
      if (added) await this.load();
    } catch {
      // A host with no readable history file is normal, not an error.
    }
  }

  async clear(hostId?: string): Promise<void> {
    if (!this.pear.available) return;
    await this.pear.api.history.clear(hostId);
    if (hostId) this.scanned.delete(hostId);
    await this.load();
  }

  /** Applies a normalized command to the local copy, matching HistoryStore. */
  private mirror(hostId: string, command: string): void {
    const existing = this.entries.find((e) => e.command === command);
    if (existing) {
      existing.count++;
      existing.lastUsed = Date.now();
      existing.imported = false;
      existing.hostIds = [hostId, ...existing.hostIds.filter((h) => h !== hostId)];
    } else {
      this.entries.push({
        command,
        hostIds: [hostId],
        count: 1,
        lastUsed: Date.now(),
        imported: false,
      });
    }
    this.revision.update((r) => r + 1);
  }
}
