import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ExecTimeoutError, describeChannelOpenError } from './exec-errors';

const ssh2Error = (reason?: number) =>
  Object.assign(new Error('(SSH) Channel open failure: open failed'), { reason });

test('MaxSessions exhaustion (CONNECT_FAILED) explains the limit and the way out', () => {
  const err = describeChannelOpenError(ssh2Error(2), 'nas');
  assert.match(err.message, /^nas refused to open another SSH session/);
  assert.match(err.message, /MaxSessions/);
  assert.match(err.message, /disconnect and reconnect/);
  assert.equal(err.name, 'ChannelOpenError');
});

test('RESOURCE_SHORTAGE reads the same way; administratively prohibited differs', () => {
  assert.match(describeChannelOpenError(ssh2Error(4), 'nas').message, /MaxSessions/);
  assert.match(
    describeChannelOpenError(ssh2Error(1), 'nas').message,
    /administratively prohibited/,
  );
});

test('unknown reasons keep ssh2 text; other errors pass through untouched', () => {
  assert.match(
    describeChannelOpenError(ssh2Error(), 'nas').message,
    /nas: SSH channel open failed/,
  );
  const other = new Error('Timed out while waiting for handshake');
  assert.equal(describeChannelOpenError(other, 'nas'), other);
  assert.equal(describeChannelOpenError('boom', 'nas').message, 'boom');
});

test('ExecTimeoutError names the budget and a trimmed command', () => {
  const err = new ExecTimeoutError(`docker   stats --no-stream ${'x'.repeat(100)}`, 30_000);
  assert.match(err.message, /^Command timed out after 30 s: docker stats --no-stream x+…$/);
  assert.ok(err.message.length < 130);
  assert.equal(err.timeoutMs, 30_000);
});
