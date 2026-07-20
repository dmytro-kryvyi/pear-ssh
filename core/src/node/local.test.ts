import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { readFile as fsReadFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { LocalConnection } from './local';

/**
 * LocalConnection against the real machine: /bin/sh, node:fs, and node-pty.
 * Mirrors the behavioural contract connection.test.ts establishes for the
 * ssh2 transport.
 */

function conn(): LocalConnection {
  const c = new LocalConnection();
  void c.connect();
  return c;
}

test('exec runs through a shell and reports code/stdout/stderr', async () => {
  const c = conn();
  const ok = await c.exec('echo out; echo err >&2');
  assert.equal(ok.code, 0);
  assert.equal(ok.stdout, 'out\n');
  assert.equal(ok.stderr, 'err\n');

  const fail = await c.exec('exit 3');
  assert.equal(fail.code, 3);
});

test('listDir resolves ~ to home and decodes entry kinds', async () => {
  const c = conn();
  const home = await c.listDir('~');
  assert.equal(home.path, homedir());

  const dir = mkdtempSync(join(tmpdir(), 'pear-local-'));
  writeFileSync(join(dir, 'a.txt'), 'hello');
  const listing = await c.listDir(dir);
  const entry = listing.entries.find((e) => e.name === 'a.txt');
  assert.ok(entry);
  assert.equal(entry.kind, 'file');
  assert.equal(entry.size, 5);
  assert.match(entry.mode, /^-r/);
});

test('readFile/writeFile roundtrip and size cap', async () => {
  const c = conn();
  const dir = mkdtempSync(join(tmpdir(), 'pear-local-'));
  const file = join(dir, 'note.txt');
  await c.writeFile(file, 'contents');
  assert.equal(await c.readFile(file), 'contents');
  await assert.rejects(c.readFile(file, 3), /too large/);
});

test('upload copies into the target directory', async () => {
  const c = conn();
  const src = mkdtempSync(join(tmpdir(), 'pear-src-'));
  const dst = mkdtempSync(join(tmpdir(), 'pear-dst-'));
  const local = join(src, 'payload.bin');
  writeFileSync(local, 'data');
  const dest = await c.upload(local, dst);
  assert.equal(dest, join(dst, 'payload.bin'));
  assert.equal(await fsReadFile(dest, 'utf8'), 'data');
});

test('shellCommand runs in a PTY and closes on exit', async () => {
  const c = conn();
  const channel = await c.shellCommand('echo pty-says-hi', { cols: 80, rows: 24 });
  let out = '';
  channel.onData((chunk) => (out += chunk));
  await new Promise<void>((resolve) => channel.onClose(resolve));
  assert.match(out, /pty-says-hi/);
});

test('shell is interactive and resize reaches the PTY', async () => {
  const c = conn();
  const channel = await c.shell({ cols: 80, rows: 24 });
  let out = '';
  channel.onData((chunk) => (out += chunk));
  channel.resize({ cols: 100, rows: 30 });
  channel.write('stty size; exit\n');
  await new Promise<void>((resolve) => channel.onClose(resolve));
  assert.match(out, /30 100/);
});

test('dispose kills live PTYs and fires onClose once', async () => {
  const c = conn();
  let closed = 0;
  c.onClose(() => closed++);
  const channel = await c.shell({ cols: 80, rows: 24 });
  let channelClosed = false;
  channel.onClose(() => (channelClosed = true));
  c.dispose();
  c.dispose();
  assert.equal(closed, 1);
  assert.equal(c.isConnected, false);
  // The killed PTY reports its exit asynchronously.
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(channelClosed, true);
});
