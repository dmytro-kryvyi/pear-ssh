import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import type { TransferJobSnapshot } from '@pear/core';
import { PearService } from '@pear/core/node';
import { WebSocketServer } from 'ws';
import { authenticate, sessionCookie, sessionToken } from './auth';
import { verifyPassword } from './auth/password';
import { LoginLimiter } from './auth/rate-limit';
import { SessionStore } from './auth/sessions';
import type { ServerConfig } from './config';
import { FileIo } from './file-io';
import { FileKeyCipher } from './file-key-cipher';
import { assertSafeToStart, Guard } from './security';
import { resolveUnder, sendFile, transformIndex } from './static';
import { UpdateCheck } from './update-check';
import { WsRpc } from './ws-rpc';

/** Reachable without logging in: the login page's own assets, and what the OS
 *  fetches cookie-less when adding the app to a home screen. */
const PUBLIC_FILES = new Set([
  '/login',
  '/login.css',
  '/login.js',
  '/manifest.webmanifest',
  '/favicon.svg',
]);
const isPublic = (path: string) => PUBLIC_FILES.has(path) || path.startsWith('/icons/');

export interface PearServer {
  readonly http: Server;
  readonly service: PearService;
  readonly rpc: WsRpc;
  readonly updates: UpdateCheck;
  listen(): Promise<{ port: number }>;
  close(): Promise<void>;
}

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('Body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function text(res: ServerResponse, status: number, body: string): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(body);
}

const REPO = 'dmytro-kryvyi/pear-ssh';

export interface PearServerOpts {
  /** Release version (`0.2.0`); defaults to the leading part of `build`. */
  version?: string;
  /** Test seam for the release check. */
  fetchJson?: (url: string) => Promise<unknown>;
}

export function createPearServer(
  config: ServerConfig,
  build = 'dev',
  opts: PearServerOpts = {},
): PearServer {
  const version = opts.version ?? build.split('-')[0];
  assertSafeToStart(config);
  const guard = new Guard(config);
  const sessions = new SessionStore(join(config.dataDir, 'sessions.json'));
  const limiter = new LoginLimiter();

  const features = () => ({
    localHost: config.enableLocalHost,
    sshConfig: true,
    claudePty: true,
    // Claude runs where the server runs — there is no "Claude host" to pick.
    claudeOnServer: true,
    reattach: true,
    browserFiles: true,
    hostKeys: config.verifyHostKeys,
    passwordAuth: config.auth === 'password',
  });

  // eslint-disable-next-line prefer-const -- rpc and service reference each other
  let service: PearService;
  // eslint-disable-next-line prefer-const -- assigned once the service exists
  let fileIo: FileIo;
  const updates = new UpdateCheck({
    current: version,
    repo: REPO,
    fetchJson: opts.fetchJson,
    // Devices that are connected right now hear about it at once; the rest
    // read it from the hello when they next connect.
    onUpdate: (info) => rpc.emit('server:update', info),
  });
  const rpc: WsRpc = new WsRpc(
    () => service,
    build,
    features,
    () => ({
      version,
      ...(updates.update ? { update: updates.update } : {}),
    }),
  );
  service = new PearService({
    dataDir: config.dataDir,
    cipher: config.storeSecrets
      ? FileKeyCipher.fromEnvOrFile(join(config.dataDir, 'secret.key'))
      : FileKeyCipher.disabled(),
    emit: (channel, ...args) => {
      if (channel === 'transfer:update') fileIo.onTransferUpdate(args[0] as TransferJobSnapshot);
      rpc.emit(channel, ...args);
    },
    sendUiRequest: (request) => rpc.sendUiRequest(request),
    features: { localHost: config.enableLocalHost },
    // A network service forwarding stored passwords must know who it talks to.
    verifyHostKeys: config.verifyHostKeys,
    termPolicy: {
      graceMs: config.sessionGraceMs,
      ringChars: config.termBufferChars,
      globalRingChars: Math.max(config.termBufferChars, 64 * 1024 * 1024),
      maxDetached: 32,
      exitedKeepMs: 5 * 60 * 1000,
    },
    warn: (message) => console.warn(message),
  });

  fileIo = new FileIo(service);

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    guard.applyHeaders(res);
    if (!guard.hostAllowed(req)) {
      return text(
        res,
        421,
        `Pear does not answer to "${req.headers.host ?? ''}".\n` +
          `If this is how you reach the server, start it with --public-url or --allow-host.\n`,
      );
    }
    const method = req.method ?? 'GET';
    const url = new URL(req.url ?? '/', 'http://pear.invalid');
    const path = url.pathname;
    const reading = method === 'GET' || method === 'HEAD';
    if (!reading && !guard.originAllowed(req, false))
      return text(res, 403, 'Cross-origin request refused\n');

    if (path === '/healthz') return text(res, 200, 'ok\n');

    if (path === '/api/login' && method === 'POST') {
      if (config.auth !== 'password')
        return json(res, 400, { error: 'Password login is not enabled' });
      const ip = guard.clientIp(req);
      const wait = limiter.retryAfter(ip);
      if (wait > 0) {
        res.setHeader('Retry-After', String(wait));
        return json(res, 429, { error: `Too many attempts. Try again in ${wait}s.` });
      }
      let password = '';
      try {
        password = String(
          (JSON.parse(await readBody(req, 4096)) as { password?: unknown }).password ?? '',
        );
      } catch {
        return json(res, 400, { error: 'Bad request' });
      }
      if (!(await verifyPassword(password, config.hashedPassword ?? ''))) {
        limiter.fail(ip);
        return json(res, 401, { error: 'Wrong password' });
      }
      limiter.succeed(ip);
      res.setHeader('Set-Cookie', sessionCookie(sessions.create(), guard.secureCookies));
      return json(res, 200, { ok: true });
    }

    if (path === '/api/logout' && method === 'POST') {
      sessions.revoke(sessionToken(req));
      res.setHeader('Set-Cookie', sessionCookie(null, guard.secureCookies));
      return json(res, 200, { ok: true });
    }

    const identity = authenticate(req, config, guard, sessions);

    if (path === '/login' && reading) {
      if (identity) {
        res.statusCode = 302;
        res.setHeader('Location', '/');
        return void res.end();
      }
      await sendFile(res, join(config.publicDir, 'login.html'), { head: method === 'HEAD' });
      return;
    }

    if (!identity && !isPublic(path)) {
      if (
        config.auth === 'password' &&
        reading &&
        req.headers['sec-fetch-dest'] !== 'empty' &&
        (req.headers.accept ?? '').includes('text/html')
      ) {
        res.statusCode = 302;
        res.setHeader('Location', '/login');
        return void res.end();
      }
      return text(
        res,
        401,
        config.auth === 'proxy'
          ? 'Not authenticated: no identity header from a trusted proxy.\n'
          : 'Not authenticated\n',
      );
    }

    // The client's "is my login still good?" probe: a browser cannot see why a
    // WebSocket handshake failed, but it can read this.
    if (path === '/api/session' && reading) {
      return json(res, 200, {
        auth: config.auth,
        ...(identity?.user ? { user: identity.user } : {}),
      });
    }
    if (path === '/api/upload' && method === 'POST')
      return fileIo.upload(req, res, url.searchParams);
    if (path.startsWith('/api/dl/') && method === 'GET') {
      return fileIo.download(res, decodeURIComponent(path.slice('/api/dl/'.length)));
    }
    if (path.startsWith('/api/')) return text(res, 404, 'Not found\n');
    if (!reading) return text(res, 405, 'Method not allowed\n');
    const head = method === 'HEAD';

    // Server-owned files first (boot.js, manifest, sw.js, icons, login assets).
    if (path !== '/') {
      const own = resolveUnder(config.publicDir, path);
      if (own && !own.endsWith('login.html') && (await sendFile(res, own, { head }))) return;
    }

    if (path === '/m') {
      res.statusCode = 301;
      res.setHeader('Location', '/m/');
      return void res.end();
    }
    const mobile = path.startsWith('/m/');
    const root = mobile ? config.mobileDir : config.uiDir;
    const rel = mobile ? path.slice(2) : path;
    const index = (html: string) => transformIndex(html, { mobile, build });
    if (rel === '/' || rel === '/index.html') {
      if (await sendFile(res, join(root, 'index.html'), { head, transform: index })) return;
      return text(
        res,
        503,
        `The ${mobile ? 'mobile' : 'desktop'} UI build is missing at ${root}.\nRun: npm run build${mobile ? ':mobile' : ''}\n`,
      );
    }
    const file = resolveUnder(root, rel);
    if (file && (await sendFile(res, file, { head }))) return;
    return text(res, 404, 'Not found\n');
  };

  const http = createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error('[http]', err);
      if (!res.headersSent) text(res, 500, 'Internal error\n');
      else res.destroy();
    });
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });
  const refuse = (socket: Duplex, status: string) => {
    socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  };
  http.on('upgrade', (req, socket, headBuf) => {
    socket.on('error', () => {});
    const path = new URL(req.url ?? '/', 'http://pear.invalid').pathname;
    if (path !== '/api/ws') return refuse(socket, '404 Not Found');
    if (!guard.hostAllowed(req)) return refuse(socket, '421 Misdirected Request');
    // Browsers attach cookies to cross-site WebSocket handshakes, and there is
    // no preflight. A missing or foreign Origin ends here, in every auth mode.
    if (!guard.originAllowed(req, true)) return refuse(socket, '403 Forbidden');
    const identity = authenticate(req, config, guard, sessions);
    if (!identity) return refuse(socket, '401 Unauthorized');
    wss.handleUpgrade(req, socket, headBuf, (ws) => rpc.accept(ws, identity.user));
  });

  // What the installer's --when-idle (and so the auto-update timer) reads: is
  // anybody's work running here that a restart would end? A file, because the
  // updater is another process with no login — and a status endpoint open to
  // it would be open to everyone.
  const statusFile = join(config.dataDir, 'status.json');
  let lastStatus = '';
  const writeStatus = async (): Promise<void> => {
    const chat = (await service.invoke('claude:chatState', []).catch(() => null)) as {
      busy?: boolean;
    } | null;
    const status = JSON.stringify({
      version,
      pid: process.pid,
      clients: rpc.clientCount,
      terminals: service.terms.list().filter((t) => !t.exited).length,
      claudeBusy: chat?.busy === true,
    });
    if (status === lastStatus) return;
    lastStatus = status;
    try {
      mkdirSync(config.dataDir, { recursive: true });
      writeFileSync(statusFile, status + '\n', { mode: 0o644 });
    } catch {
      /* a status nobody can read only means updates wait */
    }
  };
  let statusTimer: NodeJS.Timeout | null = null;

  return {
    http,
    service,
    rpc,
    updates,
    listen: () =>
      new Promise((resolve, reject) => {
        http.once('error', reject);
        http.listen(config.port, config.host, () => {
          http.off('error', reject);
          void service.start();
          void writeStatus();
          statusTimer = setInterval(() => void writeStatus(), 5_000);
          statusTimer.unref();
          if (config.updateCheck) updates.start();
          resolve({ port: (http.address() as { port: number }).port });
        });
      }),
    close: async () => {
      updates.stop();
      if (statusTimer) clearInterval(statusTimer);
      rpc.close();
      fileIo.dispose();
      wss.close();
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
      await service.dispose();
    },
  };
}
