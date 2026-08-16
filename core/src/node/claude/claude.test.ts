import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { HostConfig } from '../../types';
import { ClaudeExecutor, type ClaudeExecutorEnv } from './executor';
import { PearMcpServer } from './mcp-server';
import { truncateOutput } from './tools';
import { provisionClaudeWorkspace } from './workspace';

const host = (over: Partial<HostConfig>): HostConfig => ({
  id: 'h1',
  name: 'edge-01',
  host: 'edge-01.internal',
  port: 22,
  user: 'deploy',
  kind: 'docker',
  ...over,
});

/** Fake env recording exec calls; per-test overrides for failure paths. */
function fakeEnv(hosts: HostConfig[], over: Partial<ClaudeExecutorEnv> = {}) {
  const calls: string[] = [];
  const env: ClaudeExecutorEnv = {
    hosts: () => hosts,
    isConnected: (id) => id === 'h1',
    exec: async (_h, command) => {
      calls.push(command);
      return { code: 0, stdout: 'ok\n', stderr: '' };
    },
    readFile: async () => 'file-content',
    writeFile: async () => {},
    listDir: async (_h, path) => ({
      path,
      entries: [{ name: 'a.conf', kind: 'file', size: 12, mtimeMs: 0, mode: '-rw-r--r--' }],
    }),
    ...over,
  };
  return { env, calls };
}

// ---- executor: host resolution ---------------------------------------------

test('resolve matches id, exact name, then case-insensitive name', () => {
  const hosts = [host({}), host({ id: 'h2', name: 'DB-Primary' })];
  const ex = new ClaudeExecutor(fakeEnv(hosts).env);
  assert.equal(ex.resolve('h2').name, 'DB-Primary');
  assert.equal(ex.resolve('edge-01').id, 'h1');
  assert.equal(ex.resolve('db-primary').id, 'h2');
});

test('resolve rejects unknown and ambiguous refs with usable messages', () => {
  const hosts = [host({}), host({ id: 'h2', name: 'Edge-01' })];
  const ex = new ClaudeExecutor(fakeEnv(hosts).env);
  assert.throws(() => ex.resolve('nope'), /Unknown host 'nope'.*edge-01/);
  // 'edge-01' exact-matches h1 uniquely; 'EDGE-01' matches both case-insensitively.
  assert.equal(ex.resolve('edge-01').id, 'h1');
  assert.throws(() => ex.resolve('EDGE-01'), /ambiguous/);
});

test('listHosts marks the focused host and clears it on null', () => {
  const hosts = [host({}), host({ id: 'h2', name: 'db' })];
  const ex = new ClaudeExecutor(fakeEnv(hosts).env);
  assert.equal(ex.listHosts().some((h) => h.focused), false);

  ex.setFocus({ hostId: 'h2', path: '/srv/data' });
  const rows = ex.listHosts();
  assert.equal(rows.find((h) => h.id === 'h1')?.focused, undefined);
  assert.equal(rows.find((h) => h.id === 'h2')?.focused, true);
  assert.equal(rows.find((h) => h.id === 'h2')?.focusedPath, '/srv/data');

  ex.setFocus(null);
  assert.equal(ex.listHosts().some((h) => h.focused), false);
});

// ---- executor: run_command timeout wrapping --------------------------------

test('runCommand wraps in timeout with quoting and flags 124 as timedOut', async () => {
  const { env, calls } = fakeEnv([host({})]);
  const ex = new ClaudeExecutor(env);
  await ex.runCommand('edge-01', `echo 'it works'`);
  assert.equal(calls[0], `timeout 60 sh -c 'echo '\\''it works'\\'''`);

  await ex.runCommand('edge-01', 'sleep 5', 9999);
  assert.match(calls[1], /^timeout 600 /);

  const timedOut = new ClaudeExecutor(
    fakeEnv([host({})], {
      exec: async () => ({ code: 124, stdout: '', stderr: '' }),
    }).env,
  );
  const r = await timedOut.runCommand('edge-01', 'sleep 999', 1);
  assert.equal(r.timedOut, true);
});

// ---- executor: vitals / guests / edit --------------------------------------

/** Minimal VITALS_COMMAND output — enough for parseVitals. */
function vitalsOut(user: number, idle: number): string {
  return [
    `cpu  ${user} 0 0 ${idle} 0 0 0 0`,
    `cpu0 ${user} 0 0 ${idle} 0 0 0 0`,
    '=P1',
    'MemTotal:       1000 kB',
    'MemAvailable:    600 kB',
    'SwapTotal:       100 kB',
    'SwapFree:         90 kB',
    '=P2',
    '0.1 0.2 0.3 1/2 3',
    '=P3',
    '50.0 40.0',
    '=P4',
    '6.1.0',
    '=P5',
    'Filesystem 1024-blocks Used Available Capacity Mounted on',
    '/dev/sda1 1000 250 750 25% /',
    '=P6',
    ' eth0: 1000 0 0 0 0 0 0 0 2000 0 0 0 0 0 0 0',
  ].join('\n');
}

test('hostVitals samples twice and returns rates', async () => {
  const outputs = [vitalsOut(200, 800), vitalsOut(300, 900)];
  const env = fakeEnv([host({})], {
    exec: async () => ({ code: 0, stdout: outputs.shift() ?? '', stderr: '' }),
  }).env;
  const ex = new ClaudeExecutor(env, async () => {});
  const s = await ex.hostVitals('edge-01');
  assert.equal(s.cpuPercent, 50); // idleΔ 100 of totalΔ 200
  assert.equal(s.mem.usedPercent, 40);
  assert.equal(s.kernel, '6.1.0');
  assert.equal(outputs.length, 0);
});

test('listGuests fails cleanly on a non-Proxmox host', async () => {
  const env = fakeEnv([host({})], {
    exec: async () => ({ code: 0, stdout: 'active/true\n', stderr: '' }),
  }).env;
  const ex = new ClaudeExecutor(env, async () => {});
  await assert.rejects(() => ex.listGuests('edge-01'), /'edge-01' is not a Proxmox node/);
});

test('editFile applies a unique replacement and writes the result', async () => {
  const written: string[] = [];
  const env = fakeEnv([host({})], {
    readFile: async () => 'port = 80\nhost = a\n',
    writeFile: async (_h, _p, content) => {
      written.push(content);
    },
  }).env;
  const ex = new ClaudeExecutor(env);
  const r = await ex.editFile('edge-01', '/etc/app.conf', 'port = 80', 'port = 8080');
  assert.equal(r.count, 1);
  assert.deepEqual(written, ['port = 8080\nhost = a\n']);

  await assert.rejects(
    () => ex.editFile('edge-01', '/etc/app.conf', 'missing', 'x'),
    /not found.*read_file/,
  );
  assert.equal(written.length, 1); // failed edit never writes
});

// ---- executor: UI round-trip tools -----------------------------------------

test('UI tools route through env.uiRequest and fail cleanly without it', async () => {
  const payloads: unknown[] = [];
  const env = fakeEnv([host({})], {
    uiRequest: async (payload) => {
      payloads.push(payload);
      if (payload.kind === 'listTerminals') return [];
      if (payload.kind === 'readTerminal') return 'shell text';
      return { done: true };
    },
  }).env;
  const ex = new ClaudeExecutor(env);

  assert.deepEqual(await ex.listTerminals(), []);
  assert.equal(await ex.readTerminal('tab-1', 50), 'shell text');
  await ex.reveal({ type: 'open_dir', hostId: 'h1', path: '/srv' });
  assert.deepEqual(payloads, [
    { kind: 'listTerminals' },
    { kind: 'readTerminal', terminalId: 'tab-1', lines: 50 },
    { kind: 'reveal', action: { type: 'open_dir', hostId: 'h1', path: '/srv' } },
  ]);

  // Bad host ref fails before any UI round-trip.
  await assert.rejects(
    () => ex.reveal({ type: 'focus_host', hostId: 'nope' }),
    /Unknown host 'nope'/,
  );
  assert.equal(payloads.length, 3);

  // Headless embedding (no uiRequest binding): clear error, no crash.
  const headless = new ClaudeExecutor(fakeEnv([host({})]).env);
  await assert.rejects(() => headless.listTerminals(), /window is not available/);
});

test('reveal_in_app validates per-action params at the tool layer', async () => {
  await withServer(
    async (info) => {
      const { client: c, transport } = client(info);
      await c.connect(transport);
      const missing = await c.callTool({
        name: 'reveal_in_app',
        arguments: { action: 'open_dir', host: 'edge-01' },
      });
      assert.equal(missing.isError, true);
      assert.match(
        (missing.content as Array<{ text: string }>)[0].text,
        /'path' is required/,
      );
      const okCall = await c.callTool({
        name: 'reveal_in_app',
        arguments: { action: 'focus_host', host: 'edge-01' },
      });
      assert.notEqual(okCall.isError, true);
      await c.close();
    },
    { uiRequest: async () => ({ done: true }) },
  );
});

// ---- executor: transfers & port forwards -----------------------------------

test('startTransfer maps refs to endpoints, local to the relay side', async () => {
  const requests: unknown[] = [];
  const env = fakeEnv([host({})], {
    startTransfer: (req) => {
      requests.push(req);
      return 'job-1';
    },
    transferList: () => [
      {
        id: 'job-1',
        label: 'x',
        src: { hostId: 'h1', dir: '/srv' },
        dest: { hostId: null, dir: '/tmp' },
        op: 'copy',
        stages: 2,
        stage: 0,
        bytesDone: 0,
        bytesTotal: 100,
        currentName: null,
        status: 'queued',
      },
    ],
  }).env;
  const ex = new ClaudeExecutor(env);

  const snap = ex.startTransfer('edge-01', '/srv', ['dump.sql'], 'local', '/tmp', {
    verify: true,
  });
  assert.equal(snap.id, 'job-1');
  assert.deepEqual(requests[0], {
    src: { hostId: 'h1', dir: '/srv' },
    dest: { hostId: null, dir: '/tmp' },
    names: ['dump.sql'],
    op: 'copy',
    conflict: 'rename',
    verify: true,
  });

  assert.equal(ex.transferStatus('job-1').length, 1);
  assert.throws(() => ex.transferStatus('gone'), /Unknown transfer job 'gone'/);
  assert.throws(() => ex.startTransfer('edge-01', '/srv', [], 'local', '/tmp'), /not be empty/);

  // Env without the transfer bindings (headless embedding).
  const bare = new ClaudeExecutor(fakeEnv([host({})]).env);
  assert.throws(() => bare.transferStatus(), /not available/);
});

test('port forward executor methods delegate and surface unknown ids', async () => {
  const closed: string[] = [];
  const info = {
    id: 'fwd-1',
    hostId: 'h1',
    hostName: 'edge-01',
    remoteHost: '127.0.0.1',
    remotePort: 5432,
    localHost: '127.0.0.1' as const,
    localPort: 40001,
    startedAt: 0,
  };
  const env = fakeEnv([host({})], {
    openForward: async (h, remotePort) => ({ ...info, hostId: h.id, remotePort }),
    listForwards: () => [info],
    closeForward: (id) => {
      closed.push(id);
      return id === 'fwd-1';
    },
  }).env;
  const ex = new ClaudeExecutor(env);

  const f = await ex.portForward('edge-01', 5432);
  assert.equal(f.hostId, 'h1');
  assert.equal(ex.listForwards()[0].id, 'fwd-1');
  ex.closeForward('fwd-1');
  assert.throws(() => ex.closeForward('nope'), /Unknown forward 'nope'/);
  assert.deepEqual(closed, ['fwd-1', 'nope']);
});

// ---- tools: output truncation ----------------------------------------------

test('truncateOutput keeps head and tail around a marker', () => {
  assert.equal(truncateOutput('short'), 'short');
  const big = 'a'.repeat(10_000) + 'MIDDLE' + 'z'.repeat(10_000);
  const cut = truncateOutput(big, 1000);
  assert.ok(cut.length < big.length);
  assert.ok(cut.startsWith('aaa'));
  assert.ok(cut.endsWith('zzz'));
  assert.match(cut, /bytes truncated/);
  assert.ok(!cut.includes('MIDDLE'));
});

// ---- MCP server over real HTTP ---------------------------------------------

async function withServer(
  fn: (info: { url: string; token: string }) => Promise<void>,
  over: Partial<ClaudeExecutorEnv> = {},
) {
  const server = new PearMcpServer(new ClaudeExecutor(fakeEnv([host({})], over).env));
  const info = await server.start();
  try {
    await fn(info);
  } finally {
    await server.stop();
  }
}

function client(info: { url: string; token: string }, token = info.token) {
  const transport = new StreamableHTTPClientTransport(new URL(info.url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  return { client: new Client({ name: 'test', version: '0' }), transport };
}

test('mcp server lists and calls tools over streamable HTTP', async () => {
  await withServer(async (info) => {
    const { client: c, transport } = client(info);
    await c.connect(transport);
    const tools = await c.listTools();
    assert.deepEqual(tools.tools.map((t) => t.name).sort(), [
      'close_port_forward',
      'edit_file',
      'host_vitals',
      'list_dir',
      'list_guests',
      'list_hosts',
      'list_port_forwards',
      'list_terminals',
      'port_forward',
      'read_file',
      'read_terminal',
      'reveal_in_app',
      'run_command',
      'service_logs',
      'service_ps',
      'transfer_between_hosts',
      'transfer_status',
      'write_file',
    ]);
    const result = await c.callTool({
      name: 'run_command',
      arguments: { host: 'edge-01', command: 'whoami' },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    assert.match(text, /exit code: 0/);
    assert.match(text, /ok/);
    await c.close();
  });
});

test('mcp server surfaces executor failures as tool errors, not crashes', async () => {
  await withServer(
    async (info) => {
      const { client: c, transport } = client(info);
      await c.connect(transport);
      const result = await c.callTool({
        name: 'run_command',
        arguments: { host: 'edge-01', command: 'whoami' },
      });
      assert.equal(result.isError, true);
      const text = (result.content as Array<{ type: string; text: string }>)[0].text;
      assert.match(text, /connection lost/);
      await c.close();
    },
    {
      exec: async () => {
        throw new Error('SSH connection lost');
      },
    },
  );
});

test('mcp server rejects bad tokens and non-POST methods', async () => {
  await withServer(async (info) => {
    const bad = await fetch(info.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer wrong' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    });
    assert.equal(bad.status, 401);

    const get = await fetch(info.url, {
      headers: { authorization: `Bearer ${info.token}` },
    });
    assert.equal(get.status, 405);
  });
});

// ---- workspace provisioning ------------------------------------------------

test('provisionClaudeWorkspace writes .mcp.json and CLAUDE.md', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pear-claude-'));
  await provisionClaudeWorkspace({
    dir,
    url: 'http://127.0.0.1:12345/mcp',
    token: 'tok-abc',
  });
  const mcp = JSON.parse(await readFile(join(dir, '.mcp.json'), 'utf8'));
  assert.equal(mcp.mcpServers.pear.type, 'http');
  assert.equal(mcp.mcpServers.pear.url, 'http://127.0.0.1:12345/mcp');
  assert.equal(mcp.mcpServers.pear.headers.Authorization, 'Bearer tok-abc');
  const md = await readFile(join(dir, 'CLAUDE.md'), 'utf8');
  assert.match(md, /list_hosts/);
  assert.match(md, /LOCAL machine/);

  // Regeneration (new port/token every launch) must overwrite cleanly.
  await provisionClaudeWorkspace({ dir, url: 'http://127.0.0.1:9/mcp', token: 't2' });
  const again = JSON.parse(await readFile(join(dir, '.mcp.json'), 'utf8'));
  assert.equal(again.mcpServers.pear.headers.Authorization, 'Bearer t2');
});
