import type { HostColor } from '@pear/core';

/** Workspace/host accent palette — resolved oklch per named color (design data.jsx). */
export const WS_COLORS: Record<HostColor, string> = {
  red: 'oklch(0.68 0.16 25)',
  amber: 'oklch(0.78 0.14 75)',
  green: 'oklch(0.74 0.14 150)',
  teal: 'oklch(0.72 0.09 190)',
  blue: 'oklch(0.70 0.12 245)',
  violet: 'oklch(0.68 0.14 300)',
};

export function wsColor(c: HostColor | undefined): string {
  return c ? WS_COLORS[c] : 'var(--border)';
}

const GB = 1024 ** 3;

export function fmtBytes(n: number | null | undefined): string {
  if (n == null) return '—';
  if (n >= GB) return `${(n / GB).toFixed(n >= 10 * GB ? 0 : 1)} GB`;
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

/** "8.0 / 16 GB" pair used by orch cards. */
export function fmtMemPair(used: number | null, total: number | null): string {
  if (used == null || total == null) return '—';
  return `${(used / GB).toFixed(1)} / ${Math.round(total / GB)} GB`;
}

export function fmtPct(fraction: number | null | undefined): string {
  return fraction == null ? '—' : `${Math.round(fraction * 100)}%`;
}

export function fmtUptime(sec: number): string {
  if (!sec) return '—';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  if (d > 0) return `${d}d ${h}h`;
  const m = Math.floor((sec % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export function fmtMtime(ms: number): string {
  const d = new Date(ms);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[d.getMonth()]} ${d.getDate()}`;
}

/** Deterministic pseudo-load used by mock gauges (design orch.jsx). */
export function seedHash(str: string): number {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return h;
}
export const pseudoCpu = (name: string) => ((seedHash(name) % 46) + 2) / 100;
export const pseudoMemFrac = (name: string) => ((seedHash(name + 'm') % 70) + 8) / 100;
