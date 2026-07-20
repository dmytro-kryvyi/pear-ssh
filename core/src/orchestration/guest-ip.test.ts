import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGuestIp } from './guest-ip';

const agentJson = JSON.stringify([
  {
    name: 'lo',
    'ip-addresses': [
      { 'ip-address': '127.0.0.1', 'ip-address-type': 'ipv4' },
      { 'ip-address': '::1', 'ip-address-type': 'ipv6' },
    ],
  },
  {
    name: 'eth0',
    'ip-addresses': [
      { 'ip-address': 'fe80::1234', 'ip-address-type': 'ipv6' },
      { 'ip-address': '192.168.1.42', 'ip-address-type': 'ipv4' },
    ],
  },
]);

test('picks the first non-loopback IPv4', () => {
  assert.equal(parseGuestIp(agentJson), '192.168.1.42');
});

test('falls back to a global IPv6 when no IPv4 exists', () => {
  const v6only = JSON.stringify([
    {
      name: 'eth0',
      'ip-addresses': [
        { 'ip-address': 'fe80::1', 'ip-address-type': 'ipv6' },
        { 'ip-address': '2001:db8::7', 'ip-address-type': 'ipv6' },
      ],
    },
  ]);
  assert.equal(parseGuestIp(v6only), '2001:db8::7');
});

test('unwraps raw QGA "return" envelopes', () => {
  const wrapped = JSON.stringify({ return: JSON.parse(agentJson) });
  assert.equal(parseGuestIp(wrapped), '192.168.1.42');
});

test('returns null on malformed or empty input', () => {
  assert.equal(parseGuestIp('not json'), null);
  assert.equal(parseGuestIp('{}'), null);
  assert.equal(parseGuestIp('[]'), null);
  assert.equal(
    parseGuestIp(JSON.stringify([{ name: 'lo', 'ip-addresses': [{ 'ip-address': '127.0.0.1', 'ip-address-type': 'ipv4' }] }])),
    null,
  );
});
