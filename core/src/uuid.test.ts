import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uuid, uuidFromBytes } from './uuid';

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test('uuid: native path yields a v4 id', () => {
  assert.match(uuid(), V4);
  assert.notEqual(uuid(), uuid());
});

test('uuidFromBytes: the http-origin fallback sets version and variant bits', () => {
  assert.match(uuidFromBytes(new Uint8Array(16)), V4);
  assert.match(uuidFromBytes(new Uint8Array(16).fill(0xff)), V4);
  assert.equal(uuidFromBytes(new Uint8Array(16)), '00000000-0000-4000-8000-000000000000');
});
