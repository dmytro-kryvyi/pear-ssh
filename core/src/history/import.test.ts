import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importShellHistory, parseHistoryFile } from './import';

test('bash history is one command per line', () => {
  const parsed = parseHistoryFile('.bash_history', 'ls -la\ncd /srv\n\nhtop\n');
  assert.deepEqual(parsed, ['ls -la', 'cd /srv', 'htop']);
});

test('bash timestamp comments are dropped but real comments kept', () => {
  const parsed = parseHistoryFile('.bash_history', '#1699999999\nls\n# a note\n');
  assert.deepEqual(parsed, ['ls', '# a note']);
});

test('zsh extended history strips the metadata prefix', () => {
  const raw = ': 1699999999:0;docker ps\n: 1700000000:12;git status\n';
  assert.deepEqual(parseHistoryFile('.zsh_history', raw), ['docker ps', 'git status']);
});

test('zsh multi-line commands are joined', () => {
  const raw = ': 1699999999:0;for f in *; do\\\n  echo $f\\\ndone\n: 1700000000:0;ls\n';
  const parsed = parseHistoryFile('.zsh_history', raw);
  assert.equal(parsed.length, 2);
  assert.ok(parsed[0].includes('echo $f'));
  assert.equal(parsed[1], 'ls');
});

test('plain lines in a zsh file still parse', () => {
  assert.deepEqual(parseHistoryFile('.zsh_history', 'ls -la\n'), ['ls -la']);
});

test('fish history reads the cmd entries', () => {
  const raw = '- cmd: docker ps\n  when: 1699999999\n- cmd: echo \\"hi\\"\n  when: 1700000000\n';
  assert.deepEqual(parseHistoryFile('.local/share/fish/fish_history', raw), [
    'docker ps',
    'echo "hi"',
  ]);
});

test('importShellHistory skips files that are not there', async () => {
  const files = new Map([['.zsh_history', ': 1:0;htop\n']]);
  const result = await importShellHistory(async (path) => {
    const raw = files.get(path);
    if (!raw) throw new Error('No such file');
    return raw;
  });
  assert.deepEqual(result.files, ['.zsh_history']);
  assert.deepEqual(result.commands, ['htop']);
});

test('importShellHistory merges every file it finds', async () => {
  const files = new Map([
    ['.bash_history', 'ls\n'],
    ['.zsh_history', ': 1:0;htop\n'],
  ]);
  const result = await importShellHistory(async (path) => {
    const raw = files.get(path);
    if (!raw) throw new Error('No such file');
    return raw;
  });
  assert.deepEqual(result.commands, ['ls', 'htop']);
});

test('a host with no history files yields nothing, without throwing', async () => {
  const result = await importShellHistory(async () => {
    throw new Error('No such file');
  });
  assert.deepEqual(result, { files: [], commands: [] });
});
