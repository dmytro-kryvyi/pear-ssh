import type { HostConfig } from '../types';

/**
 * Short label for tight rows: initials of hyphen/underscore/dot segments
 * (ceramic-world-staging -> CWS), numeric segments kept whole (edge-01 -> E01),
 * or the first letters of a single word. A host can override it with `short`.
 */
export function autoShort(name: string): string {
  if (!name) return '';
  const parts = String(name).split(/[-_.\s]+/).filter(Boolean);
  if (parts.length > 1) {
    return parts
      .slice(0, 3)
      .map((p) => (/^\d+$/.test(p) ? p : p[0]))
      .join('')
      .toUpperCase()
      .slice(0, 5);
  }
  const w = parts[0] ?? '';
  return (/\d/.test(w) ? w.slice(0, 4) : w.slice(0, 3)).toUpperCase();
}

/** The label to show in badges: explicit `short` or the derived one. */
export function shortLabel(host: Pick<HostConfig, 'short' | 'name'>): string {
  return host.short || autoShort(host.name);
}
