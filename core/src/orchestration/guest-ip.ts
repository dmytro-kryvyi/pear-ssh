// Parses `qm guest cmd <vmid> network-get-interfaces` (QEMU guest agent).
// Used by "Add as SSH host" to prefill a promoted VM's address.

interface GuestInterface {
  name?: string;
  'ip-addresses'?: {
    'ip-address'?: string;
    'ip-address-type'?: 'ipv4' | 'ipv6';
  }[];
}

/**
 * Pick the address to SSH to: the first non-loopback IPv4, falling back to
 * the first global IPv6. Returns null when the JSON is malformed or the guest
 * reports no usable address.
 */
export function parseGuestIp(json: string): string | null {
  let interfaces: GuestInterface[];
  try {
    // qm prints the interface array directly; raw QGA wraps it in "return"
    // (and some pvesh formats use "result").
    const parsed = JSON.parse(json) as
      | GuestInterface[]
      | { return?: GuestInterface[]; result?: GuestInterface[] };
    const unwrapped = Array.isArray(parsed) ? parsed : (parsed.return ?? parsed.result);
    if (!Array.isArray(unwrapped)) return null;
    interfaces = unwrapped;
  } catch {
    return null;
  }
  let v6: string | null = null;
  for (const iface of interfaces) {
    if (iface.name === 'lo') continue;
    for (const addr of iface['ip-addresses'] ?? []) {
      const ip = addr['ip-address'];
      if (!ip || ip.startsWith('127.') || ip === '::1') continue;
      if (addr['ip-address-type'] === 'ipv4') return ip;
      if (addr['ip-address-type'] === 'ipv6' && !ip.startsWith('fe80') && !v6) v6 = ip;
    }
  }
  return v6;
}
