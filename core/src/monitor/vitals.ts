import type { CpuTicks, HostVitalsSample, MountUsage, NetIfaceCounters } from '../types';
import type { Exec } from '../orchestration/orchestration';

/**
 * Everything the vitals band needs in one exec round-trip. Sections are
 * separated by `=Pn` marker lines so a missing tool (df) or file degrades
 * that section alone. `df -Pk` is POSIX and busybox-safe (GNU `-B1` is not).
 * The markers are quoted: unquoted `=P1` trips zsh's `=command` expansion.
 */
export const VITALS_COMMAND =
  `cat /proc/stat; echo '=P1'; cat /proc/meminfo; echo '=P2'; cat /proc/loadavg; ` +
  `echo '=P3'; cat /proc/uptime; echo '=P4'; uname -r; echo '=P5'; LC_ALL=C df -Pk 2>/dev/null; ` +
  `echo '=P6'; cat /proc/net/dev`;

/** Thrown (by message) when the host has no readable /proc — non-Linux etc. */
export const VITALS_UNSUPPORTED = 'vitals unsupported';

// user nice system idle iowait irq softirq steal — guest/guest_nice are
// already accounted inside user, so they're excluded from the total.
function parseCpuLine(line: string): CpuTicks | null {
  const fields = line.trim().split(/\s+/).slice(1, 9).map(Number);
  if (fields.length < 4 || fields.some((n) => !Number.isFinite(n))) return null;
  const idle = fields[3] + (fields[4] ?? 0);
  return { idle, total: fields.reduce((a, b) => a + b, 0) };
}

function memField(section: string, name: string): number | null {
  const m = section.match(new RegExp(`^${name}:\\s+(\\d+)`, 'm'));
  return m ? Number(m[1]) : null;
}

// Pseudo-filesystems never worth a usage bar. Anything not matching the
// "real device" heuristics below is dropped too; this list only documents
// the common offenders.
const REAL_FS = (fs: string): boolean =>
  fs.startsWith('/dev/') || fs.includes(':') || fs.startsWith('//');

function parseMounts(section: string): MountUsage[] {
  const rows: MountUsage[] = [];
  for (const line of section.split('\n').slice(1)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 6) continue;
    const [fs, total, used] = [parts[0], Number(parts[1]), Number(parts[2])];
    const mount = parts.slice(5).join(' ');
    if (!Number.isFinite(total) || !Number.isFinite(used) || total <= 0) continue;
    rows.push({ fs, mount, totalKB: total, usedKB: used });
  }
  // Dedupe bind mounts by device, keeping the shortest mountpoint.
  const byDevice = new Map<string, MountUsage>();
  for (const r of rows.filter((r) => REAL_FS(r.fs))) {
    const prev = byDevice.get(r.fs);
    if (!prev || r.mount.length < prev.mount.length) byDevice.set(r.fs, r);
  }
  const real = [...byDevice.values()].sort((a, b) => a.mount.localeCompare(b.mount));
  if (real.length > 0) return real;
  // Container sub-hosts mount / as overlay — better one synthetic-looking row
  // than an empty disk card.
  return rows.filter((r) => r.mount === '/');
}

function parseNet(section: string): NetIfaceCounters[] {
  const out: NetIfaceCounters[] = [];
  for (const line of section.split('\n')) {
    const m = line.match(/^\s*([^\s:]+):\s*(.*)$/);
    if (!m) continue;
    const name = m[1];
    if (name === 'lo') continue;
    const nums = m[2].trim().split(/\s+/).map(Number);
    if (nums.length < 16) continue;
    out.push({ name, rxBytes: nums[0], txBytes: nums[8] });
  }
  return out;
}

export function parseVitals(stdout: string): HostVitalsSample {
  const [stat, meminfo, loadavg, uptime, uname, df, netdev] = stdout.split(/^=P\d\r?$/m);

  const cpu = stat != null ? parseCpuLine((stat.match(/^cpu\s.*$/m) ?? [''])[0]) : null;
  if (!cpu) throw new Error(VITALS_UNSUPPORTED);
  const cores = (stat.match(/^cpu\d+\s.*$/gm) ?? [])
    .map(parseCpuLine)
    .filter((c): c is CpuTicks => c != null);

  const load = (loadavg ?? '').trim().split(/\s+/).slice(0, 3).map(Number);
  const memTotalKB = memField(meminfo ?? '', 'MemTotal') ?? 0;
  const memAvailableKB =
    memField(meminfo ?? '', 'MemAvailable') ??
    (memField(meminfo ?? '', 'MemFree') ?? 0) +
      (memField(meminfo ?? '', 'Buffers') ?? 0) +
      (memField(meminfo ?? '', 'Cached') ?? 0);

  return {
    at: Date.now(),
    cpu,
    cores,
    loadavg: [load[0] || 0, load[1] || 0, load[2] || 0],
    uptimeSec: Number((uptime ?? '').trim().split(/\s+/)[0]) || 0,
    kernel: (uname ?? '').trim(),
    memTotalKB,
    memAvailableKB,
    swapTotalKB: memField(meminfo ?? '', 'SwapTotal') ?? 0,
    swapFreeKB: memField(meminfo ?? '', 'SwapFree') ?? 0,
    mounts: parseMounts(df ?? ''),
    net: parseNet(netdev ?? ''),
  };
}

/** Human/model-ready rates derived from two samples — see summarizeVitals. */
export interface VitalsSummary {
  cpuPercent: number;
  corePercents: number[];
  loadavg: [number, number, number];
  uptimeSec: number;
  kernel: string;
  mem: { totalKB: number; usedKB: number; usedPercent: number };
  swap: { totalKB: number; usedKB: number };
  mounts: Array<MountUsage & { usedPercent: number }>;
  net: Array<{ name: string; rxBytesPerSec: number; txBytesPerSec: number }>;
}

function cpuPercent(a: CpuTicks | undefined, b: CpuTicks | undefined): number {
  if (!a || !b) return 0;
  const total = b.total - a.total;
  if (total <= 0) return 0;
  return Math.min(100, Math.max(0, (1 - (b.idle - a.idle) / total) * 100));
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

/**
 * Rates between two samples of the same host (`a` earlier, `b` later). CPU and
 * network are cumulative counters, so a single sample cannot yield a
 * percentage — callers grab two ~1s apart. Static fields come from `b`.
 */
export function summarizeVitals(a: HostVitalsSample, b: HostVitalsSample): VitalsSummary {
  const dtSec = Math.max(0.001, (b.at - a.at) / 1000);
  const memUsedKB = Math.max(0, b.memTotalKB - b.memAvailableKB);
  const byName = new Map(a.net.map((n) => [n.name, n]));
  return {
    cpuPercent: round1(cpuPercent(a.cpu, b.cpu)),
    corePercents: b.cores.map((core, i) => round1(cpuPercent(a.cores[i], core))),
    loadavg: b.loadavg,
    uptimeSec: b.uptimeSec,
    kernel: b.kernel,
    mem: {
      totalKB: b.memTotalKB,
      usedKB: memUsedKB,
      usedPercent: b.memTotalKB > 0 ? round1((memUsedKB / b.memTotalKB) * 100) : 0,
    },
    swap: { totalKB: b.swapTotalKB, usedKB: Math.max(0, b.swapTotalKB - b.swapFreeKB) },
    mounts: b.mounts.map((m) => ({
      ...m,
      usedPercent: m.totalKB > 0 ? round1((m.usedKB / m.totalKB) * 100) : 0,
    })),
    net: b.net.map((n) => {
      const prev = byName.get(n.name);
      return {
        name: n.name,
        rxBytesPerSec: prev ? Math.max(0, Math.round((n.rxBytes - prev.rxBytes) / dtSec)) : 0,
        txBytesPerSec: prev ? Math.max(0, Math.round((n.txBytes - prev.txBytes) / dtSec)) : 0,
      };
    }),
  };
}

export async function fetchVitals(exec: Exec): Promise<HostVitalsSample> {
  const result = await exec(VITALS_COMMAND);
  // The compound command exits with the last cat's status; judge by content,
  // not exit code — parseVitals throws VITALS_UNSUPPORTED when /proc is absent.
  return parseVitals(result.stdout);
}
