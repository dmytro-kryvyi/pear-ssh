import type { TransferJobSnapshot } from '@pear/core';

export type SizeUnits = 'binary' | 'decimal';

const BINARY = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
const DECIMAL = ['B', 'KB', 'MB', 'GB', 'TB'];

/** Human byte count honouring the user's unit preference (Settings). */
export function fmtBytes(n: number | null | undefined, units: SizeUnits = 'binary'): string {
  if (n == null || !Number.isFinite(n)) return '—';
  const base = units === 'binary' ? 1024 : 1000;
  const names = units === 'binary' ? BINARY : DECIMAL;
  let v = n;
  let i = 0;
  while (v >= base && i < names.length - 1) {
    v /= base;
    i++;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${names[i]}`;
}

export function fmtRate(bytesPerSec: number | null | undefined, units: SizeUnits = 'binary'): string {
  if (bytesPerSec == null) return '—';
  return `${fmtBytes(bytesPerSec, units)}/s`;
}

/** `32s`, `3m 05s`, `1h 12m`; empty for unknown. */
export function fmtSeconds(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec) || sec < 0) return '';
  const s = Math.round(sec);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
}

/** Wall-clock span of a finished job, from the engine's timestamps. */
export function fmtDuration(job: TransferJobSnapshot): string {
  if (job.startedAt == null || job.finishedAt == null) return '';
  return fmtSeconds((job.finishedAt - job.startedAt) / 1000);
}

/** One mono line for the toast: `812 MiB / 2.0 GiB · 38 MiB/s · 32s`. */
export function compactProgress(job: TransferJobSnapshot, units: SizeUnits): string {
  if (job.status !== 'running' || !job.bytesTotal) return '';
  const parts = [`${fmtBytes(job.bytesDone, units)} / ${fmtBytes(job.bytesTotal, units)}`];
  if (job.bytesPerSec) parts.push(fmtRate(job.bytesPerSec, units));
  const eta = fmtSeconds(job.etaSec);
  if (eta) parts.push(eta);
  return parts.join(' · ');
}
