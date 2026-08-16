import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyEdit } from './edit';

test('applyEdit replaces a unique match once', () => {
  const r = applyEdit('port = 80\nhost = a\n', 'port = 80', 'port = 8080');
  assert.equal(r.content, 'port = 8080\nhost = a\n');
  assert.equal(r.count, 1);
});

test('applyEdit tells the model to re-read on zero matches', () => {
  assert.throws(() => applyEdit('abc', 'xyz', 'q'), /not found.*read_file/);
});

test('applyEdit refuses ambiguous matches unless replace_all', () => {
  assert.throws(() => applyEdit('a=1\na=1\na=1\n', 'a=1', 'a=2'), /matches 3 times.*replace_all/);
  const r = applyEdit('a=1\na=1\na=1\n', 'a=1', 'a=2', true);
  assert.equal(r.content, 'a=2\na=2\na=2\n');
  assert.equal(r.count, 3);
});

test('applyEdit rejects degenerate inputs', () => {
  assert.throws(() => applyEdit('abc', '', 'x'), /empty/);
  assert.throws(() => applyEdit('abc', 'b', 'b'), /identical/);
});
