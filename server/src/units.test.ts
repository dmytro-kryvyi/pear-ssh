import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashPassword, verifyPassword } from './auth/password';
import { LoginLimiter } from './auth/rate-limit';
import { SessionStore } from './auth/sessions';
import { defaultConfig, loadConfig, parseArgs, USAGE } from './config';
import { FileKeyCipher } from './file-key-cipher';
import { assertSafeToStart, hostnameOf } from './security';
import { resolveUnder, transformIndex } from './static';

const tmp = () => mkdtempSync(join(tmpdir(), 'pear-srv-'));

test('FileKeyCipher: round trip, tamper detection, 0600 key, reload', () => {
  const dir = tmp();
  const keyFile = join(dir, 'secret.key');
  const a = FileKeyCipher.fromEnvOrFile(keyFile, undefined);
  assert.equal(statSync(keyFile).mode & 0o777, 0o600);
  const blob = a.encrypt('hunter2 — ünïcode');
  assert.equal(blob.includes('hunter2'), false);
  assert.notEqual(a.encrypt('hunter2 — ünïcode'), blob); // fresh IV each time
  const b = FileKeyCipher.fromEnvOrFile(keyFile, undefined);
  assert.equal(b.decrypt(blob), 'hunter2 — ünïcode');

  const raw = Buffer.from(blob, 'base64');
  raw[raw.length - 1] ^= 1;
  assert.throws(() => b.decrypt(raw.toString('base64')));
  const other = FileKeyCipher.fromEnvOrFile(join(dir, 'other.key'), undefined);
  assert.throws(() => other.decrypt(blob));

  const envKey = Buffer.alloc(32, 7).toString('base64');
  assert.equal(FileKeyCipher.fromEnvOrFile(join(dir, 'unused'), envKey).available(), true);
  assert.throws(() => FileKeyCipher.fromEnvOrFile(keyFile, 'c2hvcnQ='), /32 bytes/);
  assert.equal(FileKeyCipher.disabled().available(), false);
  rmSync(dir, { recursive: true });
});

test('password hashing verifies and rejects', async () => {
  const hash = await hashPassword('correct horse');
  assert.match(hash, /^scrypt\$/);
  assert.equal(await verifyPassword('correct horse', hash), true);
  assert.equal(await verifyPassword('wrong', hash), false);
  assert.equal(await verifyPassword('x', ''), false);
  assert.equal(await verifyPassword('x', 'md5$whatever'), false);
});

test('LoginLimiter: burst window, recovery, success clears, global bucket', () => {
  let t = 0;
  const lim = new LoginLimiter(3, 10, 5, () => t);
  for (let i = 0; i < 3; i++) lim.fail('1.1.1.1');
  assert.ok(lim.retryAfter('1.1.1.1') > 0);
  assert.equal(lim.retryAfter('2.2.2.2'), 0);
  t += 61_000;
  assert.equal(lim.retryAfter('1.1.1.1'), 0);
  lim.fail('1.1.1.1');
  lim.succeed('1.1.1.1');
  assert.equal(lim.retryAfter('1.1.1.1'), 0);

  t += 3_600_000;
  for (let i = 0; i < 5; i++) lim.fail(`10.0.0.${i}`);
  assert.ok(lim.retryAfter('9.9.9.9') > 0); // a swarm of addresses still hits a wall
});

test('SessionStore: hashed at rest, survives a restart, revocable, expires', () => {
  const dir = tmp();
  const file = join(dir, 'sessions.json');
  let t = 1_000;
  const store = new SessionStore(file, () => t);
  const token = store.create();
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(require('node:fs').readFileSync(file, 'utf8').includes(token), false);
  assert.equal(new SessionStore(file, () => t).check(token), true);
  assert.equal(store.check('nope'), false);
  assert.equal(store.check(undefined), false);
  t += 31 * 24 * 3600 * 1000;
  assert.equal(store.check(token), false);
  const again = store.create();
  store.revoke(again);
  assert.equal(store.check(again), false);
  rmSync(dir, { recursive: true });
});

test('unauthenticated + reachable from the network refuses to start', () => {
  const base = defaultConfig();
  assert.throws(() => assertSafeToStart({ ...base, auth: 'none', host: '0.0.0.0' }), /Refusing/);
  assert.throws(
    () => assertSafeToStart({ ...base, auth: 'none', host: '192.168.1.5' }),
    /Refusing/,
  );
  assertSafeToStart({ ...base, auth: 'none', host: '127.0.0.1' });
  assertSafeToStart({ ...base, auth: 'none', host: '0.0.0.0', allowUnauthenticatedNetwork: true });
  assert.throws(() => assertSafeToStart({ ...base, auth: 'password' }), /needs a password/);
});

test('config: flags > env > file; first run mints a password and stores only its hash', async () => {
  const dir = tmp();
  const configPath = join(dir, 'config.json');
  const args = parseArgs([
    '--config',
    configPath,
    '--port',
    '9000',
    '--session-grace',
    '30m',
    '--term-buffer',
    '512k',
    '--allow-host',
    'Pear.LAN',
  ]);
  const first = await loadConfig(args, { PEAR_PORT: '8000', PEAR_HOST: '127.0.0.2' });
  assert.equal(first.config.port, 9000);
  assert.equal(first.config.host, '127.0.0.2');
  assert.equal(first.config.sessionGraceMs, 30 * 60_000);
  assert.equal(first.config.termBufferChars, 512 * 1024);
  assert.deepEqual(first.config.allowHosts, ['pear.lan']);
  assert.ok(first.generatedPassword);
  const onDisk = require('node:fs').readFileSync(configPath, 'utf8');
  assert.equal(onDisk.includes(first.generatedPassword as string), false);
  assert.equal(statSync(configPath).mode & 0o777, 0o600);

  const second = await loadConfig(args, {});
  assert.equal(second.generatedPassword, undefined);
  assert.equal(
    await verifyPassword(first.generatedPassword as string, second.config.hashedPassword as string),
    true,
  );

  const none = await loadConfig(parseArgs(['--config', join(dir, 'n.json'), '--auth', 'none']), {});
  assert.equal(none.generatedPassword, undefined);
  assert.equal(parseArgs(['--session-grace', 'inf']).overrides.sessionGraceMs, Infinity);
  assert.throws(() => parseArgs(['--auth', 'magic']), /none, password or proxy/);
  assert.throws(() => parseArgs(['--wat']), /Unknown option/);
  rmSync(dir, { recursive: true });
});

test('static: traversal is contained; index gets boot script and loses inline handlers', () => {
  assert.equal(resolveUnder('/srv/ui', '/../../etc/passwd'), '/srv/ui/etc/passwd');
  assert.equal(resolveUnder('/srv/ui', '/%2e%2e/%2e%2e/etc/passwd'), '/srv/ui/etc/passwd');
  assert.equal(resolveUnder('/srv/ui', '/a%00b'), null);
  assert.equal(resolveUnder('/srv/ui', '/%E0%A4%A'), null);
  const html = transformIndex(
    `<html><head>\n<link rel="stylesheet" href="styles-ABCDEFGH.css" media="print" onload="this.media='all'"></head></html>`,
    { mobile: false, build: 'b1' },
  );
  assert.equal(html.includes('onload='), false);
  assert.ok(html.indexOf('/boot.js') < html.indexOf('styles-ABCDEFGH.css'));
  assert.match(html, /<link rel="stylesheet" href="styles-ABCDEFGH\.css">/);
  assert.match(html, /name="pear-build" content="b1"/);
});

test('hostnameOf strips ports, including around IPv6 literals', () => {
  assert.equal(hostnameOf('Pear.ts.net:443'), 'pear.ts.net');
  assert.equal(hostnameOf('[::1]:7327'), '[::1]');
  assert.equal(hostnameOf('localhost'), 'localhost');
});

test('every flag the help text advertises is one the parser accepts', () => {
  const flags = [...USAGE.matchAll(/^\s+(--[a-z][a-z-]*)( <[^>]+>)?/gm)];
  assert.ok(flags.length > 15);
  // `--auth` is listed with literal values (`--auth password`), not a <placeholder>.
  for (const [, flag, arg] of flags) {
    const value =
      { '--auth': 'none', '--port': '1', '--session-grace': '1h', '--term-buffer': '1k' }[flag] ??
      'x';
    assert.doesNotThrow(
      () => parseArgs(arg || flag === '--auth' ? [flag, value] : [flag]),
      `${flag} is documented but rejected`,
    );
  }
  assert.equal(parseArgs(['--no-update-check']).overrides.updateCheck, false);
  assert.equal(parseArgs(['--no-verify-host-keys']).overrides.verifyHostKeys, false);
});
