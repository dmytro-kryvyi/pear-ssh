import { spawn, type ChildProcess } from 'node:child_process';
import { shq } from '../../shq';
import { ChatStreamParser } from '../../claude/parser';
import type { ClaudeChatEvent } from '../../claude/events';
import { loginShell } from './shell';

export interface ChatSessionOpts {
  /** The provisioned workspace dir (cwd; holds .mcp.json). */
  dir: string;
  /** Resume an earlier CLI session instead of starting fresh. */
  resume?: string;
  /** Model alias/id passed as --model; null/absent = the CLI's default. */
  model?: string | null;
  /**
   * How long an idle process (no turn in flight) is kept before it is
   * stopped. The next send respawns with --resume, so a fresh process picks
   * up whatever credentials the CLI holds *now* — a process parked for hours
   * races the user's terminal `claude` over the rotating OAuth refresh token
   * and ends up "logged out". 0 disables.
   */
  idleMs?: number;
  /** The CLI to run (tests point this at a fake). */
  bin?: string;
}

export const DEFAULT_IDLE_MS = 60_000;

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
 * send and stays alive while a turn is in flight; once the reply is in it is
 * kept for `idleMs` for snappy follow-ups, then stopped. interrupt() SIGTERMs
 * it; the next send respawns with --resume so the conversation continues.
 */
export class ClaudeChatSession {
  private child: ChildProcess | null = null;
  private parser = new ChatStreamParser();
  private stderrTail = '';
  private interrupted = false;
  private disposed = false;
  /** A user turn was sent and its result has not arrived yet. */
  private turnOpen = false;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
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
    this.clearIdleTimer();
    if (!this.child) this.spawnProcess();
    this.turnOpen = true;
    // The runtime records the 'user' event — sessions only transmit.
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
    this.clearIdleTimer();
    this.child?.kill('SIGTERM');
    this.child = null;
  }

  /** Every event the CLI produces passes here so turn state stays accurate. */
  private emit(event: ClaudeChatEvent): void {
    if (event.type === 'turn-done') {
      this.turnOpen = false;
      this.armIdleTimer();
    }
    this.onEvent(event);
  }

  private armIdleTimer(): void {
    this.clearIdleTimer();
    const ms = this.opts.idleMs ?? DEFAULT_IDLE_MS;
    if (ms <= 0 || !this.child) return;
    this.idleTimer = setTimeout(() => this.stopIdle(), ms);
    this.idleTimer.unref?.();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  /** Quietly retire an idle process; the session id survives for --resume. */
  private stopIdle(): void {
    this.idleTimer = null;
    if (!this.child || this.turnOpen) return;
    const child = this.child;
    this.child = null;
    child.kill('SIGTERM');
  }

  private spawnProcess(): void {
    const args = [...CLI_ARGS];
    if (this.sessionId) args.push(`--resume ${shq(this.sessionId)}`);
    if (this.model) args.push(`--model ${shq(this.model)}`);
    const command = `${this.opts.bin ?? 'claude'} ${args.join(' ')}`;
    // Login shell so the user's PATH applies (same as the terminal mode PTY).
    const { file, commandArgs } = loginShell();
    const child = spawn(file, commandArgs(command), {
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
        this.emit(event);
      }
    });
    child.stderr!.on('data', (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString('utf8')).slice(-4096);
    });
    child.on('error', (err) => {
      if (this.child === child) this.child = null;
      if (!this.turnOpen) return;
      this.emit({ type: 'error', message: `Failed to start claude: ${err.message}` });
      this.emit({ type: 'turn-done' });
    });
    child.on('close', (code) => {
      // An idle stop (stopIdle) or a superseded spawn already detached this
      // child; nothing was in flight, so nothing is owed to the UI.
      if (this.child !== child) return;
      this.child = null;
      if (!this.turnOpen) return;
      if (this.interrupted || this.disposed) {
        this.emit({ type: 'turn-done' });
        return;
      }
      if (code !== 0) {
        const detail = this.stderrTail.trim().split('\n').slice(-3).join('\n');
        this.emit({
          type: 'error',
          message: `claude exited with code ${code}${detail ? ` — ${detail}` : ''}`,
        });
      }
      // A clean exit mid-turn (no result event) still owes the UI a turn-done.
      this.emit({ type: 'turn-done' });
    });
  }
}
