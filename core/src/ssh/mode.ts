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

/**
 * Full `ls -l` style mode text, including the setuid/setgid/sticky bits that
 * modeString() drops ("-rwsr-xr-x", "drwxrwxrwt"). Used by the properties view.
 */
export function modeText(mode: number): string {
  const fmt = mode & S_IFMT;
  const typeChar =
    fmt === 0o040000
      ? 'd'
      : fmt === 0o120000
        ? 'l'
        : fmt === 0o060000
          ? 'b'
          : fmt === 0o020000
            ? 'c'
            : fmt === 0o010000
              ? 'p'
              : fmt === 0o140000
                ? 's'
                : '-';
  let out = typeChar;
  const specials = [0o4000, 0o2000, 0o1000];
  const specialChars = ['s', 's', 't'];
  [6, 3, 0].forEach((shift, i) => {
    const bits = (mode >> shift) & 0o7;
    const x = (bits & 1) !== 0;
    const special = (mode & specials[i]) !== 0;
    out += (bits & 4 ? 'r' : '-') + (bits & 2 ? 'w' : '-');
    out += special ? (x ? specialChars[i] : specialChars[i].toUpperCase()) : x ? 'x' : '-';
  });
  return out;
}

/** The permission bits as a 4-digit octal string ("0755", "4755"). */
export function octalOf(mode: number): string {
  return (mode & 0o7777).toString(8).padStart(4, '0');
}

/** Parse a 1–4 digit octal permission string; null when malformed. */
export function parseOctal(text: string): number | null {
  return /^[0-7]{1,4}$/.test(text.trim()) ? parseInt(text.trim(), 8) : null;
}
