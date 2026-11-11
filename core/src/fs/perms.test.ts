import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyPerms, chmodCommand, chownCommand } from './perms';
import { octalOf, parseOctal } from '../ssh/mode';

test('chmod command uses 4-digit octal and quoting', () => {
  assert.equal(chmodCommand('/a b', 0o100755), "chmod 0755 -- '/a b'");
  assert.equal(chmodCommand('/a', 0o4755, true), "chmod -R 4755 -- '/a'");
});

test('chown command covers owner, group, both, recursive and none', () => {
  assert.equal(chownCommand('/p', 'alice'), "chown 'alice' -- '/p'");
  assert.equal(chownCommand('/p', undefined, 'www-data'), "chown ':www-data' -- '/p'");
  assert.equal(chownCommand('/p', 'alice', 'staff', true), "chown -R 'alice:staff' -- '/p'");
  assert.equal(chownCommand('/p', '1000', '1000'), "chown '1000:1000' -- '/p'");
  assert.equal(chownCommand('/p', ' ', ''), null);
  assert.throws(() => chownCommand('/p', 'a;rm'), /Invalid owner\/group name/);
});

test('applyPerms runs chown before chmod and reports failures', async () => {
  const calls: string[] = [];
  await applyPerms(
    async (c) => {
      calls.push(c);
      return { code: 0, stdout: '', stderr: '' };
    },
    '/p',
    { mode: 0o640, owner: 'alice', recursive: true },
  );
  assert.deepEqual(calls, ["chown -R 'alice' -- '/p'", "chmod -R 0640 -- '/p'"]);

  await assert.rejects(
    applyPerms(
      async () => ({ code: 1, stdout: '', stderr: 'chown: Operation not permitted' }),
      '/p',
      {
        owner: 'root',
      },
    ),
    /chown failed: chown: Operation not permitted/,
  );
});

test('octal helpers', () => {
  assert.equal(octalOf(0o100644), '0644');
  assert.equal(octalOf(0o41777), '1777');
  assert.equal(parseOctal('755'), 0o755);
  assert.equal(parseOctal(' 0640 '), 0o640);
  assert.equal(parseOctal('8'), null);
  assert.equal(parseOctal('07777'), null);
  assert.equal(parseOctal(''), null);
});
