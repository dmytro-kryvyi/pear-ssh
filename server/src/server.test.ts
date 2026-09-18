import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// eslint-disable-next-line import/no-internal-modules -- shared test fixture
import { startScratchSshd, type ScratchSshd } from '@pear/core/dist/node/testing/scratch-sshd';
import WebSocket from 'ws';
import { hashPassword } from './auth/password';
import { defaultConfig, type ServerConfig } from './config';
import { createPearServer, type PearServer } from './server';

let sshd: ScratchSshd;
let root: string;
const servers: PearServer[] = [];

before(async () => {
  sshd = await startScratchSshd();
  root = mkdtempSync(join(tmpdir(), 'pear-server-'));
  for (const name of ['ui', 'mobile']) {
    mkdirSync(join(root, name));
    writeFileSync(
      join(root, name, 'index.html'),
      `<html><head><title>${name}</title><link rel="stylesheet" href="styles-ABCDEFGH.css" media="print" onload="this.media='all'"></head></html>`,
    );
    writeFileSync(join(root, name, 'main-ABCDEFGH.js'), `/* ${name} */`);
  }
  writeFileSync(join(root, 'secret.txt'), 'outside the web root');
});
after(async () => {
  for (const s of servers) await s.close();
  sshd.close();
  rmSync(root, { recursive: true, force: true });
});

let n = 0;
async function boot(over: Partial<ServerConfig> = {}) {
  const config: ServerConfig = {
    ...defaultConfig(),
    port: 0,
    auth: 'none',
    verifyHostKeys: false, // the TOFU dance has its own tests
    dataDir: join(root, `data-${n++}`),
    uiDir: join(root, 'ui'),
    mobileDir: join(root, 'mobile'),
    ...over,
  };
  const server = createPearServer(config, 'test-build');
  servers.push(server);
  const { port } = await server.listen();
  return { server, port, config };
}

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}
function http(
  port: number,
  path: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: opts.method ?? 'GET',
        headers: { host: `127.0.0.1:${port}`, ...opts.headers },
      },
      (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    req.end(opts.body);
  });
}

/** A minimal protocol client: enough to prove the wire format. */
class Client {
  readonly events: { ev: string; a: unknown[] }[] = [];
  hello: { instanceId: string; user?: string; features: Record<string, boolean> } | null = null;
  private seq = 0;
  private readonly waiting = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  /** Everything received, in order — for ordering assertions. */
  readonly log: string[] = [];
  private constructor(readonly ws: WebSocket) {}

  static open(port: number, headers: Record<string, string> = {}): Promise<Client> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws`, {
        headers: { origin: `http://127.0.0.1:${port}`, ...headers },
      });
      const client = new Client(ws);
      ws.on('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
      ws.on('error', reject);
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.hello) {
          client.hello = msg.hello;
          return resolve(client);
        }
        if (msg.ev) {
          client.log.push(`ev ${msg.ev}`);
          return void client.events.push(msg);
        }
        client.log.push(`reply ${msg.id}`);
        const w = client.waiting.get(msg.id);
        client.waiting.delete(msg.id);
        if (msg.ok) w?.resolve(msg.v);
        else w?.reject(Object.assign(new Error(msg.e.message), { code: msg.e.code }));
      });
    });
  }

  call<T = unknown>(m: string, ...a: unknown[]): Promise<T> {
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.waiting.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.ws.send(JSON.stringify({ id, m, a }));
    });
  }
  fire(m: string, ...a: unknown[]): void {
    this.ws.send(JSON.stringify({ m, a }));
  }
  term(termId: string): string {
    return this.events
      .filter((e) => e.ev === 'term:data' && e.a[0] === termId)
      .map((e) => e.a[1])
      .join('');
  }
  lastSeq(termId: string): number {
    const d = this.events.filter((e) => e.ev === 'term:data' && e.a[0] === termId);
    return d.length ? (d[d.length - 1].a[2] as number) : 0;
  }
  close(): Promise<void> {
    return new Promise((resolve) => {
      this.ws.once('close', () => resolve());
      this.ws.close();
    });
  }
}

const settle = (ms = 250) => new Promise((r) => setTimeout(r, ms));
const SIZE = { cols: 80, rows: 24 };
const hostInput = () => ({
  name: 'loop',
  host: '127.0.0.1',
  port: sshd.port,
  user: 'tester',
  kind: 'plain',
  auth: { method: 'password', password: 'hunter2' },
});

// ---- the door ----------------------------------------------------------------

test('Host allowlist: a rebinding name gets 421, http and websocket alike', async () => {
  const { port } = await boot();
  assert.equal((await http(port, '/healthz')).status, 200);
  const evil = await http(port, '/', { headers: { host: 'evil.example' } });
  assert.equal(evil.status, 421);
  await assert.rejects(
    Client.open(port, { host: 'evil.example', origin: 'http://evil.example' }),
    /HTTP 421/,
  );

  const named = await boot({ publicUrl: 'https://pear.tailnet.ts.net/' });
  assert.equal(
    (await http(named.port, '/', { headers: { host: 'pear.tailnet.ts.net' } })).status,
    200,
  );
  const lan = await boot({ allowHosts: ['pear.lan'] });
  assert.equal((await http(lan.port, '/', { headers: { host: 'pear.lan:7327' } })).status, 200);
});

test('Origin: a foreign or missing Origin cannot open the socket or POST', async () => {
  const { port } = await boot();
  await assert.rejects(Client.open(port, { origin: 'https://evil.example' }), /HTTP 403/);
  await assert.rejects(
    new Promise((_r, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws`);
      ws.on('unexpected-response', (_q, res) => reject(new Error(`HTTP ${res.statusCode}`)));
      ws.on('error', reject);
    }),
    /HTTP 403/,
  );
  const post = await http(port, '/api/logout', {
    method: 'POST',
    headers: { origin: 'https://evil.example' },
  });
  assert.equal(post.status, 403);
  const ok = await Client.open(port);
  assert.equal(ok.hello?.features.claudeOnServer, true);
  await ok.close();
});

test('password auth: redirect, lockout, cookie flags, socket gate, restart keeps the login', async () => {
  const hashedPassword = await hashPassword('s3cret');
  const { port, config, server } = await boot({ auth: 'password', hashedPassword });

  const page = await http(port, '/', { headers: { accept: 'text/html' } });
  assert.equal(page.status, 302);
  assert.equal(page.headers.location, '/login');
  assert.equal((await http(port, '/main-ABCDEFGH.js')).status, 401);
  assert.equal((await http(port, '/login')).status, 200);
  assert.equal((await http(port, '/manifest.webmanifest')).status, 200); // iOS fetches it cookie-less
  await assert.rejects(Client.open(port), /HTTP 401/);

  const login = (password: string) =>
    http(port, '/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${port}` },
      body: JSON.stringify({ password }),
    });
  assert.equal((await login('nope')).status, 401);
  const good = await login('s3cret');
  assert.equal(good.status, 200);
  const setCookie = String(good.headers['set-cookie']);
  assert.match(setCookie, /^pear_session=[\w-]{40,}; /);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  assert.match(setCookie, /Path=\//);
  assert.doesNotMatch(setCookie, /Secure/); // plain http here
  const cookie = setCookie.split(';')[0];

  assert.equal((await http(port, '/', { headers: { cookie } })).status, 200);
  const authed = await Client.open(port, { cookie });
  await authed.close();

  // Same data dir, new process: the iPad must not be asked again.
  await server.close();
  servers.splice(servers.indexOf(server), 1);
  const reborn = await boot({ ...config, port: 0 });
  assert.equal((await http(reborn.port, '/', { headers: { cookie } })).status, 200);

  // Logout kills it server-side, not just in the browser.
  const out = await http(reborn.port, '/api/logout', {
    method: 'POST',
    headers: { cookie, origin: `http://127.0.0.1:${reborn.port}` },
  });
  assert.match(String(out.headers['set-cookie']), /Max-Age=0/);
  assert.equal((await http(reborn.port, '/main-ABCDEFGH.js', { headers: { cookie } })).status, 401);

  for (let i = 0; i < 5; i++)
    await http(reborn.port, '/api/login', {
      method: 'POST',
      body: '{"password":"x"}',
      headers: { origin: `http://127.0.0.1:${reborn.port}` },
    });
  const locked = await http(reborn.port, '/api/login', {
    method: 'POST',
    body: '{"password":"s3cret"}',
    headers: { origin: `http://127.0.0.1:${reborn.port}` },
  });
  assert.equal(locked.status, 429);
  assert.ok(Number(locked.headers['retry-after']) > 0);
});

test('https public URL: cookie becomes __Host- and Secure, HSTS is sent', async () => {
  const hashedPassword = await hashPassword('pw');
  const { port } = await boot({
    auth: 'password',
    hashedPassword,
    publicUrl: 'https://pear.tailnet.ts.net',
  });
  const res = await http(port, '/api/login', {
    method: 'POST',
    headers: { host: 'pear.tailnet.ts.net', origin: 'https://pear.tailnet.ts.net' },
    body: '{"password":"pw"}',
  });
  assert.equal(res.status, 200);
  assert.match(String(res.headers['set-cookie']), /^__Host-pear_session=.*; Secure/);
  assert.ok(res.headers['strict-transport-security']);
});

test('proxy auth: the identity header counts only from a trusted peer', async () => {
  const trusted = await boot({
    auth: 'proxy',
    proxyUserHeader: 'tailscale-user-login',
    allowUsers: ['me@example.com'],
  });
  assert.equal((await http(trusted.port, '/')).status, 401);
  assert.equal(
    (await http(trusted.port, '/', { headers: { 'tailscale-user-login': 'me@example.com' } }))
      .status,
    200,
  );
  assert.equal(
    (await http(trusted.port, '/', { headers: { 'tailscale-user-login': 'other@example.com' } }))
      .status,
    401,
  );
  const c = await Client.open(trusted.port, { 'tailscale-user-login': 'me@example.com' });
  assert.equal(c.hello?.user, 'me@example.com');
  await c.close();

  // Our test peer is 127.0.0.1; stop trusting it and the same header is noise.
  const untrusted = await boot({
    auth: 'proxy',
    proxyUserHeader: 'tailscale-user-login',
    trustedProxies: ['10.9.8.7'],
  });
  assert.equal(
    (await http(untrusted.port, '/', { headers: { 'tailscale-user-login': 'me@example.com' } }))
      .status,
    401,
  );
  await assert.rejects(
    Client.open(untrusted.port, { 'tailscale-user-login': 'me@example.com' }),
    /HTTP 401/,
  );
});

test('static: two UIs under one origin, hardened headers, nothing escapes the roots', async () => {
  const { port } = await boot();
  const desktop = await http(port, '/');
  assert.match(desktop.body, /<title>ui<\/title>/);
  assert.match(desktop.body, /<script src="\/boot\.js"><\/script>/);
  assert.equal(desktop.body.includes('onload='), false);
  assert.equal(desktop.headers['cache-control'], 'no-cache');
  assert.match(String(desktop.headers['content-security-policy']), /script-src 'self'/);
  assert.match(String(desktop.headers['content-security-policy']), /frame-ancestors 'none'/);
  assert.equal(desktop.headers['x-content-type-options'], 'nosniff');

  const m = await http(port, '/m');
  assert.equal(m.status, 301);
  assert.equal(m.headers.location, '/m/');
  assert.match((await http(port, '/m/')).body, /<title>mobile<\/title>/);
  const asset = await http(port, '/m/main-ABCDEFGH.js');
  assert.equal(asset.body, '/* mobile */');
  assert.match(String(asset.headers['cache-control']), /immutable/);

  assert.equal((await http(port, '/boot.js')).status, 200);
  assert.equal((await http(port, '/../secret.txt')).status, 404);
  assert.equal((await http(port, '/%2e%2e/secret.txt')).status, 404);
  assert.equal((await http(port, '/m/..%2f..%2fsecret.txt')).status, 404);
  assert.equal((await http(port, '/login.html')).status, 404); // only via /login
  assert.equal((await http(port, '/api/nope')).status, 404);
});

// ---- the work ------------------------------------------------------------------

test('rpc: hosts and a live terminal; the open reply precedes its first output', async () => {
  const { port } = await boot();
  const c = await Client.open(port);
  assert.equal(await c.call('ping'), 'pong');
  const host = await c.call<{ id: string; auth: Record<string, unknown> }>(
    'hosts:upsert',
    hostInput(),
  );
  assert.equal(host.auth.password, undefined);
  assert.equal(host.auth.hasPassword, true);

  const termId = await c.call<string>('term:open', host.id, SIZE);
  await settle();
  assert.match(c.term(termId), /motd-banner/);
  // Both UIs subscribe to onData only after `await open()` — so the reply to
  // the open (request 3) has to be on the wire before the first output.
  assert.ok(c.log.indexOf('reply 3') < c.log.indexOf('ev term:data'), c.log.join(', '));

  c.fire('term:write', termId, 'ping');
  c.fire('term:resize', termId, { cols: 132, rows: 43 });
  await settle();
  assert.match(c.term(termId), /echo:ping/);
  assert.deepEqual(sshd.lastResize(), { cols: 132, rows: 43 });
  assert.equal(c.lastSeq(termId), c.term(termId).length);

  await assert.rejects(c.call('no:such'), /Unknown method/);
  await assert.rejects(c.call('term:write', termId, 'x'), /Unknown method/); // send-only channel
  await assert.rejects(c.call('fs:list', 'ghost', '/'), /Unknown host/);
  c.fire('no:such');
  assert.equal(await c.call('ping'), 'pong');
  await c.close();
});

test('reattach: the terminal outlives its socket; delta and reset replays are exact', async () => {
  const { port, server } = await boot();
  const ipad = await Client.open(port);
  const host = await ipad.call<{ id: string }>('hosts:upsert', hostInput());
  const termId = await ipad.call<string>('term:open', host.id, SIZE);
  ipad.fire('term:write', termId, 'before');
  await settle();
  const seen = ipad.term(termId);
  const cursor = ipad.lastSeq(termId);
  assert.match(seen, /echo:before/);

  // iPadOS suspends the app: the socket just dies.
  ipad.ws.terminate();
  await settle(100);
  assert.equal(server.rpc.clientCount, 0);
  assert.equal(server.service.terms.list().find((t) => t.termId === termId)?.exited, false);

  // Output keeps arriving while nobody is watching.
  server.service.terms.write(termId, 'while-away');
  await settle();

  // Case 1 — same page, new socket: it knows where it got to.
  const back = await Client.open(port);
  assert.deepEqual(
    (await back.call<{ termId: string }[]>('term:list')).map((t) => t.termId),
    [termId],
  );
  const delta = await back.call<{ mode: string; seq: number }>('term:attach', termId, SIZE, cursor);
  await settle(100);
  assert.equal(delta.mode, 'delta');
  assert.equal(back.term(termId), 'echo:while-away');
  assert.equal(seen + back.term(termId), server.service.terms.read(termId, null)?.data);
  assert.ok(back.log.indexOf('reply 2') < back.log.indexOf('ev term:data'));

  // …and it is live again.
  back.fire('term:write', termId, 'after');
  await settle();
  assert.match(back.term(termId), /echo:after/);

  // Case 2 — the page itself was evicted: no cursor, full replay, flagged reset.
  const fresh = await Client.open(port);
  const reset = await fresh.call<{ mode: string }>(
    'term:attach',
    termId,
    { cols: 100, rows: 30 },
    null,
  );
  await settle();
  assert.equal(reset.mode, 'reset');
  const first = fresh.events.find((e) => e.ev === 'term:data');
  assert.equal(first?.a[3], true);
  assert.match(String(first?.a[1]), /motd-banner[\s\S]*echo:before[\s\S]*echo:after/);
  assert.deepEqual(sshd.lastResize(), { cols: 100, rows: 30 }); // jiggled back to the new size

  // Two devices, one terminal: both see output, either may type.
  fresh.fire('term:write', termId, 'both');
  await settle();
  assert.match(back.term(termId), /echo:both/);
  assert.match(fresh.term(termId), /echo:both/);

  // Closing it closes it for everyone.
  back.fire('term:close', termId);
  await settle();
  assert.ok(fresh.events.some((e) => e.ev === 'term:exit' && e.a[0] === termId));
  await assert.rejects(
    fresh.call('term:attach', 'gone', SIZE, 0),
    (e: Error & { code?: string }) => e.code === 'TERM_GONE',
  );
  await back.close();
  await fresh.close();
});

test('--session-grace 0 restores desktop semantics: last socket out, terminal closed', async () => {
  const { port, server } = await boot({ sessionGraceMs: 0 });
  const c = await Client.open(port);
  const host = await c.call<{ id: string }>('hosts:upsert', hostInput());
  await c.call<string>('term:open', host.id, SIZE);
  await settle(100);
  await c.close();
  await settle();
  assert.deepEqual(
    server.service.terms.list().filter((t) => !t.exited),
    [],
  );
});

test('events fan out to every device; UI requests go to the one driving Claude', async () => {
  const { port, server } = await boot();
  assert.equal(
    server.rpc.sendUiRequest({ id: 'r0', payload: { kind: 'listTerminals' } as never }),
    false,
  );
  const laptop = await Client.open(port);
  const ipad = await Client.open(port);
  server.rpc.emit('host:disconnected', 'h1');
  await settle(50);
  assert.ok(laptop.events.some((e) => e.ev === 'host:disconnected'));
  assert.ok(ipad.events.some((e) => e.ev === 'host:disconnected'));

  ipad.fire('claude:focus', null);
  await settle(50);
  assert.equal(
    server.rpc.sendUiRequest({ id: 'r1', payload: { kind: 'listTerminals' } as never }),
    true,
  );
  await settle(50);
  assert.ok(ipad.events.some((e) => e.ev === 'claude:uiRequest'));
  assert.equal(
    laptop.events.some((e) => e.ev === 'claude:uiRequest'),
    false,
  );
  await laptop.close();
  await ipad.close();
});

test('local host is off unless asked for', async () => {
  const off = await boot();
  const c = await Client.open(off.port);
  assert.equal(c.hello?.features.localHost, false);
  await assert.rejects(c.call('hosts:addLocal'), /disabled/);
  await c.close();
  const on = await boot({ enableLocalHost: true });
  const d = await Client.open(on.port);
  assert.equal((await d.call<{ local: boolean }>('hosts:addLocal')).local, true);
  await d.close();
});
