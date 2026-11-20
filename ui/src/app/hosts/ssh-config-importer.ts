import { Injectable, inject } from '@angular/core';
import { parseProxyJump, type HostConfig, type ProxyJumpHop, type SshConfigEntry } from '@pear/core';
import { Pear } from '../pear';
import { HostCatalog } from '../hosts';

/** Fields the caller may force over an entry's own values. */
export interface ImportOverrides {
  name?: string;
  user?: string;
  port?: number;
  tags?: string[];
}

export interface ImportItem {
  entry: SshConfigEntry;
  overrides?: ImportOverrides;
}

export interface ImportResult {
  saved: HostConfig[];
  /** Aliases whose import threw, with the reason. */
  failed: { alias: string; error: string }[];
}

/** State shared across one batch: hosts created so far (by alias or literal
 *  hop key) and the aliases currently being resolved (cycle guard). */
interface Run {
  created: Map<string, HostConfig>;
  visiting: Set<string>;
  overrides: Map<string, ImportOverrides>;
  entries: SshConfigEntry[];
}

/**
 * Turns ~/.ssh/config entries into catalog hosts, ProxyJump included: every
 * hop of a chain becomes (or is matched to) a host of its own, and the
 * target is saved with `via` pointing at the last hop — which is exactly how
 * the session manager tunnels. Shared by the import picker and quick connect.
 */
@Injectable({ providedIn: 'root' })
export class SshConfigImporter {
  private readonly pear = inject(Pear);
  private readonly catalog = inject(HostCatalog);

  /** Decoded ProxyJump chain of an entry, outermost hop first. */
  hopsOf(entry: SshConfigEntry): ProxyJumpHop[] {
    return parseProxyJump(entry.proxyJump);
  }

  /** The catalog host an entry already describes, if any. */
  existingFor(entry: SshConfigEntry, hosts: HostConfig[] = this.catalog.all()): HostConfig | undefined {
    return hosts.find(
      (h) =>
        !h.local &&
        !h.parentId &&
        (h.aliases?.includes(entry.alias) ||
          (h.host === entry.host && h.user === (entry.user ?? h.user))),
    );
  }

  /** Import one entry (quick connect). Jump hosts are created as needed. */
  async importEntry(
    entry: SshConfigEntry,
    entries: SshConfigEntry[],
    overrides: ImportOverrides = {},
  ): Promise<HostConfig> {
    const run = this.newRun(entries, [{ entry, overrides }]);
    return this.createFromEntry(entry, null, run);
  }

  /**
   * Import a batch. An alias that another item jumps through is created
   * once, with its own overrides, whichever order the items come in. One
   * failure never aborts the rest.
   */
  async importEntries(items: ImportItem[], entries: SshConfigEntry[]): Promise<ImportResult> {
    const run = this.newRun(entries, items);
    const result: ImportResult = { saved: [], failed: [] };
    for (const { entry } of items) {
      try {
        const already = run.created.get(entry.alias);
        result.saved.push(already ?? (await this.createFromEntry(entry, null, run)));
      } catch (err) {
        result.failed.push({ alias: entry.alias, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return result;
  }

  private newRun(entries: SshConfigEntry[], items: ImportItem[]): Run {
    return {
      created: new Map(),
      visiting: new Set(),
      overrides: new Map(items.map((i) => [i.entry.alias, i.overrides ?? {}])),
      entries,
    };
  }

  /**
   * Save a host for an entry. `prevVia` is the id of the hop before this one
   * in an explicit chain (which overrides the entry's own ProxyJump, as the
   * command line does in OpenSSH); null means "use the entry's own chain".
   */
  private async createFromEntry(
    entry: SshConfigEntry,
    prevVia: string | null,
    run: Run,
    hop?: ProxyJumpHop,
  ): Promise<HostConfig> {
    if (run.visiting.has(entry.alias)) {
      throw new Error(`ProxyJump loops back to '${entry.alias}'`);
    }
    run.visiting.add(entry.alias);
    let via: string | undefined;
    try {
      via = prevVia ?? (await this.ensureChain(this.hopsOf(entry), run));
    } finally {
      run.visiting.delete(entry.alias);
    }
    const o = run.overrides.get(entry.alias) ?? {};
    const saved = await this.pear.api.hosts.upsert({
      name: o.name || entry.alias,
      host: entry.host,
      user: o.user ?? hop?.user ?? entry.user ?? 'root',
      port: o.port ?? hop?.port ?? entry.port ?? 22,
      aliases: [entry.alias],
      auth: entry.identityFile ? { method: 'key', privateKeyPath: entry.identityFile } : undefined,
      tags: o.tags?.length ? o.tags : undefined,
      kind: 'plain',
      via,
    });
    run.created.set(entry.alias, saved);
    return saved;
  }

  /** Make every hop reachable, in order; returns the last hop's id. */
  private async ensureChain(hops: ProxyJumpHop[], run: Run): Promise<string | undefined> {
    let prev: string | null = null;
    for (const hop of hops) prev = await this.ensureHop(hop, prev, run);
    return prev ?? undefined;
  }

  private async ensureHop(hop: ProxyJumpHop, prevVia: string | null, run: Run): Promise<string> {
    const entry = run.entries.find((e) => e.alias === hop.host);
    const known = [...this.catalog.all(), ...run.created.values()];
    if (entry) {
      const existing = run.created.get(entry.alias) ?? this.existingFor(entry, known);
      if (existing) return existing.id;
      return (await this.createFromEntry(entry, prevVia, run, hop)).id;
    }
    // Literal [user@]host[:port] with no Host block of its own.
    const key = `${hop.user ?? ''}@${hop.host}:${hop.port ?? ''}`;
    const created = run.created.get(key);
    if (created) return created.id;
    const existing = known.find(
      (h) =>
        !h.local &&
        !h.parentId &&
        h.host === hop.host &&
        (!hop.user || h.user === hop.user) &&
        (!hop.port || h.port === hop.port),
    );
    if (existing) return existing.id;
    const saved = await this.pear.api.hosts.upsert({
      name: hop.host,
      host: hop.host,
      user: hop.user ?? 'root',
      port: hop.port ?? 22,
      kind: 'plain',
      via: prevVia ?? undefined,
    });
    run.created.set(key, saved);
    return saved.id;
  }
}
