import type { HostConfig } from '../types';

/**
 * The plain `ssh` invocation equivalent to connecting to a host in Pear:
 * `ssh [-p N] [-J hop[,hop…]] user@host`. Jump hosts are resolved through
 * `lookup` following the `via` chain; OpenSSH wants them outermost first.
 * Returns '' for the local computer and exec sub-hosts (no SSH of their own).
 */
export function sshCommand(
  host: HostConfig,
  lookup: (id: string) => HostConfig | undefined,
): string {
  if (host.local || host.parentId) return '';
  const hops: string[] = [];
  const seen = new Set<string>([host.id]);
  let cursor = host.via ? lookup(host.via) : undefined;
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    hops.unshift(hopSpec(cursor));
    cursor = cursor.via ? lookup(cursor.via) : undefined;
  }
  const parts = ['ssh'];
  if (host.port !== 22) parts.push(`-p ${host.port}`);
  if (hops.length) parts.push(`-J ${hops.join(',')}`);
  parts.push(`${host.user}@${host.host}`);
  return parts.join(' ');
}

function hopSpec(h: HostConfig): string {
  return `${h.user}@${h.host}${h.port !== 22 ? `:${h.port}` : ''}`;
}
