import { octalOf } from '../ssh/mode';
import { shq } from '../shq';
import { must, type Exec } from './util';

export interface PermsChange {
  /** Permission bits (0o7777 mask); the type bits are ignored. */
  mode?: number;
  owner?: string;
  group?: string;
  recursive?: boolean;
}

/** User/group names (or numeric ids) as chown accepts them — no shell metacharacters. */
export const NAME_RE = /^[A-Za-z0-9._][A-Za-z0-9._$-]*$/;

export function chmodCommand(path: string, mode: number, recursive = false): string {
  return `chmod ${recursive ? '-R ' : ''}${octalOf(mode)} -- ${shq(path)}`;
}

export function chownCommand(
  path: string,
  owner?: string,
  group?: string,
  recursive = false,
): string | null {
  const o = owner?.trim() ?? '';
  const g = group?.trim() ?? '';
  if (!o && !g) return null;
  for (const name of [o, g]) {
    if (name && !NAME_RE.test(name)) throw new Error(`Invalid owner/group name: ${name}`);
  }
  const spec = o && g ? `${o}:${g}` : o ? o : `:${g}`;
  return `chown ${recursive ? '-R ' : ''}${shq(spec)} -- ${shq(path)}`;
}

/**
 * Apply an ownership and/or mode change. chown runs first: Linux clears the
 * setuid/setgid bits on ownership changes, so the mode must land afterwards.
 */
export async function applyPerms(exec: Exec, path: string, change: PermsChange): Promise<void> {
  const chown = chownCommand(path, change.owner, change.group, change.recursive);
  if (chown) must(await exec(chown), 'chown');
  if (change.mode !== undefined) {
    must(await exec(chmodCommand(path, change.mode, change.recursive)), 'chmod');
  }
}
