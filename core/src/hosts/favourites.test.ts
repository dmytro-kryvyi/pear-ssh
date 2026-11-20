import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FavouriteStore } from './favourites';
import type { HostStorage } from './store';

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

test('upsert mints an id and persists', () => {
  const storage = memStorage();
  const store = new FavouriteStore(storage);
  const f = store.upsert({ hostId: 'h1', path: '/srv/www' });
  assert.ok(f.id);
  assert.deepEqual(JSON.parse(storage.data!), [{ id: f.id, hostId: 'h1', path: '/srv/www' }]);
  assert.deepEqual(new FavouriteStore(storage).list(), [f]);
});

test('saving the same host and path twice returns the first entry', () => {
  const store = new FavouriteStore(memStorage());
  const a = store.upsert({ hostId: 'h1', path: '/srv/www', label: 'Site' });
  const b = store.upsert({ hostId: 'h1', path: '/srv/www/' });
  assert.deepEqual(b, a);
  assert.equal(store.list().length, 1);
  store.upsert({ hostId: 'h2', path: '/srv/www' }); // same path, other host
  assert.equal(store.list().length, 2);
});

test('upsert with an id renames; a blank label falls back to none', () => {
  const store = new FavouriteStore(memStorage());
  const f = store.upsert({ hostId: 'h1', path: '/etc' });
  assert.equal(store.upsert({ ...f, label: ' Config ' }).label, 'Config');
  assert.equal(store.list()[0].label, 'Config');
  assert.equal('label' in store.upsert({ ...f, label: '  ' }), false);
  assert.equal(store.list().length, 1);
});

test('rejects a relative path or a missing host', () => {
  const store = new FavouriteStore(memStorage());
  assert.throws(() => store.upsert({ hostId: 'h1', path: '~' }));
  assert.throws(() => store.upsert({ hostId: '', path: '/etc' }));
  assert.equal(store.upsert({ hostId: 'h1', path: '/' }).path, '/');
});

test('remove and removeHostRefs', () => {
  const store = new FavouriteStore(memStorage());
  const a = store.upsert({ hostId: 'h1', path: '/a' });
  store.upsert({ hostId: 'h1', path: '/b' });
  const c = store.upsert({ hostId: 'h2', path: '/c' });
  store.remove(a.id);
  assert.equal(store.list().length, 2);
  store.removeHostRefs('h1');
  assert.deepEqual(store.list(), [c]);
});

test('corrupt or foreign storage degrades to an empty list', () => {
  assert.deepEqual(new FavouriteStore(memStorage('{nope')).list(), []);
  assert.deepEqual(new FavouriteStore(memStorage('{"a":1}')).list(), []);
  assert.deepEqual(new FavouriteStore(memStorage('[{"id":1}, null]')).list(), []);
});
