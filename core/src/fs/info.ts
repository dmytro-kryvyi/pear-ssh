import type { FileEntry } from '../types';
import { kindOf, modeText } from '../ssh/mode';
import { shq } from '../shq';
import { basenameOf, must, type Exec } from './util';

/** Everything `stat` knows about one path (an lstat: links are not followed). */
export interface FileInfo {
  path: string;
  name: string;
  kind: FileEntry['kind'];
  /** Full st_mode, type bits included. */
  mode: number;
  /** "-rwsr-xr-x" style text, special bits included. */
  modeText: string;
  size: number;
  nlink: number;
  uid: number;
  gid: number;
  owner: string;
  group: string;
  atimeMs: number;
  mtimeMs: number;
  ctimeMs: number;
  /** Only for symlinks. */
  linkTarget?: string;
  /** Only when asked for (`deep`), and only for directories. */
  dir?: { bytes: number; files: number; dirs: number };
}

// GNU/busybox stat (-c, %f = hex st_mode) is tried first and tagged G; BSD/macOS
// stat (-f, %p = octal st_mode) answers with tag B. Each extra fact is printed
// on its own tagged line so the parser never depends on field order.
export function fileInfoCommand(path: string, deep: boolean): string {
  const p = shq(path);
  const parts = [
    `{ [ -e ${p} ] || [ -L ${p} ]; } || { echo 'No such file or directory' >&2; exit 2; }`,
    `stat -c 'G|%f|%s|%u|%g|%U|%G|%X|%Y|%Z|%h' -- ${p} 2>/dev/null || stat -f 'B|%p|%z|%u|%g|%Su|%Sg|%a|%m|%c|%l' -- ${p} || exit 3`,
    `printf 'L|%s\\n' "$(readlink -- ${p} 2>/dev/null)"`,
  ];
  if (deep) {
    parts.push(
      `printf 'D|%s\\n' "$(du -sk -- ${p} 2>/dev/null | cut -f1)"`,
      `printf 'F|%s\\n' "$(find ${p} -type f 2>/dev/null | wc -l)"`,
      `printf 'N|%s\\n' "$(find ${p} -type d 2>/dev/null | wc -l)"`,
    );
  }
  return parts.join('; ');
}

export function parseFileInfo(path: string, stdout: string): FileInfo {
  const lines = stdout.split('\n').map((l) => l.replace(/\r$/, ''));
  const statLine = lines.find((l) => l.startsWith('G|') || l.startsWith('B|'));
  if (!statLine) throw new Error('stat produced no result');
  const f = statLine.split('|');
  const mode = parseInt(f[1], statLine[0] === 'G' ? 16 : 8);
  const num = (s: string | undefined) => Number((s ?? '').trim()) || 0;
  const kind = kindOf(mode);
  const info: FileInfo = {
    path,
    name: basenameOf(path),
    kind,
    mode,
    modeText: modeText(mode),
    size: num(f[2]),
    uid: num(f[3]),
    gid: num(f[4]),
    owner: (f[5] ?? '').trim(),
    group: (f[6] ?? '').trim(),
    atimeMs: num(f[7]) * 1000,
    mtimeMs: num(f[8]) * 1000,
    ctimeMs: num(f[9]) * 1000,
    nlink: num(f[10]),
  };
  const tagged = (tag: string) => lines.find((l) => l.startsWith(`${tag}|`))?.slice(2);
  const link = tagged('L');
  if (kind === 'link' && link) info.linkTarget = link;
  const du = tagged('D');
  if (du !== undefined && kind === 'dir') {
    info.dir = {
      bytes: num(du) * 1024,
      files: num(tagged('F')),
      dirs: Math.max(0, num(tagged('N')) - 1),
    };
  }
  return info;
}

export async function fileInfo(
  exec: Exec,
  path: string,
  opts: { deep?: boolean } = {},
): Promise<FileInfo> {
  const result = await exec(fileInfoCommand(path, opts.deep === true));
  return parseFileInfo(path, result.code === 0 ? result.stdout : must(result, 'stat'));
}
