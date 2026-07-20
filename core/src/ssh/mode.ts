import type { FileEntry } from '../types';

// POSIX mode decoding. Kept in the pure layer: any SSH implementation reports
// the same st_mode integer, so every platform's transport reuses this.

const S_IFMT = 0o170000;

export function kindOf(mode: number): FileEntry['kind'] {
  const fmt = mode & S_IFMT;
  if (fmt === 0o040000) return 'dir';
  if (fmt === 0o120000) return 'link';
  return 'file';
}

export function modeString(mode: number): string {
  const kind = kindOf(mode);
  const typeChar = kind === 'dir' ? 'd' : kind === 'link' ? 'l' : '-';
  let out = typeChar;
  for (const shift of [6, 3, 0]) {
    const bits = (mode >> shift) & 0o7;
    out += (bits & 4 ? 'r' : '-') + (bits & 2 ? 'w' : '-') + (bits & 1 ? 'x' : '-');
  }
  return out;
}
