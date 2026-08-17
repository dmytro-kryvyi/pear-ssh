import { describe, expect, it } from 'vitest';
import { ClaudeExecutor, PermissionBridge, type ClaudeChatEvent, type HostConfig } from '@pear/core';
import { createNativeBackend } from './backend';
import type { AsyncCipher, AsyncKv } from './kv';
import type { HostKeyGate } from './transport';
import { SshEventHub } from './event-hub';
import { McpWebViewServer } from './claude/mcp-handler';
import { SshChatSession } from './claude/ssh-chat-session';
import type {
  McpRequestEvent,
  PearSshPlugin,
  ShellDataEvent,
  ShellExitEvent,
} from './pear-ssh';

// ---------------------------------------------------------- plugin test doll

type Listener = (e: never) => void;

class FakePlugin implements Partial<PearSshPlugin> {
  private listeners = new Map<string, Set<Listener>>();
  calls: { method: string; args: unknown }[] = [];
  nextChannel = 0;
  mcpResponses: { id: string; status: number; body: string }[] = [];

  emit(event: string, e: unknown): void {
    for (const cb of this.listeners.get(event) ?? []) (cb as (x: unknown) => void)(e);
  }

  addListener(event: string, cb: Listener): Promise<{ remove: () => Promise<void> }> {
    const set = this.listeners.get(event) ?? new Set();
    set.add(cb);
    this.listeners.set(event, set);
    return Promise.resolve({ remove: async () => void set.delete(cb) });
  }

  /** Scriptable stdout for exec commands (setsid probe, runner scripts…). */
  execHandler: (command: string) => string = (command) => {
    if (command.includes('command -v setsid')) return 'detach';
    if (command.includes('mkfifo')) return 'READY'; // launch
    if (command.includes('echo SENT')) return 'SENT'; // FIFO write
    if (command.includes('echo RUNNING')) return 'RUNNING'; // status check
    return '';
  };
  exec(o: { sessionId: string; command: string }): Promise<{ code: number; stdout: string; stderr: string }> {
    this.calls.push({ method: 'exec', args: o });
    return Promise.resolve({ code: 0, stdout: this.execHandler(o.command), stderr: '' });
  }
  execs(): string[] {
    return this.calls
      .filter((c) => c.method === 'exec')
      .map((c) => (c.args as { command: string }).command);
  }
  shellOpen(o: object): Promise<{ channelId: string }> {
    this.calls.push({ method: 'shellOpen', args: o });
    return Promise.resolve({ channelId: `ch${++this.nextChannel}` });
  }
  shellWrite(o: object): Promise<void> {
    this.calls.push({ method: 'shellWrite', args: o });
    return Promise.resolve();
  }
  shellSignal(o: object): Promise<void> {
    this.calls.push({ method: 'shellSignal', args: o });
    return Promise.resolve();
  }
  shellClose(o: object): Promise<void> {
    this.calls.push({ method: 'shellClose', args: o });
    return Promise.resolve();
  }
  mcpRespond(o: { id: string; status: number; body: string }): Promise<void> {
    this.mcpResponses.push(o);
    return Promise.resolve();
  }

  writes(): string[] {
    return this.calls
      .filter((c) => c.method === 'shellWrite')
      .map((c) => (c.args as { data: string }).data);
  }
}

const tick = () => new Promise((r) => setTimeout(r, 5));

// ---------------------------------------------------------------- MCP server

function executor(): ClaudeExecutor {
  return new ClaudeExecutor({
    hosts: () => [
      { id: 'h1', name: 'edge-01', host: '10.0.0.1', port: 22, user: 'root', kind: 'docker' },
    ],
    isConnected: () => true,
    exec: async () => ({ code: 0, stdout: 'ok', stderr: '' }),
    readFile: async () => '',
    writeFile: async () => {},
    listDir: async (_h, path) => ({ path, entries: [] }),
  });
}

describe('McpWebViewServer', () => {
  it('rejects a bad bearer token', async () => {
    const plugin = new FakePlugin();
    new McpWebViewServer(plugin as unknown as PearSshPlugin, 'secret', executor(), new PermissionBridge(() => {}));
    plugin.emit('mcpRequest', {
      id: 'r1',
      path: '/mcp',
      authorization: 'Bearer wrong',
      body: '{}',
    } satisfies McpRequestEvent);
    await tick();
    expect(plugin.mcpResponses[0].status).toBe(401);
  });

  it('serves list_hosts through the tool surface', async () => {
    const plugin = new FakePlugin();
    new McpWebViewServer(plugin as unknown as PearSshPlugin, 'tok', executor(), new PermissionBridge(() => {}));
    const rpc = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'list_hosts', arguments: {} },
    };
    plugin.emit('mcpRequest', {
      id: 'r2',
      path: '/mcp',
      authorization: 'Bearer tok',
      body: JSON.stringify(rpc),
    } satisfies McpRequestEvent);
    // tool runs async (executor); poll for the response
    for (let i = 0; i < 40 && plugin.mcpResponses.length === 0; i++) await tick();
    const res = plugin.mcpResponses[0];
    expect(res.status).toBe(200);
    const payload = JSON.parse(res.body);
    expect(payload.id).toBe(1);
    const text = payload.result.content[0].text as string;
    expect(text).toContain('edge-01');
  });

  it('answers notifications with 202 and no body', async () => {
    const plugin = new FakePlugin();
    new McpWebViewServer(plugin as unknown as PearSshPlugin, 'tok', executor(), new PermissionBridge(() => {}));
    plugin.emit('mcpRequest', {
      id: 'r3',
      path: '/mcp',
      authorization: 'Bearer tok',
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    } satisfies McpRequestEvent);
    await tick();
    expect(plugin.mcpResponses[0]).toMatchObject({ status: 202, body: '' });
  });
});

// ------------------------------------------------------------- chat session

describe('SshChatSession', () => {
  const INIT_LINE =
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-9', model: 'claude' }) +
    '\n';

  function session(plugin: FakePlugin, onEvent: (e: ClaudeChatEvent) => void) {
    const hub = new SshEventHub(plugin as unknown as PearSshPlugin);
    return new SshChatSession(
      { plugin: plugin as unknown as PearSshPlugin, hub, dir: '/home/u/.pear-claude', sessionId: async () => 's1' },
      {},
      onEvent,
    );
  }

  function errorOf(events: ClaudeChatEvent[]) {
    return events.find((e) => e.type === 'error') as Extract<ClaudeChatEvent, { type: 'error' }>;
  }

  it('detached: probes setsid, launches a runner, tails the output, writes the FIFO', async () => {
    const plugin = new FakePlugin();
    const events: ClaudeChatEvent[] = [];
    const chat = session(plugin, (e) => events.push(e));

    chat.send('hello claude');
    await tick();

    const execs = plugin.execs();
    expect(execs[0]).toContain('command -v setsid');
    const launch = execs.find((c) => c.includes('mkfifo'))!;
    expect(launch).toContain('setsid sh -c');
    expect(launch).toContain('.pear-claude/run/');
    expect(launch).toContain('claude ');

    // the stream rides a tail of out.jsonl, not claude's own stdio
    const open = plugin.calls.find((c) => c.method === 'shellOpen')!.args as {
      pty: boolean;
      command: string;
    };
    expect(open.pty).toBe(false);
    expect(open.command).toContain('tail -c +1 -f');

    // the user turn went through the liveness-guarded FIFO write
    const write = execs.find((c) => c.includes('echo SENT'))!;
    expect(write).toContain('hello claude');
    expect(write).toContain('kill -0');

    // tailed stream-json parses into chat events
    plugin.emit('shellData', { channelId: 'ch1', data: INIT_LINE } satisfies ShellDataEvent);
    await tick();
    expect(chat.sessionId).toBe('sess-9');
    expect(events.some((e) => e.type === 'init')).toBe(true);
  });

  it('a dropped connection mid-turn re-tails from the consumed byte offset, no error', async () => {
    const plugin = new FakePlugin();
    const events: ClaudeChatEvent[] = [];
    const chat = session(plugin, (e) => events.push(e));
    chat.send('hi');
    await tick();
    plugin.emit('shellData', { channelId: 'ch1', data: INIT_LINE } satisfies ShellDataEvent);
    plugin.emit('shellExit', { channelId: 'ch1', code: -1 } satisfies ShellExitEvent);
    await tick();

    expect(events.some((e) => e.type === 'error')).toBe(false);
    const opens = plugin.calls
      .filter((c) => c.method === 'shellOpen')
      .map((c) => (c.args as { command: string }).command);
    expect(opens).toHaveLength(2);
    expect(opens[1]).toContain(`tail -c +${INIT_LINE.length + 1} -f`);
    // and it checked whether the runner survived the gap
    expect(plugin.execs().some((c) => c.includes('echo RUNNING'))).toBe(true);
  });

  it('a runner that died while the phone was away settles the turn after catch-up', async () => {
    const plugin = new FakePlugin();
    const events: ClaudeChatEvent[] = [];
    const chat = session(plugin, (e) => events.push(e));
    chat.send('hi');
    await tick();
    plugin.emit('shellData', { channelId: 'ch1', data: INIT_LINE } satisfies ShellDataEvent);

    const base = plugin.execHandler;
    plugin.execHandler = (c) =>
      c.includes('echo RUNNING') ? `EXIT 1 ${INIT_LINE.length}\nboom` : base(c);
    plugin.emit('shellExit', { channelId: 'ch1', code: -1 } satisfies ShellExitEvent);
    await tick();

    expect(errorOf(events).message).toContain('exit 1');
    expect(errorOf(events).message).toContain('boom');
    expect(events.some((e) => e.type === 'turn-done')).toBe(true);
  });

  it('the exit sentinel in the tailed stream surfaces a mid-turn crash', async () => {
    const plugin = new FakePlugin();
    const events: ClaudeChatEvent[] = [];
    const chat = session(plugin, (e) => events.push(e));
    chat.send('hi');
    await tick();
    plugin.emit('shellData', {
      channelId: 'ch1',
      data: '\n{"type":"pear_runner_exit","code":143}\n',
    } satisfies ShellDataEvent);
    await tick();

    expect(errorOf(events).message).toContain('exit 143');
    expect(events.some((e) => e.type === 'turn-done')).toBe(true);
  });

  it('a dead runner on send relaunches with --resume and retries the write', async () => {
    const plugin = new FakePlugin();
    const chat = session(plugin, () => {});
    chat.send('start');
    await tick();
    plugin.emit('shellData', { channelId: 'ch1', data: INIT_LINE } satisfies ShellDataEvent);

    const base = plugin.execHandler;
    let deadOnce = true;
    plugin.execHandler = (c) => {
      if (c.includes('echo SENT') && deadOnce) {
        deadOnce = false;
        return 'DEAD';
      }
      return base(c);
    };
    chat.send('again');
    await tick();

    const launches = plugin.execs().filter((c) => c.includes('mkfifo'));
    expect(launches).toHaveLength(2);
    expect(launches[1]).toContain('--resume');
    expect(launches[1]).toContain('sess-9');
    const writes = plugin.execs().filter((c) => c.includes('echo SENT'));
    expect(writes.at(-1)).toContain('again');
  });

  it('interrupt kills the detached process group and closes the turn', async () => {
    const plugin = new FakePlugin();
    const events: ClaudeChatEvent[] = [];
    const chat = session(plugin, (e) => events.push(e));
    chat.send('hi');
    await tick();
    chat.interrupt();
    await tick();
    expect(plugin.execs().some((c) => c.includes('kill -TERM'))).toBe(true);
    expect(events.some((e) => e.type === 'turn-done')).toBe(true);
  });

  // ---- direct fallback (hosts without setsid, e.g. macOS) ----

  function directPlugin(): FakePlugin {
    const plugin = new FakePlugin();
    const base = plugin.execHandler;
    plugin.execHandler = (c) => (c.includes('command -v setsid') ? 'direct' : base(c));
    return plugin;
  }

  it('direct: opens a non-PTY claude channel and writes stdin over it', async () => {
    const plugin = directPlugin();
    const events: ClaudeChatEvent[] = [];
    const chat = session(plugin, (e) => events.push(e));

    chat.send('hello claude');
    await tick();

    const open = plugin.calls.find((c) => c.method === 'shellOpen')!.args as {
      pty: boolean;
      command: string;
    };
    expect(open.pty).toBe(false);
    expect(open.command).toContain('.pear-claude');
    expect(open.command).toContain('claude ');

    const stdin = JSON.parse(plugin.writes()[0]);
    expect(stdin).toMatchObject({ type: 'user', message: { role: 'user', content: 'hello claude' } });

    plugin.emit('shellData', { channelId: 'ch1', data: INIT_LINE } satisfies ShellDataEvent);
    await tick();
    expect(chat.sessionId).toBe('sess-9');
    expect(events.some((e) => e.type === 'init')).toBe(true);
  });

  it('direct: interrupt signals TERM to the channel', async () => {
    const plugin = directPlugin();
    const chat = session(plugin, () => {});
    chat.send('hi');
    await tick();
    chat.interrupt();
    expect(plugin.calls.some((c) => c.method === 'shellSignal')).toBe(true);
  });

  it('direct: non-zero exit with no result surfaces an error event', async () => {
    const plugin = directPlugin();
    const events: ClaudeChatEvent[] = [];
    const chat = session(plugin, (e) => events.push(e));
    chat.send('hi');
    await tick();
    plugin.emit('shellStderr', { channelId: 'ch1', data: 'claude: not found\n' } satisfies ShellDataEvent);
    plugin.emit('shellExit', { channelId: 'ch1', code: 127 } satisfies ShellExitEvent);
    await tick();
    const error = errorOf(events);
    expect(error.message).toContain('127');
    expect(error.message).toContain('not found');
  });
});

// -------------------------------------------------- graceful setup errors

/** Full-ish plugin doll for the backend's Claude setup path. */
class SetupPlugin extends FakePlugin {
  forwardError: { message: string; code?: string } | null = null;
  claudeInstalled = true;

  connect(): Promise<{ sessionId: string }> {
    this.calls.push({ method: 'connect', args: {} });
    return Promise.resolve({ sessionId: 'sess' });
  }
  isConnected(): Promise<{ connected: boolean }> {
    return Promise.resolve({ connected: true });
  }
  exec(o: { command: string }): Promise<{ code: number; stdout: string; stderr: string }> {
    this.calls.push({ method: 'exec', args: o });
    if (o.command.includes('$HOME')) return Promise.resolve({ code: 0, stdout: '/home/u', stderr: '' });
    if (o.command.includes('command -v claude')) {
      return Promise.resolve({ code: 0, stdout: this.claudeInstalled ? 'yes' : 'no', stderr: '' });
    }
    return Promise.resolve({ code: 0, stdout: '', stderr: '' });
  }
  mcpStart(): Promise<{ port: number }> {
    return Promise.resolve({ port: 5000 });
  }
  mcpStop(): Promise<void> {
    return Promise.resolve();
  }
  remoteForwardOpen(): Promise<{ remotePort: number }> {
    if (this.forwardError) return Promise.reject(this.forwardError);
    return Promise.resolve({ remotePort: 40000 });
  }
  remoteForwardClose(): Promise<void> {
    return Promise.resolve();
  }
}

class MemKv2 implements AsyncKv {
  readonly map = new Map<string, string>();
  async get(key: string) { return this.map.get(key) ?? null; }
  async set(key: string, value: string) { this.map.set(key, value); }
}

const passCipher: AsyncCipher = {
  available: async () => true,
  encrypt: async (p) => `enc:${p}`,
  decrypt: async (c) => c.replace(/^enc:/, ''),
};

const okGate: HostKeyGate = { confirm: async () => true };

async function backendWithHost(plugin: SetupPlugin) {
  const api = createNativeBackend({ plugin: plugin as unknown as PearSshPlugin, gate: okGate, kv: new MemKv2(), cipher: passCipher });
  const saved = await api.hosts.upsert({
    name: 'edge-01', host: '10.0.0.1', port: 22, user: 'root', kind: 'docker',
    auth: { method: 'password', password: 'pw' },
  } as Omit<HostConfig, 'id'>);
  return { api, hostId: saved.id };
}

describe('Claude setup — graceful errors', () => {
  it('no Claude host set → asks the user to pick one', async () => {
    const { api } = await backendWithHost(new SetupPlugin());
    await expect(api.claude.chatSend('hi')).rejects.toThrow(/pick a claude host/i);
  });

  it('forwarding disabled → names AllowTcpForwarding', async () => {
    const plugin = new SetupPlugin();
    plugin.forwardError = { message: 'refused', code: 'FORWARD_DENIED' };
    const { api, hostId } = await backendWithHost(plugin);
    await api.setClaudeHost(hostId);
    await expect(api.claude.chatSend('hi')).rejects.toThrow(/AllowTcpForwarding/);
  });

  it('CLI missing → tells the user to install and log in', async () => {
    const plugin = new SetupPlugin();
    plugin.claudeInstalled = false;
    const { api, hostId } = await backendWithHost(plugin);
    await api.setClaudeHost(hostId);
    await expect(api.claude.chatSend('hi')).rejects.toThrow(/claude login/);
  });
});
