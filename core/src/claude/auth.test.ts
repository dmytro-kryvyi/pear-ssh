import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isClaudeAuthError } from './auth';

test('isClaudeAuthError: recognises the CLI sign-in failures', () => {
  for (const msg of [
    'Not logged in · Please run /login',
    'OAuth token revoked · Please run /login',
    'OAuth token expired',
    'Invalid API key · Fix external API key',
    'authentication_error: invalid x-api-key',
    'API Error: 401 Unauthorized',
  ]) {
    assert.ok(isClaudeAuthError(msg), msg);
  }
});

test('isClaudeAuthError: ordinary failures are not sign-in problems', () => {
  for (const msg of [
    'claude exited with code 1 — ENOENT',
    'Error: rate limit exceeded (429)',
    'The user denied this action.',
    'Host chain too deep or cyclic',
  ]) {
    assert.equal(isClaudeAuthError(msg), false, msg);
  }
});
