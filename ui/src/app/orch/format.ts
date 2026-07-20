// Shared formatting helpers for orchestration views.

export function pctText(fraction: number | null): string {
  if (fraction == null) return '—';
  return `${Math.round(fraction * 100)}%`;
}

export function pctNum(fraction: number | null): number {
  return fraction == null ? 0 : Math.round(fraction * 100);
}

/** Fill-bar tone thresholds matching the design. */
export function tone(pct: number): 'accent' | 'warn' | 'err' {
  return pct >= 88 ? 'err' : pct >= 70 ? 'warn' : 'accent';
}

export function bytes(n: number | null): string {
  if (n == null) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export function memPair(used: number | null, max: number | null): string {
  if (used == null) return '—';
  return max ? `${bytes(used)} / ${bytes(max)}` : bytes(used);
}

export function memPct(used: number | null, max: number | null): number {
  if (used == null || !max) return 0;
  return Math.round((used / max) * 100);
}

export function uptime(seconds: number): string {
  if (!seconds) return 'offline';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  if (days > 0) return `${days}d ${hours}h`;
  const mins = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${mins}m`;
}
