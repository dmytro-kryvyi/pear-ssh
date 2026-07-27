import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchDockerDf } from './docker-df';
import { performAction, type Exec } from '../orchestration/orchestration';

const DF_OUTPUT = [
  '{"Active":"5","Reclaimable":"3.678GB (60%)","Size":"6.104GB","TotalCount":"12","Type":"Images"}',
  '{"Active":"4","Reclaimable":"737.9MB (61%)","Size":"1.204GB","TotalCount":"7","Type":"Containers"}',
  '{"Active":"2","Reclaimable":"0B (0%)","Size":"845.1MB","TotalCount":"3","Type":"Local Volumes"}',
  '{"Active":"0","Reclaimable":"1.5kB","Size":"1.5kB","TotalCount":"9","Type":"Build Cache"}',
].join('\n');

const execWith =
  (code: number, stdout: string, stderr = ''): Exec =>
  async () => ({ code, stdout, stderr });

test('parses docker system df rows in canonical order with byte values', async () => {
  const rows = await fetchDockerDf(execWith(0, DF_OUTPUT));
  assert.deepEqual(
    rows.map((r) => r.type),
    ['containers', 'images', 'volumes', 'buildCache'],
  );
  const images = rows.find((r) => r.type === 'images')!;
  assert.equal(images.count, 12);
  assert.equal(images.active, 5);
  assert.equal(images.sizeText, '6.104GB');
  assert.ok(Math.abs(images.size! - 6.104e9) < 1e6);
  assert.equal(images.reclaimableText, '3.678GB'); // "(60%)" stripped
  assert.ok(Math.abs(images.reclaimable! - 3.678e9) < 1e6);
});

test('handles 0B and lowercase kB sizes', async () => {
  const rows = await fetchDockerDf(execWith(0, DF_OUTPUT));
  assert.equal(rows.find((r) => r.type === 'volumes')!.reclaimable, 0);
  assert.equal(rows.find((r) => r.type === 'buildCache')!.size, 1500);
});

test('a failing docker system df surfaces stderr', async () => {
  await assert.rejects(
    fetchDockerDf(execWith(1, '', 'Cannot connect to the Docker daemon')),
    /Cannot connect to the Docker daemon/,
  );
});

test('engine prune is a terminal command without --volumes, never an exec', async () => {
  const commands: string[] = [];
  const exec: Exec = async (c) => {
    commands.push(c);
    return { code: 0, stdout: '', stderr: '' };
  };
  const result = await performAction(exec, { type: 'engine', op: 'prune' });
  assert.deepEqual(commands, []);
  assert.equal(result.terminalCommand, 'docker system prune -af');
});
