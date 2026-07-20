import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EphemeralHostRegistry } from './ephemeral';
import type { HostConfig } from '../types';

const sub = (over: Partial<HostConfig> = {}): Omit<HostConfig, 'id'> & { id?: string } => ({
  name: 'web',
  host: 'example.invalid',
  port: 22,
  user: 'root',
  kind: 'plain',
  parentId: 'h1',
  target: { type: 'docker', ref: 'web' },
  ...over,
});

test('add mints an id; restore keeps a provided one (pin/unpin round trip)', () => {
  const registry = new EphemeralHostRegistry();

  const minted = registry.add(sub());
  assert.ok(minted.id);
  registry.remove(minted.id); // "pinned" away

  const restored = registry.add(sub({ id: minted.id })); // "unpinned" back
  assert.equal(restored.id, minted.id);
  assert.equal(registry.get(minted.id)?.name, 'web');
});

test('removeByParent removes transitive descendants and reports their ids', () => {
  const registry = new EphemeralHostRegistry();
  const child = registry.add(sub({ parentId: 'h1' }));
  const grandchild = registry.add(sub({ name: 'inner', parentId: child.id }));
  const unrelated = registry.add(sub({ name: 'other', parentId: 'h2' }));

  const removed = registry.removeByParent('h1');

  assert.deepEqual(removed.sort(), [child.id, grandchild.id].sort());
  assert.equal(registry.get(child.id), undefined);
  assert.equal(registry.get(grandchild.id), undefined);
  assert.ok(registry.get(unrelated.id));
});

test('update only touches known entries', () => {
  const registry = new EphemeralHostRegistry();
  const entry = registry.add(sub());

  registry.update({ ...entry, kind: 'docker' });
  registry.update({ ...entry, id: 'ghost', kind: 'proxmox' });

  assert.equal(registry.get(entry.id)?.kind, 'docker');
  assert.equal(registry.get('ghost'), undefined);
  assert.equal(registry.list().length, 1);
});
