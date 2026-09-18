import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { hashPassword } from './auth/password';

export type AuthMode = 'none' | 'password' | 'proxy';

export interface ServerConfig {
  host: string;
  port: number;
  dataDir: string;
  auth: AuthMode;
  /** `scrypt$…` — never the plaintext. */
  hashedPassword?: string;
  /** The URL people type, e.g. https://pear.tailnet.ts.net — feeds the Host
   *  allowlist and decides whether cookies are marked Secure. */
  publicUrl?: string;
  /** Extra Host header values to accept (LAN names, raw IPs). */
  allowHosts: string[];
  /** Peers whose X-Forwarded-* and identity headers are believed. */
  trustedProxies: string[];
  /** proxy auth: the header carrying the authenticated user. */
  proxyUserHeader: string;
  /** proxy auth: if non-empty, only these users get in. */
  allowUsers: string[];
  allowUnauthenticatedNetwork: boolean;
  /** How long terminals outlive their last client, ms. Infinity = forever. */
  sessionGraceMs: number;
  /** Scrollback kept per terminal for replay, in characters. */
  termBufferChars: number;
  enableLocalHost: boolean;
  storeSecrets: boolean;
  /** Trust-on-first-use for SSH host keys. On unless explicitly disabled. */
  verifyHostKeys: boolean;
  /** Ask GitHub once a day whether a newer release exists (it only notifies). */
  updateCheck: boolean;
  uiDir: string;
  mobileDir: string;
  publicDir: string;
}

const REPO = resolve(__dirname, '../..');

export function defaultConfig(): ServerConfig {
  const xdgData = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
  return {
    host: '127.0.0.1',
    port: 7327,
    dataDir: join(xdgData, 'pear-server'),
    auth: 'password',
    allowHosts: [],
    trustedProxies: ['127.0.0.1', '::1'],
    proxyUserHeader: 'x-forwarded-user',
    allowUsers: [],
    allowUnauthenticatedNetwork: false,
    sessionGraceMs: 12 * 60 * 60 * 1000,
    termBufferChars: 2 * 1024 * 1024,
    enableLocalHost: false,
    storeSecrets: true,
    verifyHostKeys: true,
    updateCheck: true,
    uiDir: join(REPO, 'ui/dist/ui/browser'),
    mobileDir: join(REPO, 'mobile/dist/mobile/browser'),
    publicDir: join(REPO, 'server/public'),
  };
}

export function defaultConfigPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(xdg, 'pear-server', 'config.json');
}

export const USAGE = `pear-server — Pear as a web app, for devices that cannot run it natively

Usage: pear-server [options]

  --host <addr>            Address to bind (default 127.0.0.1)
  --port <n>               Port (default 7327)
  --data-dir <dir>         Hosts, history, keys (default ~/.local/share/pear-server)
  --config <file>          Config file (default ~/.config/pear-server/config.json)
  --public-url <url>       The URL users open, e.g. https://pear.example.ts.net

Access control — pick how the door is guarded:
  --auth password          A password (default). Generated and printed on first run;
                           or set PEAR_PASSWORD / PEAR_HASHED_PASSWORD.
  --auth none              No login. For servers reachable only through something
                           that already authenticates: Tailscale, a VPN, Cloudflare
                           Access. Refuses non-loopback binds unless you add
                           --allow-unauthenticated-network.
  --auth proxy             Trust an identity header set by your reverse proxy.
  --proxy-user-header <h>  That header (default X-Forwarded-User;
                           Tailscale Serve sends Tailscale-User-Login)
  --allow-user <name>      proxy auth: restrict to these users (repeatable)
  --trusted-proxy <cidr>   Peers allowed to set forwarded/identity headers
                           (repeatable; default loopback)
  --allow-host <host>      Extra Host header to accept (repeatable)
  --reset-password         Generate, store and print a new password, then exit

Sessions:
  --session-grace <dur>    Keep terminals alive this long after the last client
                           leaves: 30m, 12h (default), 0 (close at once), inf
  --term-buffer <size>     Scrollback replayed on reattach: 2m (default), 512k

Hardening:
  --enable-local-host      Offer the server machine itself as a host (a shell as
                           the server's user)
  --no-store-secrets       Never write host passwords/keys to disk; prompt instead
  --no-verify-host-keys    Accept any SSH host key without asking (not recommended:
                           stored passwords would go to whoever answers)

  --no-update-check        Don't ask GitHub daily whether a newer release exists
                           (the check only shows a notice; it never installs)

  -h, --help               This text
`;

function parseDuration(v: string): number {
  if (/^(inf|infinity|forever)$/i.test(v)) return Infinity;
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/.exec(v);
  if (!m) throw new Error(`Bad duration: ${v} (try 30m, 12h, 0, inf)`);
  const unit = { ms: 1, s: 1e3, m: 6e4, h: 36e5, d: 864e5 }[m[2] ?? 's'] as number;
  return Number(m[1]) * unit;
}

function parseSize(v: string): number {
  const m = /^(\d+)([km])?$/i.exec(v);
  if (!m) throw new Error(`Bad size: ${v} (try 512k, 2m)`);
  return Number(m[1]) * ({ k: 1024, m: 1024 * 1024 }[m[2]?.toLowerCase() ?? ''] ?? 1);
}

export interface ParsedArgs {
  overrides: Partial<ServerConfig>;
  configPath: string;
  help: boolean;
  resetPassword: boolean;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const o: Partial<ServerConfig> = {};
  const out: ParsedArgs = {
    overrides: o,
    configPath: defaultConfigPath(),
    help: false,
    resetPassword: false,
  };
  const list = (key: 'allowHosts' | 'trustedProxies' | 'allowUsers', v: string) => {
    o[key] = [...(o[key] ?? []), v];
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${flag} needs a value`);
      return v;
    };
    switch (flag) {
      case '-h':
      case '--help':
        out.help = true;
        break;
      case '--host':
        o.host = value();
        break;
      case '--port':
        o.port = Number(value());
        break;
      case '--data-dir':
        o.dataDir = resolve(value());
        break;
      case '--config':
        out.configPath = resolve(value());
        break;
      case '--public-url':
        o.publicUrl = value();
        break;
      case '--auth': {
        const v = value();
        if (v !== 'none' && v !== 'password' && v !== 'proxy') {
          throw new Error(`--auth must be none, password or proxy (got ${v})`);
        }
        o.auth = v;
        break;
      }
      case '--proxy-user-header':
        o.proxyUserHeader = value().toLowerCase();
        break;
      case '--allow-user':
        list('allowUsers', value());
        break;
      case '--trusted-proxy':
        list('trustedProxies', value());
        break;
      case '--allow-host':
        list('allowHosts', value().toLowerCase());
        break;
      case '--allow-unauthenticated-network':
        o.allowUnauthenticatedNetwork = true;
        break;
      case '--reset-password':
        out.resetPassword = true;
        break;
      case '--session-grace':
        o.sessionGraceMs = parseDuration(value());
        break;
      case '--term-buffer':
        o.termBufferChars = parseSize(value());
        break;
      case '--enable-local-host':
        o.enableLocalHost = true;
        break;
      case '--no-store-secrets':
        o.storeSecrets = false;
        break;
      case '--no-verify-host-keys':
        o.verifyHostKeys = false;
        break;
      case '--no-update-check':
        o.updateCheck = false;
        break;
      case '--ui-dir':
        o.uiDir = resolve(value());
        break;
      case '--mobile-dir':
        o.mobileDir = resolve(value());
        break;
      default:
        throw new Error(`Unknown option: ${flag} (see --help)`);
    }
  }
  return out;
}

function readConfigFile(path: string): Partial<ServerConfig> {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Partial<ServerConfig>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error(`Cannot read ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function writeConfigFile(path: string, patch: Partial<ServerConfig>): void {
  const merged = { ...readConfigFile(path), ...patch };
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(merged, null, 2) + '\n', { mode: 0o600 });
  chmodSync(path, 0o600);
}

export interface LoadedConfig {
  config: ServerConfig;
  /** Set when this run minted a password — print it once, it is not stored. */
  generatedPassword?: string;
}

/** Precedence: flags > environment > config file > defaults. */
export async function loadConfig(
  args: ParsedArgs,
  env: NodeJS.ProcessEnv = process.env,
): Promise<LoadedConfig> {
  const file = readConfigFile(args.configPath);
  const fromEnv: Partial<ServerConfig> = {};
  if (env.PEAR_HOST) fromEnv.host = env.PEAR_HOST;
  if (env.PEAR_PORT) fromEnv.port = Number(env.PEAR_PORT);
  if (env.PEAR_DATA_DIR) fromEnv.dataDir = resolve(env.PEAR_DATA_DIR);
  if (env.PEAR_PUBLIC_URL) fromEnv.publicUrl = env.PEAR_PUBLIC_URL;
  if (env.PEAR_AUTH === 'none' || env.PEAR_AUTH === 'password' || env.PEAR_AUTH === 'proxy') {
    fromEnv.auth = env.PEAR_AUTH;
  }
  if (env.PEAR_UPDATE_CHECK === '0' || env.PEAR_UPDATE_CHECK === 'false')
    fromEnv.updateCheck = false;
  if (env.PEAR_HASHED_PASSWORD) fromEnv.hashedPassword = env.PEAR_HASHED_PASSWORD;

  const config: ServerConfig = { ...defaultConfig(), ...file, ...fromEnv, ...args.overrides };
  if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535) {
    throw new Error(`Bad port: ${config.port}`);
  }
  if (config.publicUrl) config.publicUrl = new URL(config.publicUrl).origin;

  let generatedPassword: string | undefined;
  if (config.auth === 'password' || args.resetPassword) {
    if (env.PEAR_PASSWORD && !args.resetPassword) {
      config.hashedPassword = await hashPassword(env.PEAR_PASSWORD);
    } else if (!config.hashedPassword || args.resetPassword) {
      generatedPassword = randomBytes(18).toString('base64url');
      config.hashedPassword = await hashPassword(generatedPassword);
      writeConfigFile(args.configPath, { hashedPassword: config.hashedPassword });
    }
  }
  return { config, generatedPassword };
}
