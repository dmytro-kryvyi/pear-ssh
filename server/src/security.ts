import type { IncomingMessage, ServerResponse } from 'node:http';
import { BlockList, isIP } from 'node:net';
import type { ServerConfig } from './config';

const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

/** Strip the port: "pear.ts.net:443" → "pear.ts.net", "[::1]:80" → "[::1]". */
export function hostnameOf(hostHeader: string): string {
  const h = hostHeader.trim().toLowerCase();
  if (h.startsWith('[')) return h.slice(0, h.indexOf(']') + 1);
  const colon = h.lastIndexOf(':');
  return colon === -1 ? h : h.slice(0, colon);
}

export function isLoopbackBind(host: string): boolean {
  return host === 'localhost' || host === '::1' || /^127\./.test(host);
}

function toBlockList(entries: string[]): BlockList {
  const list = new BlockList();
  for (const entry of entries) {
    const [addr, prefix] = entry.split('/');
    const family = isIP(addr) === 6 ? 'ipv6' : 'ipv4';
    if (!isIP(addr)) throw new Error(`Bad --trusted-proxy entry: ${entry}`);
    if (prefix === undefined) list.addAddress(addr, family);
    else list.addSubnet(addr, Number(prefix), family);
  }
  return list;
}

/**
 * The checks that hold whatever the auth mode. They matter most when there is
 * no login at all: a server on loopback with `--auth none` is precisely what
 * DNS rebinding and cross-site WebSocket hijacking go looking for.
 */
export class Guard {
  private readonly proxies: BlockList;
  private readonly allowedHosts: Set<string>;
  /** Enforce the Host allowlist? See {@link hostAllowed}. */
  private readonly strictHost: boolean;
  readonly secureCookies: boolean;

  constructor(private readonly config: ServerConfig) {
    this.proxies = toBlockList(config.trustedProxies);
    this.allowedHosts = new Set([...LOOPBACK_HOSTS, ...config.allowHosts]);
    if (config.publicUrl) this.allowedHosts.add(new URL(config.publicUrl).hostname.toLowerCase());
    if (isIP(config.host) && !/^(0\.0\.0\.0|::)$/.test(config.host)) {
      this.allowedHosts.add(isIP(config.host) === 6 ? `[${config.host}]` : config.host);
    }
    // With a password, a rebinding page gains nothing: the session cookie is
    // scoped to the real host name and never sent to the attacker's. Without
    // one (none, proxy) the Host header is the only thing telling the two apart.
    this.strictHost =
      config.auth !== 'password' || !!config.publicUrl || config.allowHosts.length > 0;
    this.secureCookies = config.publicUrl?.startsWith('https:') ?? false;
  }

  isTrustedProxy(req: IncomingMessage): boolean {
    const addr = normalizeAddr(req.socket.remoteAddress);
    return !!addr && this.proxies.check(addr, isIP(addr) === 6 ? 'ipv6' : 'ipv4');
  }

  /** Who is really calling — X-Forwarded-For is believed only from a trusted proxy. */
  clientIp(req: IncomingMessage): string {
    const peer = normalizeAddr(req.socket.remoteAddress) ?? 'unknown';
    if (!this.isTrustedProxy(req)) return peer;
    const xff = String(req.headers['x-forwarded-for'] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    return xff.length ? xff[xff.length - 1] : peer;
  }

  hostAllowed(req: IncomingMessage): boolean {
    const host = req.headers.host;
    if (!host) return false;
    return !this.strictHost || this.allowedHosts.has(hostnameOf(host));
  }

  /**
   * Same-origin check for anything state-changing, and for every WebSocket
   * upgrade (browsers attach cookies to cross-site WebSocket handshakes and
   * no CORS preflight stands in the way — Origin is the only defence).
   * `requireOrigin`: upgrades must carry one; plain non-browser POSTs may not.
   */
  originAllowed(req: IncomingMessage, requireOrigin: boolean): boolean {
    const origin = req.headers.origin;
    if (!origin) return !requireOrigin;
    try {
      return new URL(origin).host.toLowerCase() === String(req.headers.host).toLowerCase();
    } catch {
      return false;
    }
  }

  applyHeaders(res: ServerResponse): void {
    res.setHeader(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        "script-src 'self'",
        // Angular component styles and xterm both inject <style>/style="".
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "font-src 'self' data:",
        "worker-src 'self' blob:", // Monaco
        "connect-src 'self'",
        "frame-ancestors 'none'",
        "base-uri 'self'",
        "form-action 'self'",
      ].join('; '),
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    if (this.secureCookies) {
      res.setHeader('Strict-Transport-Security', 'max-age=15552000');
    }
  }
}

function normalizeAddr(addr: string | undefined): string | undefined {
  return addr?.startsWith('::ffff:') ? addr.slice(7) : addr;
}

/** Start-up sanity: refuse the configurations that are open doors. */
export function assertSafeToStart(config: ServerConfig): void {
  if (
    config.auth === 'none' &&
    !isLoopbackBind(config.host) &&
    !config.allowUnauthenticatedNetwork
  ) {
    throw new Error(
      `Refusing to serve without authentication on ${config.host}.\n` +
        `  Anyone who can reach that address would get your SSH hosts and keys.\n` +
        `  • Keep --host 127.0.0.1 and put Tailscale Serve / a reverse proxy in front, or\n` +
        `  • use --auth password, or\n` +
        `  • pass --allow-unauthenticated-network if the network itself is the gate\n` +
        `    (a container port published only to a VPN interface, say).`,
    );
  }
  if (config.auth === 'password' && !config.hashedPassword) {
    throw new Error('--auth password needs a password (PEAR_PASSWORD or the config file)');
  }
}
