import { spawn, type ChildProcess } from 'node:child_process';
import { shq } from '../../shq';
import { ChatStreamParser } from '../../claude/parser';
import type { ClaudeChatEvent } from '../../claude/events';

export interface ChatSessionOpts {
  /** The provisioned workspace dir (cwd; holds .mcp.json). */
  dir: string;
  /** Resume an earlier CLI session instead of starting fresh. */
  resume?: string;
  /** Model alias/id passed as --model; null/absent = the CLI's default. */
  model?: string | null;
}

const CLI_ARGS = [
  '-p',
  '--input-format stream-json',
  '--output-format stream-json',
  '--include-partial-messages',
  '--verbose',
  '--mcp-config .mcp.json',
  '--strict-mcp-config',
  '--permission-prompt-tool mcp__pear__approve',
  '--allowedTools ' +
    [
      'mcp__pear__list_hosts',
      'mcp__pear__read_file',
      'mcp__pear__list_dir',
      'mcp__pear__host_vitals',
      'mcp__pear__service_ps',
      'mcp__pear__service_logs',
      'mcp__pear__list_guests',
      'mcp__pear__list_terminals',
      'mcp__pear__read_terminal',
      'mcp__pear__reveal_in_app',
      'mcp__pear__transfer_status',
      'mcp__pear__list_port_forwards',
      'mcp__pear__close_port_forward',
    ].join(','),
];

/**
 * One chat-mode conversation: the user's own `claude` CLI as a piped child
 * process driven over stream-json. The process spawns lazily on the first
 * send and stays alive across turns (stdin open). interrupt() SIGTERMs it;
 * the next send respawns with --resume so the conversation continues.
 */
export class ClaudeChatSession {
  private child: ChildProcess | null = null;
  private parser = new ChatStreamParser();
  private stderrTail = '';
  private interrupted = false;
  private disposed = false;
  private model: string | null;
  /** CLI session id, from the init event; used for --resume respawns. */
  sessionId: string | null = null;

  constructor(
    private readonly opts: ChatSessionOpts,
    private readonly onEvent: (e: ClaudeChatEvent) => void,
  ) {
    this.sessionId = opts.resume ?? null;
    this.model = opts.model ?? null;
  }

  /** Takes effect on the next (re)spawn — pair with interrupt() to apply now. */
  setModel(model: string | null): void {
    this.model = model;
  }

  get running(): boolean {
    return this.child !== null;
  }

  send(text: string): void {
    if (this.disposed) throw new Error('Chat session disposed');
    if (!this.child) this.spawnProcess();
    this.onEvent({ type: 'user', text });
    this.child!.stdin!.write(
      JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n',
    );
  }

  /** Stops the running turn. The CLI session survives (resume on next send). */
  interrupt(): void {
    if (!this.child) return;
    this.interrupted = true;
    this.child.kill('SIGTERM');
  }

  dispose(): void {
    this.disposed = true;
    this.interrupted = true;
    this.child?.kill('SIGTERM');
    this.child = null;
  }

  private spawnProcess(): void {
    const posix = process.platform !== 'win32';
    const args = [...CLI_ARGS];
    if (this.sessionId) args.push(`--resume ${shq(this.sessionId)}`);
    if (this.model) args.push(`--model ${shq(this.model)}`);
    const command = `claude ${args.join(' ')}`;
    const shell = posix
      ? (process.env['SHELL'] ?? '/bin/bash')
      : (process.env['COMSPEC'] ?? 'cmd.exe');
    // Login shell so the user's PATH applies (same as the terminal mode PTY).
    const child = spawn(shell, posix ? ['-l', '-c', command] : ['/c', command], {
      cwd: this.opts.dir,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    this.parser = new ChatStreamParser();
    this.interrupted = false;
    this.stderrTail = '';

    child.stdout!.on('data', (chunk: Buffer) => {
      for (const event of this.parser.push(chunk.toString('utf8'))) {
        if (event.type === 'init') this.sessionId = event.sessionId;
        this.onEvent(event);
      }
    });
    child.stderr!.on('data', (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString('utf8')).slice(-4096);
    });
    child.on('error', (err) => {
      this.child = null;
      this.onEvent({ type: 'error', message: `Failed to start claude: ${err.message}` });
      this.onEvent({ type: 'turn-done' });
    });
    child.on('close', (code) => {
      if (this.child !== child) return;
      this.child = null;
      if (this.interrupted || this.disposed) {
        this.onEvent({ type: 'turn-done' });
        return;
      }
      if (code !== 0) {
        const detail = this.stderrTail.trim().split('\n').slice(-3).join('\n');
        this.onEvent({
          type: 'error',
          message: `claude exited with code ${code}${detail ? ` — ${detail}` : ''}`,
        });
        this.onEvent({ type: 'turn-done' });
      }
      // code 0: the result event already carried turn-done.
    });
  }
}
