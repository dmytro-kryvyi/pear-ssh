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

/** Anything younger may belong to a Pear that is running right now. */
const STALE_MS = 24 * 60 * 60 * 1000;

/**
 * Delete staging left behind by a previous crash; call once at startup.
 * Only *old* directories: the temp dir is shared, and another Pear on this
 * machine (the desktop app beside a pear-server, two servers) may be in the
 * middle of a transfer in one of them.
 */
export async function sweepStaging(): Promise<void> {
  let names: string[];
  try {
    names = await fs.readdir(tmpdir());
  } catch {
    return;
  }
  const now = Date.now();
  await Promise.all(
    names
      .filter((n) => n.startsWith(PREFIX))
      .map(async (n) => {
        const dir = join(tmpdir(), n);
        try {
          if (now - (await fs.stat(dir)).mtimeMs < STALE_MS) return;
          await fs.rm(dir, { recursive: true, force: true });
        } catch {
          /* gone already, or not ours to remove */
        }
      }),
  );
}
