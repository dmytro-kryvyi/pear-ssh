import type { ExecResult } from '../ssh/transport';

/** Exec signature the fs helpers run on — any transport's `exec`. */
export type Exec = (command: string) => Promise<ExecResult>;

export function must(result: ExecResult, what: string): string {
  if (result.code !== 0) {
    throw new Error(
      `${what} failed: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`}`,
    );
  }
  return result.stdout;
}

export function basenameOf(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  return trimmed.slice(trimmed.lastIndexOf('/') + 1) || trimmed || '/';
}

export function dirnameOf(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  const i = trimmed.lastIndexOf('/');
  if (i <= 0) return '/';
  return trimmed.slice(0, i);
}

export function joinPath(dir: string, name: string): string {
  if (!name) return dir;
  return (dir === '/' ? '' : dir.replace(/\/$/, '')) + '/' + name;
}
