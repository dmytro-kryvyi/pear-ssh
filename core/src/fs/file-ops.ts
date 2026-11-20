// Copy, move and delete within one host as background operations: a big
// `cp -a` or `rm -rf` runs for minutes, and as a plain exec it could neither
// be cancelled nor seen. These plans run through FsOpsRunner like extract and
// compress do.

import { shq } from '../shq';
import type { FsOpPlan } from './archive-ops';
import { basenameOf, dirnameOf } from './util';

export interface CopyPair {
  from: string;
  to: string;
  /** Remove whatever is at `to` first (the "overwrite" conflict choice). */
  replace?: boolean;
}

function checkName(name: string): void {
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\0')) {
    throw new Error(`Not a file name: ${JSON.stringify(name)}`);
  }
}

function countLabel(verb: string, names: string[]): string {
  return names.length === 1 ? `${verb} ${names[0]}` : `${verb} ${names.length} items`;
}

export function planDelete(dir: string, names: string[]): FsOpPlan {
  if (!names.length) throw new Error('Nothing to delete');
  names.forEach(checkName);
  return {
    kind: 'delete',
    label: countLabel('Delete', names),
    command: `cd -- ${shq(dir)} && rm -rf -- ${names.map(shq).join(' ')}`,
    dirs: [dir],
    result: dir,
  };
}

export function planCopy(pairs: CopyPair[], move: boolean): FsOpPlan {
  if (!pairs.length) throw new Error(move ? 'Nothing to move' : 'Nothing to copy');
  const steps: string[] = [];
  const dirs = new Set<string>();
  for (const { from, to, replace } of pairs) {
    if (!from.startsWith('/') || !to.startsWith('/')) throw new Error('Paths must be absolute');
    if (from === to) throw new Error(`${basenameOf(from)}: source and destination are the same`);
    if (to.startsWith(from + '/'))
      throw new Error(`${basenameOf(from)}: cannot be placed inside itself`);
    if (replace) steps.push(`rm -rf -- ${shq(to)}`);
    steps.push(`${move ? 'mv -f' : 'cp -a'} -- ${shq(from)} ${shq(to)}`);
    dirs.add(dirnameOf(to));
    if (move) dirs.add(dirnameOf(from));
  }
  const destDir = dirnameOf(pairs[0].to);
  const verb = move ? 'Move' : 'Copy';
  return {
    kind: move ? 'move' : 'copy',
    label: `${countLabel(
      verb,
      pairs.map((p) => basenameOf(p.from)),
    )} → ${basenameOf(destDir) || '/'}/`,
    command: steps.join(' && '),
    dirs: [...dirs],
    result: destDir,
  };
}
