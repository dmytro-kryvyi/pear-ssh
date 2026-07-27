import type { DockerDiskRow } from '../types';
import { jsonLines, parseBytes, type Exec } from '../orchestration/orchestration';

interface DfRow {
  Type: string;
  TotalCount: string;
  Active: string;
  Size: string;
  Reclaimable: string; // "737.9MB (61%)" — the parenthesised share is dropped
}

const DF_TYPES: Record<string, DockerDiskRow['type']> = {
  Images: 'images',
  Containers: 'containers',
  'Local Volumes': 'volumes',
  'Build Cache': 'buildCache',
};

const ORDER: DockerDiskRow['type'][] = ['containers', 'images', 'volumes', 'buildCache'];

/**
 * `docker system df` walks the whole image store, so this can take seconds on
 * a busy host — callers fetch it lazily, never on the monitor tick.
 */
export async function fetchDockerDf(exec: Exec): Promise<DockerDiskRow[]> {
  const result = await exec(`docker system df --format '{{json .}}'`);
  if (result.code !== 0) {
    throw new Error(`docker system df failed: ${result.stderr.trim() || `exit ${result.code}`}`);
  }
  const rows: DockerDiskRow[] = [];
  for (const row of jsonLines<DfRow>(result.stdout)) {
    const type = DF_TYPES[row.Type];
    if (!type) continue;
    const sizeText = (row.Size ?? '').trim();
    const reclaimableText = (row.Reclaimable ?? '').replace(/\s*\(.*\)\s*$/, '').trim();
    rows.push({
      type,
      count: Number(row.TotalCount) || 0,
      active: Number(row.Active) || 0,
      size: parseBytes(sizeText),
      reclaimable: parseBytes(reclaimableText),
      sizeText,
      reclaimableText,
    });
  }
  return rows.sort((a, b) => ORDER.indexOf(a.type) - ORDER.indexOf(b.type));
}
