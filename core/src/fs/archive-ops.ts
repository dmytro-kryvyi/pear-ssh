import {
  archiveKind,
  compressCommand,
  extractCommand,
  type ArchiveFormat,
  type ArchiveTools,
} from './archive';
import { basenameOf, dirnameOf, joinPath } from './util';

/** A shell operation ready to run: what to execute and which dirs it touches. */
export interface FsOpPlan {
  kind: 'extract' | 'compress';
  label: string;
  command: string;
  /** Directories whose listings change when the op completes. */
  dirs: string[];
  /** The path produced (extraction dir or archive file). */
  result: string;
}

const EXTRACT_HINT: Record<string, string> = {
  zip: 'unzip, bsdtar or 7z',
  '7z': '7z or bsdtar',
  rar: 'unrar, 7z or bsdtar',
};

export function planExtract(tools: ArchiveTools, archivePath: string, destDir: string): FsOpPlan {
  const name = basenameOf(archivePath);
  const kind = archiveKind(name);
  if (!kind) throw new Error(`Not a known archive type: ${name}`);
  const command = extractCommand(kind, archivePath, destDir, tools);
  if (!command) {
    throw new Error(
      `No tool on this host can extract .${kind} (needs ${EXTRACT_HINT[kind] ?? 'tar'})`,
    );
  }
  const parent = dirnameOf(archivePath);
  const into = destDir === parent ? './' : `${basenameOf(destDir)}/`;
  return {
    kind: 'extract',
    label: `Extract ${name} → ${into}`,
    command,
    dirs: parent === destDir ? [parent] : [parent, destDir],
    result: destDir,
  };
}

export function planCompress(
  tools: ArchiveTools,
  dir: string,
  names: string[],
  archiveName: string,
  format: ArchiveFormat,
): FsOpPlan {
  if (names.length === 0) throw new Error('Nothing selected to compress');
  for (const n of [...names, archiveName]) {
    if (!n || n.includes('/') || n === '.' || n === '..') throw new Error(`Invalid name: ${n}`);
  }
  const result = joinPath(dir, archiveName);
  const command = compressCommand(format, dir, names, result, tools);
  if (!command) throw new Error(`No tool on this host can create .${format} archives`);
  return {
    kind: 'compress',
    label: `Compress ${names.length === 1 ? names[0] : `${names.length} items`} → ${archiveName}`,
    command,
    dirs: [dir],
    result,
  };
}
