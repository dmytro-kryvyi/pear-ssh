import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchServiceTasks, fetchTaskLogs, parseCurrentState, parseLogStream } from './tasks';
import type { Exec } from './orchestration';

function fixedExec(stdout: string, stderr = '', code = 0): { exec: Exec; commands: string[] } {
  const commands: string[] = [];
  const exec: Exec = async (command) => {
    commands.push(command);
    return { code, stdout, stderr };
  };
  return { exec, commands };
}

const psRow = (over: Record<string, string>) =>
  JSON.stringify({
    ID: 'p4mn8qz1a7ke',
    Name: 'web.1',
    Image: 'pear/web:3.1',
    Node: 'edge-03',
    DesiredState: 'Running',
    CurrentState: 'Running 4 hours ago',
    Error: '',
    Ports: '',
    ...over,
  });

test('parseCurrentState splits state and relative time', () => {
  assert.deepEqual(parseCurrentState('Running 4 hours ago'), {
    state: 'running',
    sinceText: '4 hours ago',
  });
  assert.deepEqual(parseCurrentState('Failed 2 minutes ago'), {
    state: 'failed',
    sinceText: '2 minutes ago',
  });
  assert.deepEqual(parseCurrentState('Pending'), { state: 'pending', sinceText: '' });
  // Unknown first word falls back to 'new' rather than widening the type
  assert.equal(parseCurrentState('Weird 1 second ago').state, 'new');
});

test('fetchServiceTasks quotes the service and parses rows', async () => {
  const { exec, commands } = fixedExec(
    [
      psRow({}),
      psRow({
        ID: 'a4pz6ln1td3g',
        Name: 'web.3',
        Node: 'edge-02',
        DesiredState: 'Shutdown',
        CurrentState: 'Failed 2 minutes ago',
        Error: '"task: non-zero exit (137)"',
      }),
    ].join('\n'),
  );
  const tasks = await fetchServiceTasks(exec, 'web');
  assert.deepEqual(commands, [`docker service ps --no-trunc --format '{{json .}}' 'web'`]);
  assert.equal(tasks.length, 2);
  assert.deepEqual(tasks[0], {
    id: 'p4mn8qz1a7ke',
    name: 'web.1',
    slot: '1',
    image: 'pear/web:3.1',
    node: 'edge-03',
    desiredState: 'running',
    state: 'running',
    sinceText: '4 hours ago',
    error: '',
  });
  assert.equal(tasks[1].state, 'failed');
  assert.equal(tasks[1].desiredState, 'shutdown');
  // Docker's wrapping quotes are stripped
  assert.equal(tasks[1].error, 'task: non-zero exit (137)');
});

test('slot derivation survives dots in the service name and global tasks', async () => {
  const { exec } = fixedExec(psRow({ Name: 'my.svc.abc123nodeid' }));
  const tasks = await fetchServiceTasks(exec, 'my.svc');
  assert.equal(tasks[0].slot, 'abc123nodeid');
  // A name that is not "<service>." prefixed is kept whole
  const { exec: exec2 } = fixedExec(psRow({ Name: 'other.1' }));
  const tasks2 = await fetchServiceTasks(exec2, 'my.svc');
  assert.equal(tasks2[0].slot, 'other.1');
});

test('fetchServiceTasks surfaces stderr on failure', async () => {
  const { exec } = fixedExec('', 'no such service: nope', 1);
  await assert.rejects(fetchServiceTasks(exec, 'nope'), /no such service: nope/);
});

test('parseLogStream tags streams, joins continuations, drops leading noise', () => {
  const out = parseLogStream(
    '2026-07-31T14:04:31.010203040Z FATAL heap out of memory\n' +
      '  1: node::Abort()\n' +
      '  2: v8::internal::Heap::CollectGarbage(...)\n' +
      '2026-07-31T14:04:31.240Z exiting\n',
    'err',
  );
  assert.equal(out.length, 2);
  assert.equal(out[0].stream, 'err');
  assert.equal(
    out[0].text,
    'FATAL heap out of memory\n  1: node::Abort()\n  2: v8::internal::Heap::CollectGarbage(...)',
  );
  assert.equal(out[1].text, 'exiting');

  // Leading timestamp-less lines (CLI diagnostics) are dropped
  assert.deepEqual(parseLogStream('WARNING: tty detected\n', 'err'), []);
  assert.deepEqual(parseLogStream('', 'out'), []);
});

test('fetchTaskLogs uses --tail by default and --since when following', async () => {
  const { exec, commands } = fixedExec('');
  await fetchTaskLogs(exec, 'p4mn8qz1a7ke');
  await fetchTaskLogs(exec, 'p4mn8qz1a7ke', { tail: 50 });
  await fetchTaskLogs(exec, 'p4mn8qz1a7ke', { since: '2026-07-31T14:04:31.240Z' });
  assert.deepEqual(commands, [
    `docker service logs --raw -t --no-trunc --tail 200 'p4mn8qz1a7ke'`,
    `docker service logs --raw -t --no-trunc --tail 50 'p4mn8qz1a7ke'`,
    `docker service logs --raw -t --no-trunc --since '2026-07-31T14:04:31.240Z' 'p4mn8qz1a7ke'`,
  ]);
});

test('fetchTaskLogs merges stdout/stderr by timestamp and reports lastTs', async () => {
  const exec: Exec = async () => ({
    code: 0,
    stdout:
      '2026-07-31T14:00:01.5Z booting\n' + // RFC3339Nano trims zeros: .5 == .500
      '2026-07-31T14:00:03.000000000Z serving\n',
    stderr: '2026-07-31T14:00:02.100Z WARN low memory\n',
  });
  const chunk = await fetchTaskLogs(exec, 't1');
  assert.deepEqual(
    chunk.lines.map((l) => [l.stream, l.text]),
    [
      ['out', 'booting'],
      ['err', 'WARN low memory'],
      ['out', 'serving'],
    ],
  );
  assert.equal(chunk.lastTs, '2026-07-31T14:00:03.000000000Z');
});

test('fetchTaskLogs returns empty chunk for a silent task', async () => {
  const { exec } = fixedExec('');
  const chunk = await fetchTaskLogs(exec, 't1');
  assert.deepEqual(chunk, { lines: [], lastTs: null });
});

test('fetchTaskLogs throws stderr on non-zero exit', async () => {
  const { exec } = fixedExec('', 'no such task: deadbeef', 1);
  await assert.rejects(fetchTaskLogs(exec, 'deadbeef'), /no such task: deadbeef/);
});
