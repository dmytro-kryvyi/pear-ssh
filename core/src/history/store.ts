/**
 * Command history: what the user typed in Pear terminals, plus (optionally)
 * what was imported from the hosts' own shell history files.
 *
 * History is cross-host on purpose. The same `docker compose logs -f web` gets
 * typed on every box, so a command learned on one host is offered on all of
 * them — just ranked below the ones learned on the host you are actually on.
 */

/** One deduplicated command line. */
export interface HistoryEntry {
  command: string;
  /** Hosts this command has been seen on, most recent first. */
  hostIds: string[];
  /** How many times it has been run/seen. */
  count: number;
  /** Epoch ms of the last use; 0 when imported without a usable timestamp. */
  lastUsed: number;
  /** True while the command has only ever been seen in an imported file. */
  imported: boolean;
}

/**
 * Where the history JSON lives. Same contract as HostStorage: injected by the
 * embedder so core stays free of `node:fs`.
 */
export interface HistoryStorage {
  read(): string | null;
  write(data: string): void;
}

/** Beyond this, the lowest-value entries are evicted on save. */
const MAX_ENTRIES = 5000;

/** Commands longer than this are pathological (pasted blobs) — not history. */
const MAX_COMMAND_LENGTH = 500;

/**
 * Commands that likely embed a credential. They are never recorded: history
 * lands on disk in plain text, and a suggestion that helpfully completes
 * someone's token into a shared screen is worse than no suggestion.
 */
const SENSITIVE =
  /(^|\s)(-{1,2}(password|passwd|pass|token|secret|api[-_]?key)\b)|(password|passwd|secret|token|api[-_]?key)\s*=|\b(mysql|psql|mongosh)\b.*-p\S|BEGIN [A-Z ]*PRIVATE KEY/i;

export function looksSensitive(command: string): boolean {
  return SENSITIVE.test(command);
}

/**
 * Normalizes a raw line into something worth storing, or null to skip it.
 * A leading space means "don't remember this" — the same escape hatch bash and
 * zsh give you via HIST_IGNORE_SPACE, honoured here for consistency.
 */
export function normalizeCommand(raw: string): string | null {
  if (/^\s/.test(raw)) return null;
  const command = raw.trim();
  if (!command) return null;
  if (command.length > MAX_COMMAND_LENGTH) return null;
  if (looksSensitive(command)) return null;
  return command;
}

/**
 * Ranks history entries against what the user has typed so far.
 *
 * Pure and synchronous: the renderer holds the entry list in memory and calls
 * this on every keystroke, so it must not touch IPC or storage.
 */
export function rankSuggestions(
  entries: readonly HistoryEntry[],
  prefix: string,
  hostId?: string,
  limit = 10,
): HistoryEntry[] {
  if (!prefix) return [];
  const now = Date.now();
  return entries
    .filter((e) => e.command.length > prefix.length && e.command.startsWith(prefix))
    .map((e) => ({ entry: e, score: score(e, hostId, now) }))
    .sort((a, b) =>
      b.score - a.score || a.entry.command.localeCompare(b.entry.command),
    )
    .slice(0, limit)
    .map((s) => s.entry);
}

/** The single best completion for a prefix, or undefined when nothing fits. */
export function bestSuggestion(
  entries: readonly HistoryEntry[],
  prefix: string,
  hostId?: string,
): string | undefined {
  return rankSuggestions(entries, prefix, hostId, 1)[0]?.command;
}

function score(entry: HistoryEntry, hostId: string | undefined, now: number): number {
  let s = Math.log1p(entry.count) * 10;
  // Same-host commands dominate: this is the host the user is looking at.
  if (hostId && entry.hostIds.includes(hostId)) s += 100;
  // Something actually run through Pear beats a line scraped from a file.
  if (!entry.imported) s += 20;
  if (entry.lastUsed) {
    const days = (now - entry.lastUsed) / 86_400_000;
    s += Math.max(0, 30 - days);
  }
  return s;
}

/** Deduplicated command history persisted as JSON through a HistoryStorage. */
export class HistoryStore {
  private entries: HistoryEntry[] = [];

  constructor(private readonly storage: HistoryStorage) {
    try {
      const raw = storage.read();
      const parsed = raw ? JSON.parse(raw) : [];
      this.entries = Array.isArray(parsed) ? parsed.filter(isEntry) : [];
    } catch {
      this.entries = [];
    }
  }

  list(): HistoryEntry[] {
    return this.entries.map((e) => ({ ...e, hostIds: [...e.hostIds] }));
  }

  /** Records a command the user ran through Pear. No-op if it is filtered out. */
  record(hostId: string, raw: string): void {
    const command = normalizeCommand(raw);
    if (!command) return;
    this.merge(command, hostId, Date.now(), false);
    this.persist();
  }

  /**
   * Merges lines scraped from a host's shell history file. Imported entries
   * rank below typed ones and never overwrite a typed entry's timestamp.
   * Returns how many commands were new.
   */
  importCommands(hostId: string, commands: readonly string[]): number {
    let added = 0;
    for (const raw of commands) {
      const command = normalizeCommand(raw);
      if (!command) continue;
      if (!this.entries.some((e) => e.command === command)) added++;
      this.merge(command, hostId, 0, true);
    }
    if (added) this.persist();
    return added;
  }

  /** Drops everything, or just the entries tied to one host. */
  clear(hostId?: string): void {
    if (!hostId) {
      this.entries = [];
    } else {
      this.entries = this.entries
        .map((e) => ({ ...e, hostIds: e.hostIds.filter((h) => h !== hostId) }))
        .filter((e) => e.hostIds.length > 0);
    }
    this.persist();
  }

  suggest(prefix: string, hostId?: string): string | undefined {
    return bestSuggestion(this.entries, prefix, hostId);
  }

  private merge(command: string, hostId: string, at: number, imported: boolean): void {
    const existing = this.entries.find((e) => e.command === command);
    if (!existing) {
      this.entries.push({ command, hostIds: [hostId], count: 1, lastUsed: at, imported });
      return;
    }
    existing.count++;
    existing.hostIds = [hostId, ...existing.hostIds.filter((h) => h !== hostId)];
    if (at > existing.lastUsed) existing.lastUsed = at;
    if (!imported) existing.imported = false;
  }

  private persist(): void {
    if (this.entries.length > MAX_ENTRIES) {
      // Evict the least-used, oldest entries — score() without a host bias.
      const now = Date.now();
      this.entries = this.entries
        .sort((a, b) => score(b, undefined, now) - score(a, undefined, now))
        .slice(0, MAX_ENTRIES);
    }
    this.storage.write(JSON.stringify(this.entries));
  }
}

function isEntry(value: unknown): value is HistoryEntry {
  const e = value as HistoryEntry;
  return !!e && typeof e.command === 'string' && Array.isArray(e.hostIds);
}
