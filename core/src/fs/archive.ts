import { shq } from '../shq';
import { basenameOf, type Exec } from './util';

// Archive support is shell-driven: the host's own tar/zip/7z do the work, so
// the same commands serve SSH hosts, the local machine and container sub-hosts.
// Everything but detectArchiveTools() is pure and unit-tested on the strings.

export const ARCHIVE_TOOLS = [
  'tar',
  'bsdtar',
  'gzip',
  'bzip2',
  'xz',
  'zstd',
  'zip',
  'unzip',
  '7z',
  '7za',
  '7zz',
  'unrar',
] as const;
export type ArchiveTool = (typeof ARCHIVE_TOOLS)[number];
export type TarFlavor = 'gnu' | 'bsd' | 'busybox' | 'none';

export interface ArchiveTools {
  tools: ArchiveTool[];
  tar: TarFlavor;
}

export const NO_TOOLS: ArchiveTools = { tools: [], tar: 'none' };

export const TOOLS_COMMAND =
  `for t in ${ARCHIVE_TOOLS.join(' ')}; do command -v "$t" >/dev/null 2>&1 && echo "TOOL:$t"; done; ` +
  `echo "TARV:$(tar --version 2>/dev/null | head -n 1)"; true`;

export function parseTools(stdout: string): ArchiveTools {
  const tools: ArchiveTool[] = [];
  let tarv = '';
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('TOOL:')) {
      const t = line.slice(5) as ArchiveTool;
      if ((ARCHIVE_TOOLS as readonly string[]).includes(t) && !tools.includes(t)) tools.push(t);
    } else if (line.startsWith('TARV:')) tarv = line.slice(5);
  }
  const tar: TarFlavor = !tools.includes('tar')
    ? 'none'
    : /GNU tar/i.test(tarv)
      ? 'gnu'
      : /bsdtar|libarchive/i.test(tarv)
        ? 'bsd'
        : 'busybox';
  return { tools, tar };
}

/** Never throws: a host without a shell simply has no archive tools. */
export async function detectArchiveTools(exec: Exec): Promise<ArchiveTools> {
  try {
    const result = await exec(TOOLS_COMMAND);
    return parseTools(result.stdout);
  } catch {
    return NO_TOOLS;
  }
}

export type ArchiveKind =
  | 'tar'
  | 'tar.gz'
  | 'tar.bz2'
  | 'tar.xz'
  | 'tar.zst'
  | 'zip'
  | '7z'
  | 'rar'
  | 'gz'
  | 'bz2'
  | 'xz'
  | 'zst';
export type ArchiveFormat = 'tar' | 'tar.gz' | 'tar.bz2' | 'tar.xz' | 'tar.zst' | 'zip' | '7z';

const KIND_SUFFIXES: Array<[string, ArchiveKind]> = [
  ['.tar.gz', 'tar.gz'],
  ['.tgz', 'tar.gz'],
  ['.tar.bz2', 'tar.bz2'],
  ['.tbz2', 'tar.bz2'],
  ['.tbz', 'tar.bz2'],
  ['.tar.xz', 'tar.xz'],
  ['.txz', 'tar.xz'],
  ['.tar.zst', 'tar.zst'],
  ['.tzst', 'tar.zst'],
  ['.tar', 'tar'],
  ['.zip', 'zip'],
  ['.7z', '7z'],
  ['.rar', 'rar'],
  ['.gz', 'gz'],
  ['.bz2', 'bz2'],
  ['.xz', 'xz'],
  ['.zst', 'zst'],
];

export function archiveKind(name: string): ArchiveKind | null {
  const lower = name.toLowerCase();
  for (const [suffix, kind] of KIND_SUFFIXES) {
    if (lower.endsWith(suffix) && lower.length > suffix.length) return kind;
  }
  return null;
}

/** "assets.tar.gz" → "assets"; "notes.txt.gz" → "notes.txt". */
export function archiveStem(name: string, kind: ArchiveKind): string {
  const lower = name.toLowerCase();
  for (const [suffix, k] of KIND_SUFFIXES) {
    if (k === kind && lower.endsWith(suffix)) return name.slice(0, name.length - suffix.length);
  }
  return name;
}

/** Plain compressed files (not tar) unpack to a single file next to themselves. */
export function isSingleFileKind(kind: ArchiveKind): boolean {
  return kind === 'gz' || kind === 'bz2' || kind === 'xz' || kind === 'zst';
}

function has(tools: ArchiveTools, ...names: ArchiveTool[]): boolean {
  return names.some((n) => tools.tools.includes(n));
}

function sevenZip(tools: ArchiveTools): string | null {
  return (['7z', '7za', '7zz'] as const).find((t) => tools.tools.includes(t)) ?? null;
}

/** The tar binary to use, or null. GNU/busybox `tar` first, bsdtar as fallback. */
function tarBin(tools: ArchiveTools): string | null {
  return has(tools, 'tar') ? 'tar' : has(tools, 'bsdtar') ? 'bsdtar' : null;
}

/** bsdtar bundles its codecs; GNU and busybox tar shell out to gzip, xz & co. */
function bundled(tools: ArchiveTools): boolean {
  return tools.tar === 'bsd' || tarBin(tools) === 'bsdtar';
}

const TAR_FLAGS: Partial<Record<ArchiveKind | ArchiveFormat, { flag: string; tool: ArchiveTool }>> =
  {
    'tar.gz': { flag: '-z', tool: 'gzip' },
    'tar.bz2': { flag: '-j', tool: 'bzip2' },
    'tar.xz': { flag: '-J', tool: 'xz' },
  };

export function extractCommand(
  kind: ArchiveKind,
  archivePath: string,
  destDir: string,
  tools: ArchiveTools,
): string | null {
  const a = shq(archivePath);
  const d = shq(destDir);
  const prefix = `mkdir -p -- ${d} && `;
  const sz = sevenZip(tools);
  const tar = tarBin(tools);
  const bsdtar = has(tools, 'bsdtar') ? `bsdtar -x -f ${a} -C ${d}` : null;
  const seven = sz ? `${sz} x -y -o${d} ${a}` : null;
  let cmd: string | null = null;
  switch (kind) {
    case 'tar':
      cmd = tar ? `${tar} -x -f ${a} -C ${d}` : null;
      break;
    case 'tar.gz':
    case 'tar.bz2':
    case 'tar.xz': {
      const spec = TAR_FLAGS[kind]!;
      if (tar && (bundled(tools) || has(tools, spec.tool))) {
        cmd = `${tar} -x ${spec.flag} -f ${a} -C ${d}`;
      } else if (bsdtar) cmd = bsdtar;
      break;
    }
    case 'tar.zst':
      if (tar === 'tar' && tools.tar !== 'busybox') cmd = `tar -x --zstd -f ${a} -C ${d}`;
      else if (has(tools, 'zstd') && tar) cmd = `zstd -dc ${a} | ${tar} -x -f - -C ${d}`;
      else if (bsdtar) cmd = bsdtar;
      break;
    case 'zip':
      cmd = has(tools, 'unzip') ? `unzip -o -q ${a} -d ${d}` : (bsdtar ?? seven);
      break;
    case '7z':
      cmd = seven ?? bsdtar;
      break;
    case 'rar':
      cmd = has(tools, 'unrar') ? `unrar x -o+ ${a} ${shq(destDir + '/')}` : (seven ?? bsdtar);
      break;
    case 'gz':
    case 'bz2':
    case 'xz':
    case 'zst': {
      const tool = ({ gz: 'gzip', bz2: 'bzip2', xz: 'xz', zst: 'zstd' } as const)[kind];
      const out = shq(
        destDir.replace(/\/$/, '') + '/' + archiveStem(basenameOf(archivePath), kind),
      );
      cmd = has(tools, tool) ? `${tool} -dc ${a} > ${out}` : seven;
      break;
    }
  }
  return cmd ? prefix + cmd : null;
}

export function compressCommand(
  format: ArchiveFormat,
  dir: string,
  names: string[],
  archivePath: string,
  tools: ArchiveTools,
): string | null {
  const n = names.map(shq).join(' ');
  const out = shq(archivePath);
  const prefix = `cd -- ${shq(dir)} && `;
  const sz = sevenZip(tools);
  const tar = tarBin(tools);
  let cmd: string | null = null;
  switch (format) {
    case 'tar':
      cmd = tar ? `${tar} -c -f ${out} -- ${n}` : null;
      break;
    case 'tar.gz':
    case 'tar.bz2':
    case 'tar.xz': {
      const spec = TAR_FLAGS[format]!;
      if (tar && (bundled(tools) || has(tools, spec.tool))) {
        cmd = `${tar} -c ${spec.flag} -f ${out} -- ${n}`;
      } else if (has(tools, 'bsdtar')) cmd = `bsdtar -c ${spec.flag} -f ${out} -- ${n}`;
      break;
    }
    case 'tar.zst':
      if (!has(tools, 'zstd') && !has(tools, 'bsdtar')) break;
      if (tar === 'tar' && tools.tar === 'busybox') cmd = `tar -c -f - -- ${n} | zstd -q -o ${out}`;
      else if (tar) cmd = `${tar} -c --zstd -f ${out} -- ${n}`;
      break;
    case 'zip':
      cmd = has(tools, 'zip')
        ? `zip -r -q -- ${out} ${n}`
        : has(tools, 'bsdtar')
          ? `bsdtar -a -c -f ${out} -- ${n}`
          : sz
            ? `${sz} a -y -tzip -- ${out} ${n}`
            : null;
      break;
    case '7z':
      cmd = sz ? `${sz} a -y -- ${out} ${n}` : null;
      break;
  }
  return cmd ? prefix + cmd : null;
}

export interface FormatChoice {
  format: ArchiveFormat;
  ext: string;
  label: string;
}

const FORMATS: FormatChoice[] = [
  { format: 'tar.gz', ext: 'tar.gz', label: 'tar.gz (gzip)' },
  { format: 'zip', ext: 'zip', label: 'zip' },
  { format: 'tar.xz', ext: 'tar.xz', label: 'tar.xz (xz, smaller)' },
  { format: 'tar.zst', ext: 'tar.zst', label: 'tar.zst (zstd, fast)' },
  { format: 'tar.bz2', ext: 'tar.bz2', label: 'tar.bz2 (bzip2)' },
  { format: 'tar', ext: 'tar', label: 'tar (no compression)' },
  { format: '7z', ext: '7z', label: '7z' },
];

/** Formats the host can produce, in menu order. */
export function availableFormats(tools: ArchiveTools): FormatChoice[] {
  return FORMATS.filter(
    (f) => compressCommand(f.format, '/', ['x'], '/x.' + f.ext, tools) !== null,
  );
}

export function defaultFormat(tools: ArchiveTools): ArchiveFormat | null {
  const list = availableFormats(tools);
  return list.find((f) => f.format === 'tar.gz')?.format ?? list[0]?.format ?? null;
}
