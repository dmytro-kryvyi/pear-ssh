import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HostStore, sanitizeHost, type HostStorage, type SecretCipher } from './store';
import type { HostConfig } from '../types';

const memStorage = (initial: string | null = null): HostStorage & { data: string | null } => {
  const s = {
    data: initial,
    read: () => s.data,
    write: (d: string) => {
      s.data = d;
    },
  };
  return s;
};

/** Reversible fake cipher: base64 with a marker prefix. */
const fakeCipher = (available = true): SecretCipher => ({
  available: () => available,
  encrypt: (plain) => 'enc:' + Buffer.from(plain).toString('base64'),
  decrypt: (cipher) => {
    if (!cipher.startsWith('enc:')) throw new Error('bad ciphertext');
    return Buffer.from(cipher.slice(4), 'base64').toString();
  },
});

const base = (over: Partial<HostConfig> = {}): Omit<HostConfig, 'id'> & { id?: string } => ({
  name: 'web',
  host: 'example.invalid',
  port: 22,
  user: 'root',
  kind: 'plain',
  ...over,
});

test('load migrates legacy tag to tags and mints endpoints', () => {
  const storage = memStorage(
    JSON.stringify([{ id: 'h1', name: 'web', host: '10.0.0.5', port: 2200, user: 'root', kind: 'plain', tag: 'prod' }]),
  );
  const store = new HostStore(storage);
  const h = store.get('h1')!;
  assert.deepEqual(h.tags, ['prod']);
  assert.equal(h.tag, undefined);
  assert.equal(h.endpoints?.length, 1);
  assert.equal(h.endpoints![0].addr, '10.0.0.5');
  assert.equal(h.endpoints![0].port, 2200);
  // migration was flushed
  const onDisk = JSON.parse(storage.data!)[0];
  assert.deepEqual(onDisk.tags, ['prod']);
  assert.equal(onDisk.tag, undefined);
  assert.equal(onDisk.endpoints.length, 1);
});

test('local hosts and sub-hosts never get endpoints', () => {
  const storage = memStorage(
    JSON.stringify([
      { id: 'l1', name: 'laptop', host: 'localhost', port: 0, user: 'me', kind: 'plain', local: true },
      { id: 's1', name: 'ct', host: 'ct', port: 22, user: 'root', kind: 'plain', parentId: 'h1', target: { type: 'docker', ref: 'ct' } },
    ]),
  );
  const store = new HostStore(storage);
  assert.equal(store.get('l1')!.endpoints, undefined);
  assert.equal(store.get('s1')!.endpoints, undefined);
});

test('host/port mirror endpoints[0] on upsert', () => {
  const store = new HostStore(memStorage());
  const saved = store.upsert(
    base({
      endpoints: [
        { id: 'e1', addr: 'lan.local', port: 22 },
        { id: 'e2', addr: 'public.example', port: 2222 },
      ],
    }),
  );
  assert.equal(saved.host, 'lan.local');
  assert.equal(saved.port, 22);
});

test('plaintext passphrase on disk is encrypted on load and leaves the file', () => {
  const storage = memStorage(
    JSON.stringify([
      { id: 'h1', name: 'w', host: 'x', port: 22, user: 'u', kind: 'plain', auth: { privateKeyPath: '/k', passphrase: 'sekret' } },
    ]),
  );
  const store = new HostStore(storage, fakeCipher());
  const onDisk = JSON.parse(storage.data!)[0];
  assert.equal(onDisk.auth.passphrase, undefined);
  assert.ok(onDisk.auth.passphraseEnc.startsWith('enc:'));
  assert.equal(store.decryptAuth(store.get('h1')!).auth?.passphrase, 'sekret');
});

test('plaintext passphrase without cipher stays in memory but never persists', () => {
  const storage = memStorage(
    JSON.stringify([{ id: 'h1', name: 'w', host: 'x', port: 22, user: 'u', kind: 'plain', auth: { passphrase: 'sekret' } }]),
  );
  const store = new HostStore(storage, fakeCipher(false));
  assert.equal(store.get('h1')!.auth?.passphrase, 'sekret'); // usable this session
  store.upsert({ ...store.get('h1')! }); // any save
  assert.equal(JSON.parse(storage.data!)[0].auth.passphrase, undefined);
});

test('write-only merge: undefined preserves, empty clears, value replaces', () => {
  const storage = memStorage();
  const store = new HostStore(storage, fakeCipher());
  const saved = store.upsert(base({ auth: { method: 'password', password: 'pw1' } }));
  assert.equal(saved.auth?.password, undefined); // sanitized return
  assert.equal(saved.auth?.hasPassword, true);
  assert.equal(JSON.parse(storage.data!)[0].auth.password, undefined);

  // undefined -> preserved
  store.upsert({ ...store.get(saved.id)!, auth: { method: 'password' } });
  assert.equal(store.decryptAuth(store.get(saved.id)!).auth?.password, 'pw1');

  // value -> replaced
  store.upsert({ ...store.get(saved.id)!, auth: { method: 'password', password: 'pw2' } });
  assert.equal(store.decryptAuth(store.get(saved.id)!).auth?.password, 'pw2');

  // '' -> cleared
  store.upsert({ ...store.get(saved.id)!, auth: { method: 'password', password: '' } });
  assert.equal(store.decryptAuth(store.get(saved.id)!).auth?.password, undefined);
  assert.equal(store.get(saved.id)!.auth?.passwordEnc, undefined);
});

test('incoming ciphertext and has-flags from callers are ignored', () => {
  const store = new HostStore(memStorage(), fakeCipher());
  const saved = store.upsert(base({ auth: { passwordEnc: 'enc:forged', hasPassword: true } as never }));
  const full = store.get(saved.id)!;
  assert.equal(full.auth?.passwordEnc, undefined);
  assert.equal(sanitizeHost(full).auth?.hasPassword, undefined);
});

test('decryptAuth degrades to no secret on undecryptable ciphertext', () => {
  const storage = memStorage(
    JSON.stringify([{ id: 'h1', name: 'w', host: 'x', port: 22, user: 'u', kind: 'plain', auth: { passwordEnc: 'garbage' } }]),
  );
  const store = new HostStore(storage, fakeCipher());
  assert.equal(store.decryptAuth(store.get('h1')!).auth?.password, undefined);
});

test('listSanitized exposes has-flags but no secret material', () => {
  const store = new HostStore(memStorage(), fakeCipher());
  store.upsert(base({ auth: { method: 'key', privateKeyPath: '/k', passphrase: 'x' } }));
  const [h] = store.listSanitized();
  assert.equal(h.auth?.passphrase, undefined);
  assert.equal(h.auth?.passphraseEnc, undefined);
  assert.equal(h.auth?.hasPassphrase, true);
  assert.equal(h.auth?.privateKeyPath, '/k');
});
