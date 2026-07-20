import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PREFIX = 'pear-transfer-';

/** Fresh unique staging directory for one cross-host transfer. */
export function makeStagingDir(): Promise<string> {
  return fs.mkdtemp(join(tmpdir(), PREFIX));
}

export async function removeStaging(dir: string): Promise<void> {
  // Only ever delete our own staging dirs, wherever the caller got the path.
  if (!join(dir).startsWith(join(tmpdir(), PREFIX))) return;
  await fs.rm(dir, { recursive: true, force: true });
}

/** Delete staging left behind by a previous crash; call once at startup. */
export async function sweepStaging(): Promise<void> {
  let names: string[];
  try {
    names = await fs.readdir(tmpdir());
  } catch {
    return;
  }
  await Promise.all(
    names
      .filter((n) => n.startsWith(PREFIX))
      .map((n) => fs.rm(join(tmpdir(), n), { recursive: true, force: true }).catch(() => {})),
  );
}
