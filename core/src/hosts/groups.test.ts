import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HostGroupStore } from './groups';
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

test('upsert mints ids, dedupes hostIds, and persists', () => {
  const storage = memStorage();
  const store = new HostGroupStore(storage);
  const g = store.upsert({ name: 'Prod', color: 'red', icon: 'layers', hostIds: ['a', 'a', 'b'] });
  assert.ok(g.id);
  assert.deepEqual(g.hostIds, ['a', 'b']);
  assert.deepEqual(JSON.parse(storage.data!)[0].hostIds, ['a', 'b']);
});

test('setMembership toggles a host in a group', () => {
  const store = new HostGroupStore(memStorage());
  const g = store.upsert({ name: 'Lab', color: 'blue', icon: 'server', hostIds: [] });
  store.setMembership('h1', g.id, true);
  assert.deepEqual(store.get(g.id)?.hostIds, ['h1']);
  store.setMembership('h1', g.id, true); // idempotent
  assert.deepEqual(store.get(g.id)?.hostIds, ['h1']);
  store.setMembership('h1', g.id, false);
  assert.deepEqual(store.get(g.id)?.hostIds, []);
  store.setMembership('h1', 'nope', true); // unknown group: no-op
});

test('removeHostRefs prunes a host from every group', () => {
  const store = new HostGroupStore(memStorage());
  const a = store.upsert({ name: 'A', color: 'teal', icon: 'cpu', hostIds: ['h1', 'h2'] });
  const b = store.upsert({ name: 'B', color: 'amber', icon: 'lightning', hostIds: ['h1'] });
  store.removeHostRefs('h1');
  assert.deepEqual(store.get(a.id)?.hostIds, ['h2']);
  assert.deepEqual(store.get(b.id)?.hostIds, []);
});

test('corrupt storage degrades to no groups', () => {
  const store = new HostGroupStore(memStorage('{nope'));
  assert.deepEqual(store.list(), []);
});
