import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performAction, type Exec } from './orchestration';
import type { OrchAction } from '../types';

/** Records the commands performAction runs; every command succeeds. */
function recordingExec(): { exec: Exec; commands: string[] } {
  const commands: string[] = [];
  const exec: Exec = async (command) => {
    commands.push(command);
    return { code: 0, stdout: '', stderr: '' };
  };
  return { exec, commands };
}

test('compose start/stop/restart run docker compose against the project', async () => {
  for (const op of ['start', 'stop', 'restart'] as const) {
    const { exec, commands } = recordingExec();
    const action: OrchAction = { type: 'compose', project: 'my proj', op };
    const result = await performAction(exec, action);
    assert.deepEqual(commands, [`docker compose -p 'my proj' ${op}`]);
    assert.equal(result.terminalCommand, undefined);
  }
});

test('compose logs is a streaming terminal command, not an exec', async () => {
  const { exec, commands } = recordingExec();
  const result = await performAction(exec, { type: 'compose', project: 'web', op: 'logs' });
  assert.deepEqual(commands, []);
  assert.equal(result.terminalCommand, `docker compose -p 'web' logs -f --tail 100`);
});

test('a failing compose command surfaces stderr', async () => {
  const exec: Exec = async () => ({
    code: 1,
    stdout: '',
    stderr: 'no such project: web',
  });
  await assert.rejects(
    performAction(exec, { type: 'compose', project: 'web', op: 'stop' }),
    /no such project: web/,
  );
});
