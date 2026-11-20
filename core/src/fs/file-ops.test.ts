import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planCopy, planDelete } from './file-ops';

test('planDelete removes the named entries of one directory', () => {
  const plan = planDelete('/srv/data', ['a.txt', "it's", '-rf']);
  assert.equal(plan.kind, 'delete');
  assert.equal(plan.command, `cd -- '/srv/data' && rm -rf -- 'a.txt' 'it'\\''s' '-rf'`);
  assert.equal(plan.label, 'Delete 3 items');
  assert.deepEqual(plan.dirs, ['/srv/data']);
  assert.equal(planDelete('/x', ['one']).label, 'Delete one');
  for (const bad of ['', '.', '..', 'a/b'])
    assert.throws(() => planDelete('/x', [bad]), /Not a file name/);
  assert.throws(() => planDelete('/x', []), /Nothing to delete/);
});

test('planCopy chains cp -a, replacing a destination only when asked', () => {
  const plan = planCopy(
    [
      { from: '/a/one', to: '/b/one' },
      { from: '/a/two', to: '/b/two', replace: true },
    ],
    false,
  );
  assert.equal(plan.kind, 'copy');
  assert.equal(
    plan.command,
    `cp -a -- '/a/one' '/b/one' && rm -rf -- '/b/two' && cp -a -- '/a/two' '/b/two'`,
  );
  assert.equal(plan.label, 'Copy 2 items → b/');
  assert.deepEqual(plan.dirs, ['/b']);
  assert.equal(plan.result, '/b');
});

test('planCopy as a move uses mv and refreshes both directories', () => {
  const plan = planCopy([{ from: '/a/one', to: '/b/uno' }], true);
  assert.equal(plan.kind, 'move');
  assert.equal(plan.command, `mv -f -- '/a/one' '/b/uno'`);
  assert.equal(plan.label, 'Move one → b/');
  assert.deepEqual(plan.dirs.sort(), ['/a', '/b']);
});

test('planCopy refuses nonsense', () => {
  assert.throws(() => planCopy([], false), /Nothing to copy/);
  assert.throws(() => planCopy([{ from: '/a/x', to: '/a/x' }], false), /are the same/);
  assert.throws(() => planCopy([{ from: '/a/x', to: '/a/x/y/x' }], true), /inside itself/);
  assert.throws(() => planCopy([{ from: 'rel', to: '/a' }], false), /absolute/);
});
