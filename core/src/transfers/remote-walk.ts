// One round trip instead of one per directory: list a whole tree on a host
// with `find … -exec stat`, for the transfer manifest and for comparing a
// destination against it. GNU and busybox userlands understand this form;
// anything else (BSD stat, names with newlines, a missing `find`) makes
// parseWalk return null and the caller walks directory by directory.

import { shq } from '../shq';
import { kindOf } from '../ssh/mode';
import { isMacMeta } from './mac-meta';

export interface WalkedFile {
  /** Path relative to the walked directory, e.g. `tree/sub/a.txt`. */
  rel: string;
  size: number;
  mtimeMs: number;
  kind: 'file' | 'link';
}

export interface WalkedTree {
  /** Relative directory paths, parents before children; roots included. */
  dirs: string[];
  files: WalkedFile[];
}

/** `names` are entries of `dir`; every one is walked recursively. */
export function walkCommand(dir: string, names: string[]): string {
  const roots = names.map((n) => shq('./' + n)).join(' ');
  return (
    `cd -- ${shq(dir)} && find ${roots} \\( -type d -o -type f -o -type l \\) ` +
    `-exec stat -c '%f %s %Y %n' {} +`
  );
}

const LINE = /^([0-9a-fA-F]+) (\d+) (\d+) \.\/(.+)$/;

/**
 * Null when the output cannot be trusted: a line that does not parse (a name
 * with a newline, a different `stat`), or a requested root that is absent.
 */
export function parseWalk(
  stdout: string,
  names: string[],
  opts: { skipMacMeta?: boolean } = {},
): WalkedTree | null {
  const dirs: string[] = [];
  const files: WalkedFile[] = [];
  const seenRoots = new Set<string>();
  for (const raw of stdout.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line) continue;
    const m = line.match(LINE);
    if (!m) return null;
    const rel = m[4];
    const kind = kindOf(parseInt(m[1], 16));
    const slash = rel.indexOf('/');
    seenRoots.add(slash < 0 ? rel : rel.slice(0, slash));
    if (opts.skipMacMeta && slash >= 0 && hasMacMeta(rel, kind)) continue;
    if (kind === 'dir') dirs.push(rel);
    else files.push({ rel, size: Number(m[2]), mtimeMs: Number(m[3]) * 1000, kind });
  }
  for (const name of names) if (!seenRoots.has(name)) return null;
  dirs.sort();
  return { dirs, files };
}

/** Any segment below the root is macOS metadata (the root was picked by hand). */
function hasMacMeta(rel: string, kind: 'file' | 'dir' | 'link'): boolean {
  const parts = rel.split('/');
  for (let i = 1; i < parts.length; i++) {
    const last = i === parts.length - 1;
    if (isMacMeta(parts[i], last ? kind : 'dir')) return true;
  }
  return false;
}
