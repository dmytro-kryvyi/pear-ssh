import type { ShellChannel, SshTransport } from '../ssh/transport';
import { shq } from '../shq';
import { uuid } from '../uuid';
import type { FsOpPlan } from './archive-ops';

// Long shell operations (extract, compress) run over a PTY channel rather than
// a buffered exec: a PTY can be closed, which is the only portable cancel we
// have, and it works through container sub-hosts the same way. The exit code
// comes back as a marker line because a PTY channel only reports "closed".

export type FsOpStatus = 'running' | 'done' | 'error' | 'canceled';

export interface FsOpSpec extends FsOpPlan {
  hostId: string;
}

export interface FsOpSnapshot extends FsOpSpec {
  id: string;
  status: FsOpStatus;
  startedAt: number;
  finishedAt?: number;
  exitCode?: number;
  error?: string;
  /** Tail of the command's output (both streams), for failure diagnostics. */
  output?: string;
  cancelRequested?: boolean;
}

export interface FsOpsEnv {
  connection(hostId: string): Promise<SshTransport>;
  now?: () => number;
}

export interface FsOpsEvents {
  onUpdate(op: FsOpSnapshot): void;
}

export const EXIT_MARKER = '__PEAR_EXIT:';
const MARKER_RE = /__PEAR_EXIT:(\d+)__/g;
const TAIL_BYTES = 8 * 1024;
const OUTPUT_BYTES = 4 * 1024;

/** Force a POSIX shell whatever the login shell is, and print the exit status last. */
export function wrapForPty(command: string): string {
  return `sh -c ${shq(`${command}; printf '\\n${EXIT_MARKER}%s__\\n' "$?"`)}`;
}

/** Strip PTY carriage returns, find the last exit marker, keep the output before it. */
export function parseExit(raw: string): { code: number | null; output: string } {
  const text = raw.replace(/\r/g, '');
  let last: RegExpExecArray | null = null;
  for (let m = MARKER_RE.exec(text); m; m = MARKER_RE.exec(text)) last = m;
  MARKER_RE.lastIndex = 0;
  if (!last) return { code: null, output: text.trim().slice(-OUTPUT_BYTES) };
  return { code: Number(last[1]), output: text.slice(0, last.index).trim().slice(-OUTPUT_BYTES) };
}

interface Running {
  snap: FsOpSnapshot;
  channel: ShellChannel | null;
}

export class FsOpsRunner {
  private readonly ops = new Map<string, Running>();
  private readonly now: () => number;

  constructor(
    private readonly env: FsOpsEnv,
    private readonly events: FsOpsEvents,
  ) {
    this.now = env.now ?? (() => Date.now());
  }

  start(spec: FsOpSpec): string {
    const id = uuid();
    const snap: FsOpSnapshot = { ...spec, id, status: 'running', startedAt: this.now() };
    const run: Running = { snap, channel: null };
    this.ops.set(id, run);
    this.emit(run);
    void this.drive(run);
    return id;
  }

  cancel(id: string): void {
    const run = this.ops.get(id);
    if (!run || run.snap.status !== 'running') return;
    run.snap.cancelRequested = true;
    this.emit(run);
    run.channel?.close();
  }

  list(): FsOpSnapshot[] {
    return [...this.ops.values()].map((r) => ({ ...r.snap }));
  }

  clearFinished(): void {
    for (const [id, run] of this.ops) if (run.snap.status !== 'running') this.ops.delete(id);
  }

  private emit(run: Running): void {
    this.events.onUpdate({ ...run.snap });
  }

  private async drive(run: Running): Promise<void> {
    const { snap } = run;
    try {
      const conn = await this.env.connection(snap.hostId);
      const channel = await conn.shellCommand(wrapForPty(snap.command), { cols: 200, rows: 50 });
      run.channel = channel;
      if (snap.cancelRequested) channel.close();
      let tail = '';
      channel.onData((chunk) => {
        tail += chunk;
        if (tail.length > TAIL_BYTES) tail = tail.slice(-TAIL_BYTES);
      });
      await new Promise<void>((resolve) => channel.onClose(resolve));
      const { code, output } = parseExit(tail);
      snap.output = output || undefined;
      snap.exitCode = code ?? undefined;
      if (snap.cancelRequested) snap.status = 'canceled';
      else if (code === 0) snap.status = 'done';
      else {
        snap.status = 'error';
        const lastLine = output
          .split('\n')
          .filter((l) => l.trim())
          .pop();
        snap.error =
          code === null
            ? 'Command ended without a status (connection lost?)'
            : `exit ${code}${lastLine ? `: ${lastLine}` : ''}`;
      }
    } catch (err) {
      snap.status = snap.cancelRequested ? 'canceled' : 'error';
      snap.error = err instanceof Error ? err.message : String(err);
    } finally {
      snap.finishedAt = this.now();
      run.channel = null;
      this.emit(run);
    }
  }
}
