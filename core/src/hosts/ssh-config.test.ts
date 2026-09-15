import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSshHosts, tokenizeSshConfig, type SshConfigEntry } from './ssh-config';

function parse(text: string): SshConfigEntry[] {
  return resolveSshHosts(tokenizeSshConfig(text));
}

test('basic Host block with all fields', () => {
  const entries = parse(`
Host web
  HostName 10.0.0.5
  User deploy
  Port 2222
  IdentityFile ~/.ssh/web
`);
  assert.deepEqual(entries, [
    { alias: 'web', host: '10.0.0.5', user: 'deploy', port: 2222, identityFile: '~/.ssh/web' },
  ]);
});

test('multiple aliases on one Host line share the block values', () => {
  const entries = parse(`
Host web db
  HostName srv.lan
  User root
`);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map((e) => e.alias), ['web', 'db']);
  for (const e of entries) {
    assert.equal(e.host, 'srv.lan');
    assert.equal(e.user, 'root');
  }
});

test('Host * defaults fill only missing fields', () => {
  const entries = parse(`
Host web
  HostName 10.0.0.5
  User deploy
Host *
  User fallback
  IdentityFile ~/.ssh/id_ed25519
`);
  assert.deepEqual(entries, [
    {
      alias: 'web',
      host: '10.0.0.5',
      user: 'deploy',
      identityFile: '~/.ssh/id_ed25519',
    },
  ]);
});

test('preamble options before any Host act as defaults', () => {
  const entries = parse(`
User admin
Host web
  HostName 10.0.0.5
`);
  assert.deepEqual(entries, [{ alias: 'web', host: '10.0.0.5', user: 'admin' }]);
});

test('wildcard and negated patterns produce no entries', () => {
  const entries = parse(`
Host *.internal
  User svc
Host !bad
  User x
Host ci?
  User y
`);
  assert.deepEqual(entries, []);
});

test('first Host block for an alias wins; later blocks only fill gaps', () => {
  const entries = parse(`
Host web
  HostName first.lan
Host web
  HostName second.lan
  User late
`);
  assert.deepEqual(entries, [{ alias: 'web', host: 'first.lan', user: 'late' }]);
});

test('= syntax, quoted args, keyword case, comments, CRLF', () => {
  const entries = parse(
    'Host "my host"\r\n' +
      'HOSTNAME=10.1.1.1 # trailing comment\r\n' +
      '  user=root\r\n' +
      '  IdentityFile "/key path/id"\r\n' +
      '# full comment line\r\n',
  );
  assert.deepEqual(entries, [
    { alias: 'my host', host: '10.1.1.1', user: 'root', identityFile: '/key path/id' },
  ]);
});

test('non-numeric Port is ignored', () => {
  const entries = parse(`
Host web
  HostName 10.0.0.5
  Port default
`);
  assert.equal(entries[0].port, undefined);
});

test('only the first IdentityFile is kept', () => {
  const entries = parse(`
Host web
  IdentityFile ~/.ssh/first
  IdentityFile ~/.ssh/second
`);
  assert.equal(entries[0].identityFile, '~/.ssh/first');
});

test('entry without HostName keeps the alias as host', () => {
  const entries = parse(`
Host bastion.example.com
  User ops
`);
  assert.deepEqual(entries, [
    { alias: 'bastion.example.com', host: 'bastion.example.com', user: 'ops' },
  ]);
});

test('ProxyJump is surfaced on the entry', () => {
  const entries = parse(`
Host inner
  HostName 192.168.7.2
  ProxyJump bastion
`);
  assert.equal(entries[0].proxyJump, 'bastion');
});

test('Match block contents are skipped until the next Host', () => {
  const entries = parse(`
Match user deploy
  IdentityFile ~/.ssh/match-key
Host web
  HostName 10.0.0.5
`);
  assert.deepEqual(entries, [{ alias: 'web', host: '10.0.0.5' }]);
});
