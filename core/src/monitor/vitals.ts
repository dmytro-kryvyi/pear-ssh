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

export async function fetchVitals(exec: Exec): Promise<HostVitalsSample> {
  const result = await exec(VITALS_COMMAND);
  // The compound command exits with the last cat's status; judge by content,
  // not exit code — parseVitals throws VITALS_UNSUPPORTED when /proc is absent.
  return parseVitals(result.stdout);
}
