import {
  ChatStreamParser,
  shq,
  utf8ByteLength,
  uuid,
  type ChatSessionHandle,
  type ClaudeChatEvent,
} from '@pear/core';
import type { SshEventHub } from '../event-hub';
import type { PearSshPlugin } from '../pear-ssh';

/** Everything an SSH chat session needs from the backend. */
export interface SshChatEnv {
  plugin: PearSshPlugin;
  hub: SshEventHub;
  /**
   * Plugin session id of the connected Claude host. The backend redials and
   * re-establishes the MCP tunnel (same remote port) when the connection has
   * dropped since the last call.
   */
  sessionId(): Promise<string>;
  /** Provisioned workspace dir on the Claude host. */
  dir: string;
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
    ].join(','),
];

const RECONNECT_TRIES = 20;
const RECONNECT_DELAY_MS = 3000;

// ---------------------------------------------------------- runner scripts
//
// The detached runner keeps a claude turn alive when the phone drops off:
// claude runs on the Claude host under setsid (its own session, so sshd's
// process-group kill on channel close never reaches it), stdin from a FIFO
// held open read-write (no EOF between messages), stream-json appended to
// out.jsonl. The phone streams the file with `tail -c +offset -f` and, after
// a disconnect, re-tails from the byte offset it had consumed — the reply
// catches up instead of dying. Everything is wrapped `sh -c` so a fish/zsh
// login shell on the host never parses POSIX syntax.

const runFile = (runDir: string, name: string) => shq(`${runDir}/${name}`);

/** Probe: can this host detach processes? (setsid is util-linux; macOS lacks it.) */
export const SETSID_PROBE = `sh -c 'command -v setsid >/dev/null 2>&1 && echo detach || echo direct'`;

/** Launch the detached runner; prints READY once the pid file exists. */
export function launchCommand(
  dir: string,
  runDir: string,
  claudeCmd: string,
  prevRunDir?: string | null,
): string {
  // fd3 = FIFO read-write (its own writer, so reads never see EOF); fd4 =
  // out.jsonl, opened before the pid file so the tail never races a missing
  // file. The login shell runs claude so nvm/bun PATHs apply.
  // The trailing sentinel travels through the tail itself, so a claude that
  // dies mid-turn (crash, bad --resume) surfaces without any host polling.
  // The chat parser ignores the unknown type; the session intercepts it.
  const inner =
    `cd ${shq(dir)}; exec 3<>${runFile(runDir, 'in')} 4>>${runFile(runDir, 'out.jsonl')}; ` +
    `echo $$ >${runFile(runDir, 'pid')}; ` +
    `"$SHELL" -lc ${shq(claudeCmd)} <&3 >&4 2>>${runFile(runDir, 'err.log')}; ` +
    `c=$?; echo $c >${runFile(runDir, 'exit')}; ` +
    `printf '\\n{"type":"pear_runner_exit","code":%s}\\n' "$c" >&4`;
  const script =
    (prevRunDir ? `rm -rf ${shq(prevRunDir)}; ` : '') +
    // Sweep runner dirs older than 2 days — crashed apps leave them behind.
    `find ${shq(dir + '/run')} -mindepth 1 -maxdepth 1 -mmin +2880 -exec rm -rf {} + 2>/dev/null; ` +
    `mkdir -p ${shq(runDir)} && mkfifo ${runFile(runDir, 'in')} || exit 9; ` +
    `setsid sh -c ${shq(inner)} >/dev/null 2>&1 </dev/null & ` +
    `i=0; while [ ! -s ${runFile(runDir, 'pid')} ] && [ "$i" -lt 50 ]; do sleep 0.1; i=$((i+1)); done; ` +
    `[ -s ${runFile(runDir, 'pid')} ] && echo READY || echo FAILED`;
  return `sh -c ${shq(script)}`;
}

/** Deliver one stream-json line to the runner's FIFO; prints SENT, or DEAD
 *  when the runner's process group is gone (so the write can never block). */
export function writeCommand(runDir: string, line: string): string {
  const script =
    `p=$(cat ${runFile(runDir, 'pid')} 2>/dev/null) || { echo DEAD; exit 0; }; ` +
    `if kill -0 -- "-$p" 2>/dev/null; ` +
    `then printf '%s\\n' ${shq(line)} >${runFile(runDir, 'in')} && echo SENT; ` +
    `else echo DEAD; fi`;
  return `sh -c ${shq(script)}`;
}

/** TERM the runner's whole process group (claude included). */
export function killCommand(runDir: string, remove: boolean): string {
  const script =
    `p=$(cat ${runFile(runDir, 'pid')} 2>/dev/null) && kill -TERM -- "-$p" 2>/dev/null; ` +
    (remove ? `sleep 0.2; rm -rf ${shq(runDir)}; ` : '') +
    `true`;
  return `sh -c ${shq(script)}`;
}

/** One line "EXIT <code> <outBytes>" when the runner died (plus an err.log
 *  tail on following lines), or "RUNNING". */
export function statusCommand(runDir: string): string {
  const script =
    `if [ -f ${runFile(runDir, 'exit')} ]; then ` +
    `printf 'EXIT %s %s\\n' "$(cat ${runFile(runDir, 'exit')})" ` +
    `"$(wc -c <${runFile(runDir, 'out.jsonl')} 2>/dev/null || echo 0)"; ` +
    `tail -n 3 ${runFile(runDir, 'err.log')} 2>/dev/null; ` +
    `else echo RUNNING; fi`;
  return `sh -c ${shq(script)}`;
}

/** Follow out.jsonl from a 1-based byte offset. */
export function tailCommand(runDir: string, fromByte: number): string {
  return `sh -c ${shq(`tail -c +${fromByte} -f ${runFile(runDir, 'out.jsonl')}`)}`;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * One chat conversation with the Claude host's `claude` CLI, driven over
 * stream-json. Two modes, probed per host:
 *
 * - `detach` (Linux hosts): claude runs detached under setsid writing to a
 *   file the phone tails — screen-off, backgrounding, or a dropped SSH
 *   connection no longer kills a reply in flight; the session re-dials and
 *   re-tails from its byte offset, catching up on whatever streamed while
 *   the phone was away.
 * - `direct` (no setsid, e.g. macOS): the M4 behavior — claude on a
 *   streaming non-PTY exec channel, stdin over the channel, dying with it.
 */
export class SshChatSession implements ChatSessionHandle {
  private mode: 'detach' | 'direct' | null = null;
  private channelId: string | null = null;
  private parser = new ChatStreamParser();
  /** Bytes of out.jsonl fed to the parser (detach mode). */
  private consumed = 0;
  private runDir: string | null = null;
  private lastRunDir: string | null = null;
  /** Exit-file content once the runner is known dead, with out.jsonl's size
   *  at that moment — settled when the tail catches up to it. */
  private runnerExit: { code: string; outSize: number; err: string } | null = null;
  private turnOpen = false;
  private stderrTail = '';
  private interrupted = false;
  private disposed = false;
  private reconnecting = false;
  private model: string | null;
  private opening: Promise<void> | null = null;
  sessionId: string | null = null;

  constructor(
    private readonly env: SshChatEnv,
    opts: { resume?: string; model?: string | null },
    private readonly onEvent: (e: ClaudeChatEvent) => void,
  ) {
    this.sessionId = opts.resume ?? null;
    this.model = opts.model ?? null;
  }

  setModel(model: string | null): void {
    this.model = model;
  }

  send(text: string): void {
    if (this.disposed) throw new Error('Chat session disposed');
    const line = JSON.stringify({ type: 'user', message: { role: 'user', content: text } });
    this.turnOpen = true;
    void this.deliver(line).catch((err: unknown) => {
      this.emitEvent({ type: 'error', message: `Failed to start claude: ${errText(err)}` });
      this.emitEvent({ type: 'turn-done' });
    });
  }

  interrupt(): void {
    if (this.mode === 'direct') return this.interruptDirect();
    const runDir = this.runDir;
    const channelId = this.channelId;
    if (!runDir && !channelId) return;
    this.interrupted = true;
    this.channelId = null;
    this.runDir = null;
    void (async () => {
      try {
        const sid = await this.env.sessionId();
        if (runDir) await this.env.plugin.exec({ sessionId: sid, command: killCommand(runDir, false) });
      } catch {
        // host unreachable — the runner dies with its own turn or the sweep
      }
      if (channelId) void this.env.plugin.shellClose({ channelId });
    })();
    if (this.turnOpen) this.emitEvent({ type: 'turn-done' });
  }

  dispose(): void {
    this.disposed = true;
    this.interrupted = true;
    const channelId = this.channelId;
    const runDir = this.runDir;
    this.channelId = null;
    this.runDir = null;
    if (this.mode === 'direct') {
      if (channelId) {
        void this.env.plugin.shellSignal({ channelId, signal: 'TERM' });
        void this.env.plugin.shellClose({ channelId });
      }
      return;
    }
    void (async () => {
      try {
        const sid = await this.env.sessionId();
        if (runDir) await this.env.plugin.exec({ sessionId: sid, command: killCommand(runDir, true) });
      } catch {
        // best effort — the launch sweep collects the leftovers
      }
    })();
    if (channelId) void this.env.plugin.shellClose({ channelId });
  }

  // ------------------------------------------------------------- delivery

  private async deliver(line: string): Promise<void> {
    await this.ensureOpen();
    if (this.mode === 'direct') {
      if (this.channelId) {
        await this.env.plugin.shellWrite({ channelId: this.channelId, data: line + '\n' });
      }
      return;
    }
    if (await this.writeFifo(line)) return;
    // The runner died since we last looked (crash, host reboot) — relaunch
    // with --resume and retry once.
    this.resetRunner();
    await this.ensureOpen();
    if (!(await this.writeFifo(line))) {
      throw new Error('claude is not staying up on the host — check err.log in its workspace');
    }
  }

  private async writeFifo(line: string): Promise<boolean> {
    const runDir = this.runDir;
    if (!runDir) return false;
    const sid = await this.env.sessionId();
    const result = await this.env.plugin.exec({
      sessionId: sid,
      command: writeCommand(runDir, line),
    });
    return result.stdout.includes('SENT');
  }

  private resetRunner(): void {
    const channelId = this.channelId;
    this.channelId = null;
    this.runDir = null;
    if (channelId) void this.env.plugin.shellClose({ channelId });
  }

  // --------------------------------------------------------------- opening

  private ensureOpen(): Promise<void> {
    if (this.channelId) return Promise.resolve();
    this.opening ??= this.open().finally(() => (this.opening = null));
    return this.opening;
  }

  private async open(): Promise<void> {
    const sid = await this.env.sessionId();
    if (!this.mode) {
      const probe = await this.env.plugin.exec({ sessionId: sid, command: SETSID_PROBE });
      this.mode = probe.stdout.includes('detach') ? 'detach' : 'direct';
    }
    if (this.mode === 'direct') return this.openDirect(sid);

    if (!this.runDir) {
      const runDir = `${this.env.dir}/run/${uuid()}`;
      const result = await this.env.plugin.exec({
        sessionId: sid,
        command: launchCommand(this.env.dir, runDir, this.claudeCmd(), this.lastRunDir),
      });
      if (!result.stdout.includes('READY')) {
        throw new Error(
          `couldn't start claude on the host${result.stderr.trim() ? `: ${result.stderr.trim()}` : ''}`,
        );
      }
      this.runDir = runDir;
      this.lastRunDir = runDir;
      this.consumed = 0;
      this.parser = new ChatStreamParser();
      this.runnerExit = null;
      this.interrupted = false;
      this.stderrTail = '';
    }
    await this.openTail(sid);
  }

  private claudeCmd(): string {
    const args = [...CLI_ARGS];
    if (this.sessionId) args.push(`--resume ${shq(this.sessionId)}`);
    if (this.model) args.push(`--model ${shq(this.model)}`);
    return `claude ${args.join(' ')}`;
  }

  private async openTail(sid: string): Promise<void> {
    const runDir = this.runDir;
    if (!runDir) return;
    const { channelId } = await this.env.plugin.shellOpen({
      sessionId: sid,
      command: tailCommand(runDir, this.consumed + 1),
      cols: 200,
      rows: 50,
      pty: false,
    });
    this.channelId = channelId;
    this.env.hub.bindChannel(channelId, {
      onData: (chunk) => {
        if (this.runDir !== runDir) return; // a stale tail from a replaced runner
        this.consumed += utf8ByteLength(chunk);
        for (const event of this.parser.push(chunk)) {
          if (event.type === 'init') this.sessionId = event.sessionId;
          this.emitEvent(event);
        }
        // The runner's own last words — claude exited (crash, clean stop):
        // everything before the sentinel is already consumed, settle now.
        const exit = /"pear_runner_exit","code":(\d+)/.exec(chunk);
        if (exit) this.runnerExit = { code: exit[1], outSize: 0, err: '' };
        this.maybeSettleDeadRunner();
      },
      onStderr: (chunk) => {
        this.stderrTail = (this.stderrTail + chunk).slice(-4096);
      },
      onExit: () => {
        if (this.channelId !== channelId) return;
        this.channelId = null;
        if (this.disposed || this.interrupted) return;
        // The tail died — usually the SSH connection going down with the
        // screen. The detached claude is still working on the host: mid-turn,
        // chase the output; idle, the next send re-tails lazily.
        if (this.turnOpen) void this.chase();
      },
    });
  }

  /** Re-dial and re-tail from the consumed offset until the reply catches up. */
  private async chase(): Promise<void> {
    if (this.reconnecting) return;
    this.reconnecting = true;
    try {
      for (let attempt = 0; attempt < RECONNECT_TRIES; attempt++) {
        if (this.disposed || this.interrupted || !this.runDir) return;
        try {
          const sid = await this.env.sessionId();
          await this.readRunnerExit(sid);
          await this.openTail(sid);
          this.maybeSettleDeadRunner();
          return;
        } catch {
          await delay(RECONNECT_DELAY_MS);
        }
      }
      this.emitEvent({
        type: 'error',
        message:
          'Lost the connection to the Claude host and could not get back. ' +
          'The reply may still be running there — its output will catch up on your next message.',
      });
      this.emitEvent({ type: 'turn-done' });
    } finally {
      this.reconnecting = false;
    }
  }

  private async readRunnerExit(sid: string): Promise<void> {
    const runDir = this.runDir;
    if (!runDir) return;
    const result = await this.env.plugin.exec({ sessionId: sid, command: statusCommand(runDir) });
    const [head = '', ...rest] = result.stdout.split('\n');
    const exit = /^EXIT (\S+)\s+(\d+)/.exec(head.trim());
    if (exit) {
      this.runnerExit = { code: exit[1], outSize: Number(exit[2]), err: rest.join('\n').trim() };
    }
  }

  /** Once a dead runner's output is fully consumed, close the turn out. */
  private maybeSettleDeadRunner(): void {
    const dead = this.runnerExit;
    if (!dead || this.consumed < dead.outSize) return;
    this.runnerExit = null;
    this.resetRunner();
    if (!this.turnOpen) return; // the result event already closed the turn
    if (dead.code !== '0') {
      this.emitEvent({
        type: 'error',
        message: `Claude stopped (exit ${dead.code})${dead.err ? ` — ${dead.err}` : ''}`,
      });
    }
    this.emitEvent({ type: 'turn-done' });
  }

  private emitEvent(e: ClaudeChatEvent): void {
    if (e.type === 'turn-done') this.turnOpen = false;
    this.onEvent(e);
  }

  // ------------------------------------------------- direct mode (no setsid)

  private interruptDirect(): void {
    const channelId = this.channelId;
    if (!channelId) return;
    this.interrupted = true;
    void this.env.plugin.shellSignal({ channelId, signal: 'TERM' });
    // Belt and suspenders — older sshds ignore signal messages.
    setTimeout(() => {
      if (this.channelId === channelId) void this.env.plugin.shellClose({ channelId });
    }, 1500);
  }

  private async openDirect(sid: string): Promise<void> {
    // Login shell so the user's PATH applies (nvm/bun installs of claude).
    const command =
      `cd ${shq(this.env.dir)} && exec "$SHELL" -lc ${shq(this.claudeCmd())}`;
    const { channelId } = await this.env.plugin.shellOpen({
      sessionId: sid,
      command,
      cols: 200,
      rows: 50,
      pty: false,
    });
    this.parser = new ChatStreamParser();
    this.interrupted = false;
    this.stderrTail = '';
    this.channelId = channelId;
    this.env.hub.bindChannel(channelId, {
      onData: (chunk) => {
        for (const event of this.parser.push(chunk)) {
          if (event.type === 'init') this.sessionId = event.sessionId;
          this.emitEvent(event);
        }
      },
      onStderr: (chunk) => {
        this.stderrTail = (this.stderrTail + chunk).slice(-4096);
      },
      onExit: (code) => {
        if (this.channelId !== channelId) return;
        this.channelId = null;
        if (this.interrupted || this.disposed) {
          this.emitEvent({ type: 'turn-done' });
          return;
        }
        const detail = this.stderrTail.trim().split('\n').slice(-3).join('\n');
        if (code === -1) {
          // Session teardown (not a claude exit) — detail carries the SSH
          // disconnect reason from the engine.
          this.emitEvent({
            type: 'error',
            message: detail
              ? `Lost the connection to the Claude host — ${detail}`
              : 'Lost the connection to the Claude host.',
          });
          this.emitEvent({ type: 'turn-done' });
          return;
        }
        if (code !== 0) {
          this.emitEvent({
            type: 'error',
            message: `Claude stopped (exit ${code})${detail ? ` — ${detail}` : ''}`,
          });
          this.emitEvent({ type: 'turn-done' });
        }
        // code 0: the result event already carried turn-done.
      },
    });
  }
}
