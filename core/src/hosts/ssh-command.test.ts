import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sshCommand } from './ssh-command';
import type { HostConfig } from '../types';

const h = (p: Partial<HostConfig> & { id: string }): HostConfig => ({
  name: p.id,
  host: p.id + '.lan',
  port: 22,
  user: 'root',
  kind: 'plain',
  ...p,
});

test('sshCommand: plain host, default port', () => {
  assert.equal(sshCommand(h({ id: 'a' }), () => undefined), 'ssh root@a.lan');
});

test('sshCommand: non-default port gets -p', () => {
  assert.equal(sshCommand(h({ id: 'a', port: 1813, user: 'u' }), () => undefined), 'ssh -p 1813 u@a.lan');
});

test('sshCommand: via chain emits -J outermost first with hop ports', () => {
  const all = [
    h({ id: 'edge', host: '1.1.1.1' }),
    h({ id: 'core', host: '10.0.0.2', port: 2222, via: 'edge' }),
    h({ id: 'oob', host: '10.0.0.9', port: 47319, via: 'core' }),
  ];
  const lookup = (id: string) => all.find((x) => x.id === id);
  assert.equal(
    sshCommand(all[2], lookup),
    'ssh -p 47319 -J root@1.1.1.1,root@10.0.0.2:2222 root@10.0.0.9',
  );
});

test('sshCommand: a cyclic via chain terminates', () => {
  const a = h({ id: 'a', via: 'b' });
  const b = h({ id: 'b', via: 'a' });
  const lookup = (id: string) => (id === 'a' ? a : b);
  assert.equal(sshCommand(a, lookup), 'ssh -J root@b.lan root@a.lan');
});

test('sshCommand: local and exec sub-hosts have no ssh form', () => {
  assert.equal(sshCommand(h({ id: 'pc', local: true }), () => undefined), '');
  assert.equal(
    sshCommand(h({ id: 'ct', parentId: 'pve', target: { type: 'lxc', ref: '101' } }), () => undefined),
    '',
  );
});
