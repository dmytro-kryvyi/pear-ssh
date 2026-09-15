/**
 * Minimal OpenSSH ssh_config parser — just enough to lift concrete `Host`
 * entries (alias → hostname/user/port/key) into Pear's host catalog.
 *
 * Platform-pure: text in, entries out. File reading, `Include` resolution
 * and `~` expansion live in `@pear/core/node` (ssh-config-file.ts).
 *
 * Deliberate simplifications vs OpenSSH's first-obtained-value-wins:
 *  - only `Host *` blocks and preamble options (before any Host line) act as
 *    fallback defaults; other wildcard patterns (`*.internal`, `!bad`) are
 *    ignored entirely;
 *  - `Match` blocks are skipped wholesale;
 *  - only the first `IdentityFile` is kept (HostAuth holds a single key path).
 */

/** One resolved concrete Host entry from an ssh_config. */
export interface SshConfigEntry {
  /** The Host pattern token (concrete — no wildcards). */
  alias: string;
  /** HostName, falling back to the alias itself (OpenSSH default). */
  host: string;
  port?: number;
  user?: string;
  /** First IdentityFile; `~`-expanded by the node loader. */
  identityFile?: string;
  /** ProxyJump target — present means "not importable yet". */
  proxyJump?: string;
}

/** Flat lexed directive: lowercased keyword + unquoted args. */
export interface SshConfigDirective {
  keyword: string;
  args: string[];
}

/**
 * Lex ssh_config text into flat directives. Handles comments, blank lines,
 * CRLF, `Keyword value`, `Keyword=value` and double-quoted arguments.
 */
export function tokenizeSshConfig(text: string): SshConfigDirective[] {
  const out: SshConfigDirective[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const tokens = tokenizeLine(line);
    if (tokens.length < 2) continue;
    const [keyword, ...args] = tokens;
    out.push({ keyword: keyword.toLowerCase(), args });
  }
  return out;
}

/** Split one directive line into tokens: whitespace or `=` after the keyword,
 *  double quotes group args, `#` starts a comment outside quotes. */
function tokenizeLine(line: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inQuotes = false;
  let sawKeyword = false;
  const push = () => {
    if (current) {
      tokens.push(current);
      current = '';
      sawKeyword = true;
    }
  };
  for (const ch of line) {
    if (inQuotes) {
      if (ch === '"') inQuotes = false;
      else current += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === '#') {
      break;
    } else if (ch === ' ' || ch === '\t' || (ch === '=' && !sawKeyword)) {
      push();
    } else {
      current += ch;
    }
  }
  push();
  return tokens;
}

const KEYWORDS = ['hostname', 'user', 'port', 'identityfile', 'proxyjump'] as const;
type Keyword = (typeof KEYWORDS)[number];

type Fields = Partial<Record<Keyword, string>>;

function isWildcard(pattern: string): boolean {
  return pattern.includes('*') || pattern.includes('?') || pattern.startsWith('!');
}

/**
 * Resolve flat directives into concrete host entries. The first Host block
 * naming an alias wins; later blocks (and `Host *` defaults, applied last)
 * only fill fields the entry does not have yet.
 */
export function resolveSshHosts(directives: SshConfigDirective[]): SshConfigEntry[] {
  const order: string[] = [];
  const fields = new Map<string, Fields>();
  const globals: Fields = {};

  /** Field targets of the current Host block; null while skipping (Match /
   *  wildcard-only). Preamble options (before any Host) act as defaults. */
  let current: Fields[] | null = [globals];

  for (const { keyword, args } of directives) {
    if (keyword === 'host') {
      current = [];
      for (const pattern of args) {
        if (pattern === '*') {
          current.push(globals);
        } else if (!isWildcard(pattern)) {
          let f = fields.get(pattern);
          if (!f) {
            f = {};
            fields.set(pattern, f);
            order.push(pattern);
          }
          current.push(f);
        }
      }
      continue;
    }
    if (keyword === 'match') {
      current = null;
      continue;
    }
    if (!current || !(KEYWORDS as readonly string[]).includes(keyword)) continue;
    const value = args[0];
    if (!value) continue;
    for (const f of current) {
      if (f[keyword as Keyword] === undefined) f[keyword as Keyword] = value;
    }
  }

  return order.map((alias) => {
    const f = fields.get(alias)!;
    const merged: Fields = { ...f };
    for (const k of KEYWORDS) {
      if (merged[k] === undefined && globals[k] !== undefined) merged[k] = globals[k];
    }
    const port = merged.port && /^\d+$/.test(merged.port) ? Number(merged.port) : undefined;
    const entry: SshConfigEntry = { alias, host: merged.hostname ?? alias };
    if (port !== undefined) entry.port = port;
    if (merged.user) entry.user = merged.user;
    if (merged.identityfile) entry.identityFile = merged.identityfile;
    if (merged.proxyjump) entry.proxyJump = merged.proxyjump;
    return entry;
  });
}
