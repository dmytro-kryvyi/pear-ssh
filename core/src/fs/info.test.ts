import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileInfo, fileInfoCommand, parseFileInfo } from './info';

const GNU = 'G|81a4|12|0|0|root|root|1776109146|1776109145|1776109144|1\nL|\n';

test('parses a GNU stat line into a file', () => {
  const info = parseFileInfo('/etc/hostname', GNU);
  assert.equal(info.name, 'hostname');
  assert.equal(info.kind, 'file');
  assert.equal(info.mode, 0o100644);
  assert.equal(info.modeText, '-rw-r--r--');
  assert.equal(info.size, 12);
  assert.equal(info.owner, 'root');
  assert.equal(info.group, 'root');
  assert.equal(info.uid, 0);
  assert.equal(info.atimeMs, 1776109146000);
  assert.equal(info.mtimeMs, 1776109145000);
  assert.equal(info.ctimeMs, 1776109144000);
  assert.equal(info.nlink, 1);
  assert.equal(info.linkTarget, undefined);
  assert.equal(info.dir, undefined);
});

test('parses a BSD stat line (octal mode) into a directory', () => {
  const info = parseFileInfo('/Users/me', 'B|40755|96|501|20|me|staff|1|2|3|3\nL|\n');
  assert.equal(info.kind, 'dir');
  assert.equal(info.mode, 0o40755);
  assert.equal(info.modeText, 'drwxr-xr-x');
  assert.equal(info.owner, 'me');
  assert.equal(info.group, 'staff');
  assert.equal(info.gid, 20);
});

test('renders setuid, sticky and set-gid-without-x text', () => {
  assert.equal(parseFileInfo('/p', 'G|89ed|0|0|0|r|r|0|0|0|1').modeText, '-rwsr-xr-x');
  assert.equal(parseFileInfo('/p', 'G|43ff|0|0|0|r|r|0|0|0|1').modeText, 'drwxrwxrwt');
  assert.equal(parseFileInfo('/p', 'G|85a4|0|0|0|r|r|0|0|0|1').modeText, '-rw-r-Sr--');
  assert.equal(parseFileInfo('/p', 'G|8ba4|0|0|0|r|r|0|0|0|1').modeText, '-rwSr--r-T');
});

test('link target is kept only for symlinks and may contain pipes', () => {
  const link = parseFileInfo('/l', 'G|a1ff|5|0|0|r|r|0|0|0|1\nL|/a|b\n');
  assert.equal(link.kind, 'link');
  assert.equal(link.linkTarget, '/a|b');
  const file = parseFileInfo('/f', 'G|81a4|5|0|0|r|r|0|0|0|1\nL|stale\n');
  assert.equal(file.linkTarget, undefined);
});

test('deep fields total a directory, tolerating CRLF and padded wc output', () => {
  const info = parseFileInfo(
    '/d',
    'G|41ed|4096|0|0|r|r|0|0|0|2\r\nL|\r\nD|1234\r\nF|     17\r\nN|4\r\n',
  );
  assert.deepEqual(info.dir, { bytes: 1234 * 1024, files: 17, dirs: 3 });
});

test('no stat line throws', () => {
  assert.throws(() => parseFileInfo('/x', ''), /stat produced no result/);
});

test('the command tries GNU stat first, then BSD, and quotes the path', () => {
  const cmd = fileInfoCommand("/tmp/it's", false);
  assert.match(cmd, /stat -c 'G\|/);
  assert.match(cmd, /stat -f 'B\|/);
  assert.ok(cmd.includes(`'/tmp/it'\\''s'`));
  assert.ok(!cmd.includes('du -sk'));
  assert.ok(fileInfoCommand('/d', true).includes('du -sk'));
});

test('fileInfo runs one exec and surfaces stderr on failure', async () => {
  const calls: string[] = [];
  const ok = await fileInfo(async (c) => {
    calls.push(c);
    return { code: 0, stdout: GNU, stderr: '' };
  }, '/etc/hostname');
  assert.equal(ok.size, 12);
  assert.equal(calls.length, 1);
  await assert.rejects(
    fileInfo(async () => ({ code: 2, stdout: '', stderr: 'No such file or directory\n' }), '/nope'),
    /stat failed: No such file or directory/,
  );
});
