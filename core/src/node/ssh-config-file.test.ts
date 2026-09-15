import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { loadSshConfigEntries } from './ssh-config-file';

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'pear-sshconf-'));
}

test('missing config file yields []', () => {
  assert.deepEqual(loadSshConfigEntries(join(scratch(), 'nope')), []);
});

test('relative and glob Includes are spliced in place', () => {
  const dir = scratch();
  mkdirSync(join(dir, 'confs'));
  writeFileSync(join(dir, 'confs', 'a.conf'), 'Host web\n  HostName 10.0.0.5\n');
  writeFileSync(join(dir, 'confs', 'b.conf'), 'Host db\n  HostName 10.0.0.6\n');
  writeFileSync(join(dir, 'single.conf'), 'Host solo\n  HostName 10.0.0.7\n');
  writeFileSync(
    join(dir, 'config'),
    'Include confs/*.conf\nInclude single.conf\nHost top\n  HostName 10.0.0.8\n',
  );
  const entries = loadSshConfigEntries(join(dir, 'config'));
  assert.deepEqual(
    entries.map((e) => [e.alias, e.host]),
    [
      ['web', '10.0.0.5'],
      ['db', '10.0.0.6'],
      ['solo', '10.0.0.7'],
      ['top', '10.0.0.8'],
    ],
  );
});

test('an Include inside a Host block continues that block', () => {
  const dir = scratch();
  writeFileSync(join(dir, 'tail.conf'), '  User deploy\n');
  writeFileSync(join(dir, 'config'), 'Host web\n  HostName 10.0.0.5\nInclude tail.conf\n');
  const entries = loadSshConfigEntries(join(dir, 'config'));
  assert.equal(entries[0].user, 'deploy');
});

test('unreadable Include is skipped', () => {
  const dir = scratch();
  writeFileSync(join(dir, 'config'), 'Include missing.conf\nHost web\n  HostName 10.0.0.5\n');
  const entries = loadSshConfigEntries(join(dir, 'config'));
  assert.equal(entries.length, 1);
});

test('Include loops terminate', () => {
  const dir = scratch();
  writeFileSync(join(dir, 'config'), 'Include config\nHost web\n  HostName 10.0.0.5\n');
  const entries = loadSshConfigEntries(join(dir, 'config'));
  assert.deepEqual(
    entries.map((e) => e.alias),
    ['web'],
  );
});

test('IdentityFile: ~ expanded, %-tokens dropped', () => {
  const dir = scratch();
  writeFileSync(
    join(dir, 'config'),
    'Host a\n  IdentityFile ~/.ssh/mykey\nHost b\n  IdentityFile ~/.ssh/id_%h\n',
  );
  const entries = loadSshConfigEntries(join(dir, 'config'));
  assert.equal(entries[0].identityFile, join(homedir(), '.ssh', 'mykey'));
  assert.equal(entries[1].identityFile, undefined);
});

test('missing User defaults to the local username', () => {
  const dir = scratch();
  writeFileSync(join(dir, 'config'), 'Host web\n  HostName 10.0.0.5\n');
  const entries = loadSshConfigEntries(join(dir, 'config'));
  assert.equal(entries[0].user, userInfo().username);
});
