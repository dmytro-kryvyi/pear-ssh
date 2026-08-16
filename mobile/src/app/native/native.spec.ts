import { describe, expect, it } from 'vitest';
import type { PearApi } from '@pear/core';
import { SshEventHub } from './event-hub';
import { MobileHostStore } from './host-store';
import type { AsyncCipher, AsyncKv } from './kv';
import type {
  PearSshPlugin,
  SessionClosedEvent,
  ShellDataEvent,
  ShellExitEvent,
  SshConnectSpec,
} from './pear-ssh';
import { CapacitorSshTransport, toAuthSpec, type HostKeyGate } from './transport';
import { createNativeBackend } from './backend';
import type { HostConfig } from '@pear/core';

// ---------------------------------------------------------------- test dolls

/** Scriptable stand-in for the Kotlin plugin: records calls, emits events. */
class FakePlugin implements PearSshPlugin {
  calls: { method: string; args: unknown }[] = [];
  connectQueue: (() => Promise<{ sessionId: string }>)[] = [];
  private listeners = new Map<string, Set<(e: never) => void>>();
  private nextChannel = 0;

  emit(event: 'shellData', e: ShellDataEvent): void;
  emit(event: 'shellExit', e: ShellExitEvent): void;
  emit(event: 'sessionClosed', e: SessionClosedEvent): void;
  emit(event: string, e: unknown): void {
    for (const cb of this.listeners.get(event) ?? []) (cb as (x: unknown) => void)(e);
  }

  private record<T>(method: string, args: unknown, result: T): Promise<T> {
    this.calls.push({ method, args });
    return Promise.resolve(result);
  }

  argsOf(method: string): unknown[] {
    return this.calls.filter((c) => c.method === method).map((c) => c.args);
  }

  connect(spec: SshConnectSpec): Promise<{ sessionId: string }> {
    this.calls.push({ method: 'connect', args: spec });
    const impl = this.connectQueue.shift();
    return impl ? impl() : Promise.resolve({ sessionId: 's1' });
  }
  disconnect(o: { sessionId: string }) { return this.record('disconnect', o, undefined as void); }
  isConnected(o: { sessionId: string }) { return this.record('isConnected', o, { connected: true }); }
  forgetHostKey(o: { host: string; port: number }) { return this.record('forgetHostKey', o, undefined as void); }
  probe(o: { host: string; port: number }) { return this.record('probe', o, { ms: 7 }); }
  exec(o: { sessionId: string; command: string }) {
    return this.record('exec', o, { code: 0, stdout: '', stderr: '' });
  }
  shellOpen(o: object) { return this.record('shellOpen', o, { channelId: `ch${++this.nextChannel}` }); }
  shellWrite(o: object) { return this.record('shellWrite', o, undefined as void); }
  shellResize(o: object) { return this.record('shellResize', o, undefined as void); }
  shellClose(o: object) { return this.record('shellClose', o, undefined as void); }
  sftpList(o: { path: string }) {
    return this.record('sftpList', o, {
      path: '/srv',
      entries: [{ name: 'a.txt', kind: 'file' as const, size: 3, mtimeMs: 1000, mode: '-rw-r--r--' }],
    });
  }
  sftpRead(o: object) { return this.record('sftpRead', o, { content: 'hello' }); }
  sftpWrite(o: object) { return this.record('sftpWrite', o, undefined as void); }
  sftpStat(o: object) { return this.record('sftpStat', o, { exists: false }); }
  sftpMkdir(o: object) { return this.record('sftpMkdir', o, undefined as void); }
  sftpRemove(o: object) { return this.record('sftpRemove', o, undefined as void); }
  sftpRename(o: object) { return this.record('sftpRename', o, undefined as void); }
  sftpCopy(o: object) { return this.record('sftpCopy', o, undefined as void); }
  sftpHash(o: object) { return this.record('sftpHash', o, { hash: 'ab'.repeat(32) }); }
  cipherAvailable() { return this.record('cipherAvailable', {}, { available: true }); }
  cipherEncrypt(o: { plain: string }) { return this.record('cipherEncrypt', o, { cipher: `enc:${o.plain}` }); }
  cipherDecrypt(o: { cipher: string }) {
    return this.record('cipherDecrypt', o, { plain: o.cipher.replace(/^enc:/, '') });
  }
  addListener(event: string, cb: (e: never) => void) {
    const set = this.listeners.get(event) ?? new Set();
    set.add(cb);
    this.listeners.set(event, set);
    return Promise.resolve({ remove: async () => void set.delete(cb) });
  }
}

class MemKv implements AsyncKv {
  readonly map = new Map<string, string>();
  async get(key: string) { return this.map.get(key) ?? null; }
  async set(key: string, value: string) { this.map.set(key, value); }
}

const fakeCipher: AsyncCipher = {
  available: async () => true,
  encrypt: async (plain) => `enc:${plain}`,
  decrypt: async (cipher) => {
    if (!cipher.startsWith('enc:')) throw new Error('bad blob');
    return cipher.slice(4);
  },
};

const yesGate: HostKeyGate = { confirm: async () => true };
const noGate: HostKeyGate = { confirm: async () => false };

function rejection(code: string, data: Record<string, string>) {
  return () => Promise.reject({ message: code, code, data });
}

function host(over: Partial<HostConfig> = {}): HostConfig {
  return {
    id: 'h1',
    name: 'edge',
    host: '10.0.0.1',
    port: 22,
    user: 'root',
    kind: 'server',
    ...over,
  } as HostConfig;
}

function transport(plugin: FakePlugin, gate: HostKeyGate = yesGate, cfg?: Partial<HostConfig>) {
  return new CapacitorSshTransport(host(cfg), { plugin, hub: new SshEventHub(plugin), gate });
}

const tick = () => new Promise((r) => setTimeout(r, 0));

// ------------------------------------------------------------------- tests

describe('toAuthSpec', () => {
  it('maps explicit methods and refuses agent', () => {
    expect(toAuthSpec({ method: 'password', password: 'pw' })).toEqual({
      method: 'password',
      password: 'pw',
    });
    expect(toAuthSpec({ method: 'key', privateKey: 'PEM', passphrase: 'x' })).toEqual({
      method: 'key',
      privateKey: 'PEM',
      passphrase: 'x',
    });
    expect(() => toAuthSpec({ method: 'agent' })).toThrow(/agent/);
  });

  it('legacy chain prefers key text, falls back to password', () => {
    expect(toAuthSpec({ privateKey: 'PEM' }).method).toBe('key');
    expect(toAuthSpec({ password: 'pw' })).toEqual({ method: 'password', password: 'pw' });
    expect(toAuthSpec(undefined).method).toBe('key');
  });
});

describe('CapacitorSshTransport TOFU', () => {
  it('unknown key: gate approves, retries with the fingerprint, connects', async () => {
    const plugin = new FakePlugin();
    plugin.connectQueue = [rejection('UNKNOWN_HOST_KEY', { fingerprint: 'SHA256:abc', keyType: 'ssh-ed25519' })];
    const t = transport(plugin);
    await t.connect();
    expect(t.isConnected).toBe(true);
    const specs = plugin.argsOf('connect') as SshConnectSpec[];
    expect(specs).toHaveLength(2);
    expect(specs[0].trustFingerprint).toBeUndefined();
    expect(specs[1].trustFingerprint).toBe('SHA256:abc');
  });

  it('unknown key: gate refuses, connect fails, no retry', async () => {
    const plugin = new FakePlugin();
    plugin.connectQueue = [rejection('UNKNOWN_HOST_KEY', { fingerprint: 'SHA256:abc' })];
    const t = transport(plugin, noGate);
    await expect(t.connect()).rejects.toThrow(/not trusted/);
    expect(plugin.argsOf('connect')).toHaveLength(1);
  });

  it('changed key: forgets the old key before re-trusting', async () => {
    const plugin = new FakePlugin();
    plugin.connectQueue = [
      rejection('HOST_KEY_CHANGED', { fingerprint: 'SHA256:new', knownFingerprint: 'SHA256:old' }),
    ];
    const t = transport(plugin);
    await t.connect();
    expect(plugin.argsOf('forgetHostKey')).toEqual([{ host: '10.0.0.1', port: 22 }]);
    const specs = plugin.argsOf('connect') as SshConnectSpec[];
    expect(specs[1].trustFingerprint).toBe('SHA256:new');
  });

  it('other errors surface as plain errors', async () => {
    const plugin = new FakePlugin();
    plugin.connectQueue = [() => Promise.reject({ message: 'auth failed', code: 'AUTH_FAILED' })];
    await expect(transport(plugin).connect()).rejects.toThrow('auth failed');
  });
});

describe('shell channels over the event hub', () => {
  it('routes data per channel, buffers pre-subscription chunks, signals close', async () => {
    const plugin = new FakePlugin();
    const t = transport(plugin);
    await t.connect();
    const ch = await t.shell({ cols: 80, rows: 24 });

    plugin.emit('shellData', { channelId: 'ch1', data: 'early ' });
    const seen: string[] = [];
    let closed = false;
    ch.onData((chunk) => seen.push(chunk));
    ch.onClose(() => (closed = true));
    plugin.emit('shellData', { channelId: 'ch1', data: 'late' });
    plugin.emit('shellData', { channelId: 'other', data: 'noise' });
    plugin.emit('shellExit', { channelId: 'ch1', code: 0 });

    expect(seen.join('')).toBe('early late');
    expect(closed).toBe(true);

    ch.write('ls\n');
    ch.resize({ cols: 120, rows: 40 });
    await tick();
    expect(plugin.argsOf('shellWrite')).toEqual([{ channelId: 'ch1', data: 'ls\n' }]);
    expect(plugin.argsOf('shellResize')).toEqual([{ channelId: 'ch1', cols: 120, rows: 40 }]);
  });

  it('sessionClosed flips isConnected and fires onClose', async () => {
    const plugin = new FakePlugin();
    const t = transport(plugin);
    await t.connect();
    let closed = false;
    t.onClose(() => (closed = true));
    plugin.emit('sessionClosed', { sessionId: 's1' });
    expect(t.isConnected).toBe(false);
    expect(closed).toBe(true);
  });
});

describe('MobileHostStore secrets', () => {
  it('encrypts write-only secrets; sanitized views carry only has-flags', async () => {
    const kv = new MemKv();
    const store = await MobileHostStore.load(kv, fakeCipher);
    const saved = await store.upsert({
      ...host(),
      id: undefined,
      auth: { method: 'password', password: 'hunter2', privateKey: 'PEM' },
    } as never);

    expect(saved.auth?.password).toBeUndefined();
    expect(saved.auth?.hasPassword).toBe(true);
    expect(saved.auth?.hasPrivateKey).toBe(true);

    const persisted = (JSON.parse(kv.map.get('pear.hosts')!) as HostConfig[])[0];
    expect(persisted.auth?.password).toBeUndefined();
    expect(persisted.auth?.privateKey).toBeUndefined();
    expect(persisted.auth?.passwordEnc).toBe('enc:hunter2');
    expect(persisted.auth?.privateKeyEnc).toBe('enc:PEM');

    const decrypted = await store.decryptAuth(store.get(saved.id)!);
    expect(decrypted.auth?.password).toBe('hunter2');
    expect(decrypted.auth?.privateKey).toBe('PEM');
  });

  it('undefined keeps a stored secret, empty string clears it', async () => {
    const kv = new MemKv();
    const store = await MobileHostStore.load(kv, fakeCipher);
    const saved = await store.upsert({
      ...host(),
      id: undefined,
      auth: { method: 'password', password: 'first' },
    } as never);

    await store.upsert({ ...store.get(saved.id)!, auth: { method: 'password' } });
    expect((await store.decryptAuth(store.get(saved.id)!)).auth?.password).toBe('first');

    await store.upsert({ ...store.get(saved.id)!, auth: { method: 'password', password: '' } });
    expect((await store.decryptAuth(store.get(saved.id)!)).auth?.password).toBeUndefined();
  });

  it('mints endpoints and keeps host/port synced to the primary', async () => {
    const kv = new MemKv();
    const store = await MobileHostStore.load(kv, fakeCipher);
    const saved = await store.upsert({ ...host(), id: undefined } as never);
    expect(saved.endpoints).toHaveLength(1);
    expect(saved.endpoints![0].addr).toBe('10.0.0.1');
  });
});

describe('NativeSshBackend', () => {
  function backend(plugin: FakePlugin) {
    return createNativeBackend({ plugin, gate: yesGate, kv: new MemKv(), cipher: fakeCipher });
  }

  async function withHost(api: PearApi): Promise<string> {
    const saved = await api.hosts.upsert({
      ...host(),
      id: undefined,
      auth: { method: 'password', password: 'pw' },
    } as never);
    return saved.id;
  }

  it('fs.list connects with decrypted auth and maps the listing', async () => {
    const plugin = new FakePlugin();
    const api = backend(plugin);
    const id = await withHost(api);

    const listing = await api.fs.list(id, '/srv');
    expect(listing.path).toBe('/srv');
    expect(listing.entries[0].name).toBe('a.txt');

    const spec = (plugin.argsOf('connect')[0] as SshConnectSpec);
    expect(spec.auth).toEqual({ method: 'password', password: 'pw' });
    expect(spec.host).toBe('10.0.0.1');
  });

  it('terminals ride SessionManager and surface data/exit events', async () => {
    const plugin = new FakePlugin();
    const api = backend(plugin);
    const id = await withHost(api);

    const chunks: string[] = [];
    const exits: string[] = [];
    api.term.onData((termId, data) => chunks.push(`${termId}:${data}`));
    api.term.onExit((termId) => exits.push(termId));

    const termId = await api.term.open(id, { cols: 80, rows: 24 });
    plugin.emit('shellData', { channelId: 'ch1', data: 'motd' });
    expect(chunks).toEqual([`${termId}:motd`]);

    api.term.write(termId, 'ls\n');
    await tick();
    expect(plugin.argsOf('shellWrite')).toContainEqual({ channelId: 'ch1', data: 'ls\n' });

    plugin.emit('shellExit', { channelId: 'ch1', code: 0 });
    expect(exits).toEqual([termId]);
  });

  it('probe maps latency and error shapes', async () => {
    const plugin = new FakePlugin();
    const api = backend(plugin);
    expect(await api.hosts.probe({ addr: 'x', port: 22 })).toEqual({ ok: true, latencyMs: 7 });

    plugin.probe = () => Promise.reject({ message: 'connect timed out' });
    expect(await api.hosts.probe({ addr: 'x', port: 22 })).toMatchObject({
      ok: false,
      error: 'timeout',
    });
  });

  it('reused connections do not redial', async () => {
    const plugin = new FakePlugin();
    const api = backend(plugin);
    const id = await withHost(api);
    await api.fs.list(id, '/srv');
    await api.fs.read(id, '/srv/a.txt');
    expect(plugin.argsOf('connect')).toHaveLength(1);
  });
});
