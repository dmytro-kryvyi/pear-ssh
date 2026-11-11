/**
 * macOS leaves resource-fork and Finder metadata next to real files: a
 * `__MACOSX` directory in anything unzipped on a Mac, `.DS_Store` in every
 * browsed folder, `._name` AppleDouble files on non-HFS volumes. None of it
 * means anything on a Linux host, and a zip's `__MACOSX` can double the file
 * count of a transfer.
 */
export function isMacMeta(name: string, kind: 'file' | 'dir' | 'link'): boolean {
  if (kind === 'dir') return name === '__MACOSX';
  return name === '.DS_Store' || name.startsWith('._');
}
