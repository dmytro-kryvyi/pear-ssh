import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import {
  resolveSshHosts,
  tokenizeSshConfig,
  type SshConfigDirective,
  type SshConfigEntry,
} from '../hosts/ssh-config';

const MAX_INCLUDE_DEPTH = 8;

/**
 * Read and resolve `~/.ssh/config` (or `configPath`) into concrete host
 * entries. Never throws: a missing or unreadable config yields `[]`, and
 * unreadable `Include` targets are skipped.
 */
export function loadSshConfigEntries(configPath?: string): SshConfigEntry[] {
  const path = configPath ?? join(homedir(), '.ssh', 'config');
  const directives = readDirectives(path, new Set(), 0);
  if (!directives) return [];
  const fallbackUser = localUser();
  return resolveSshHosts(directives).map((entry) => postProcess(entry, fallbackUser));
}

/** Tokenize one file with `Include` directives spliced in place, so an
 *  Include inside a Host block correctly continues that block. */
function readDirectives(
  path: string,
  visited: Set<string>,
  depth: number,
): SshConfigDirective[] | null {
  if (depth > MAX_INCLUDE_DEPTH) return null;
  let text: string;
  let real: string;
  try {
    real = realpathSync(path);
    if (visited.has(real)) return null;
    text = readFileSync(real, 'utf8');
  } catch {
    return null;
  }
  visited.add(real);
  const out: SshConfigDirective[] = [];
  for (const directive of tokenizeSshConfig(text)) {
    if (directive.keyword !== 'include') {
      out.push(directive);
      continue;
    }
    for (const arg of directive.args) {
      for (const included of expandIncludePath(arg, dirname(real))) {
        const nested = readDirectives(included, visited, depth + 1);
        if (nested) out.push(...nested);
      }
    }
  }
  return out;
}

/** `~` → home; relative paths resolve against the including file's directory
 *  (OpenSSH uses ~/.ssh, where the config lives — same thing in practice);
 *  a `*` in the final path segment globs over that directory's files. */
function expandIncludePath(arg: string, fromDir: string): string[] {
  let path = expandTilde(arg);
  if (!isAbsolute(path)) path = join(fromDir, path);
  const name = basename(path);
  if (!name.includes('*')) return [path];
  const dir = dirname(path);
  const re = new RegExp(
    '^' + name.split('*').map(escapeRegExp).join('.*') + '$',
  );
  try {
    return readdirSync(dir)
      .filter((f) => re.test(f))
      .sort()
      .map((f) => join(dir, f));
  } catch {
    return [];
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function expandTilde(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return resolve(homedir(), path.slice(2));
  return path;
}

function localUser(): string | undefined {
  try {
    return userInfo().username;
  } catch {
    return undefined;
  }
}

function postProcess(entry: SshConfigEntry, fallbackUser: string | undefined): SshConfigEntry {
  const out = { ...entry };
  if (out.identityFile) {
    // %-tokens (%d, %h, …) are beyond v1 — drop the key and let the
    // connection layer's default-key chain take over.
    if (out.identityFile.includes('%')) delete out.identityFile;
    else out.identityFile = expandTilde(out.identityFile);
  }
  if (!out.user && fallbackUser) out.user = fallbackUser;
  return out;
}
