import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoShort, shortLabel } from './identity';

test('autoShort takes segment initials, keeping numeric segments whole', () => {
  assert.equal(autoShort('ceramic-world-staging'), 'CWS');
  assert.equal(autoShort('edge-01'), 'E01');
  assert.equal(autoShort('db_primary'), 'DP');
  assert.equal(autoShort('pve.lan.home'), 'PLH');
});

test('autoShort clamps single words', () => {
  assert.equal(autoShort('analytics'), 'ANA');
  assert.equal(autoShort('pve1'), 'PVE1');
  assert.equal(autoShort(''), '');
});

test('autoShort caps multi-segment output at 5 chars', () => {
  assert.equal(autoShort('a-10-b-c').length <= 5, true);
});

test('shortLabel prefers the explicit override', () => {
  assert.equal(shortLabel({ name: 'edge-01', short: 'EDGE' }), 'EDGE');
  assert.equal(shortLabel({ name: 'edge-01' }), 'E01');
});
