import type { TermSize } from '../types';

// The pure layer compiles without Node or DOM typings; same trick as
// claude/executor.ts.
declare function setTimeout(handler: () => void, timeout?: number): unknown;
declare function clearTimeout(handle: unknown): void;

/** How a hub-tracked terminal is driven — SessionManager for SSH/local shells,
 *  the raw ShellChannel for Claude's PTY. */
export interface TermOps {
  write(data: string): void;
  resize(size: TermSize): void;
  close(): void;
}

export interface TermInfo {
  termId: string;
  /** null for terminals not bound to a host (the Claude CLI PTY). */
  hostId: string | null;
  kind: 'shell' | 'claude';
  cols: number;
  rows: number;
  createdAt: number;
  exited: boolean;
}

export interface TermPolicy {
  /**
   * How long a terminal outlives its last attached client. 0 closes it at
   * once (desktop semantics); Infinity never reaps. Embedders that never
   * attach clients (Electron) are never reaped, whatever this says.
   */
  graceMs: number;
  /** Scrollback kept per terminal for replay, in UTF-16 code units. 0 = none. */
  ringChars: number;
  /** Across all terminals; detached terminals lose their scrollback first. */
  globalRingChars?: number;
  /** Most detached terminals kept alive; the longest-detached goes first. */
  maxDetached?: number;
  /** How long an exited terminal's scrollback stays readable. */
  exitedKeepMs?: number;
}

export interface TermHubEvents {
  /** New output. `endSeq` is the terminal's cumulative output length after it. */
  onData(termId: string, data: string, endSeq: number): void;
  onExit(termId: string): void;
}

/** `delta`: append to what you have. `reset`: clear your screen first. */
export interface TermRead {
  mode: 'delta' | 'reset';
  data: string;
  seq: number;
}

interface Entry {
  info: TermInfo;
  ops: TermOps;
  chunks: string[];
  /** Sequence number of the first code unit still held in `chunks`. */
  startSeq: number;
  endSeq: number;
  clients: Set<string>;
  everAttached: boolean;
  detachedAt: number | null;
  reapTimer: unknown;
}

export const PASSTHROUGH_POLICY: TermPolicy = { graceMs: 0, ringChars: 0 };

/**
 * One namespace for every terminal an embedder serves, whoever owns the
 * underlying channel. With a zero policy it is a pure passthrough (desktop).
 * With scrollback and a grace period it is what lets a terminal outlive the
 * client that opened it: output is sequence-numbered into a ring, so a client
 * that comes back says where it got to and receives exactly the rest.
 */
export class TerminalHub {
  private readonly entries = new Map<string, Entry>();
  private heldChars = 0;

  constructor(
    private readonly events: TermHubEvents,
    private readonly policy: TermPolicy = PASSTHROUGH_POLICY,
    private readonly now: () => number = () => Date.now(),
  ) {}

  track(
    termId: string,
    meta: { hostId: string | null; kind: 'shell' | 'claude'; size: TermSize },
    ops: TermOps,
  ): void {
    this.entries.set(termId, {
      info: {
        termId,
        hostId: meta.hostId,
        kind: meta.kind,
        cols: meta.size.cols,
        rows: meta.size.rows,
        createdAt: this.now(),
        exited: false,
      },
      ops,
      chunks: [],
      startSeq: 0,
      endSeq: 0,
      clients: new Set(),
      everAttached: false,
      detachedAt: null,
      reapTimer: null,
    });
  }

  /** Output from the underlying channel. Unknown ids are dropped. */
  ingest(termId: string, data: string): void {
    const e = this.entries.get(termId);
    if (!e || e.info.exited || !data) return;
    e.endSeq += data.length;
    if (this.policy.ringChars > 0) {
      e.chunks.push(data);
      this.heldChars += data.length;
      this.trim(e);
      this.enforceGlobalCap();
    } else {
      e.startSeq = e.endSeq;
    }
    this.events.onData(termId, data, e.endSeq);
  }

  /** The underlying channel closed. */
  ended(termId: string): void {
    const e = this.entries.get(termId);
    if (!e || e.info.exited) return;
    e.info.exited = true;
    this.cancelReap(e);
    const keep = this.policy.ringChars > 0 ? (this.policy.exitedKeepMs ?? 0) : 0;
    if (keep > 0) e.reapTimer = setTimeout(() => this.drop(termId), keep);
    else this.drop(termId);
    this.events.onExit(termId);
  }

  write(termId: string, data: string): void {
    const e = this.entries.get(termId);
    if (e && !e.info.exited) e.ops.write(data);
  }

  resize(termId: string, size: TermSize): void {
    const e = this.entries.get(termId);
    if (!e || e.info.exited) return;
    e.info.cols = size.cols;
    e.info.rows = size.rows;
    e.ops.resize(size);
  }

  close(termId: string): void {
    const e = this.entries.get(termId);
    if (!e) return;
    if (e.info.exited) this.drop(termId);
    else e.ops.close();
  }

  has(termId: string): boolean {
    return this.entries.has(termId);
  }

  list(): TermInfo[] {
    return [...this.entries.values()].map((e) => ({ ...e.info }));
  }

  /**
   * Output after `fromSeq`. null, or a position the ring no longer holds (or
   * never produced), yields a `reset` carrying everything still buffered.
   */
  read(termId: string, fromSeq: number | null): TermRead | null {
    const e = this.entries.get(termId);
    if (!e) return null;
    if (fromSeq === null || fromSeq < e.startSeq || fromSeq > e.endSeq) {
      return { mode: 'reset', data: e.chunks.join(''), seq: e.endSeq };
    }
    let skip = fromSeq - e.startSeq;
    let out = '';
    for (const chunk of e.chunks) {
      if (skip >= chunk.length) skip -= chunk.length;
      else {
        out += skip ? chunk.slice(skip) : chunk;
        skip = 0;
      }
    }
    return { mode: 'delta', data: out, seq: e.endSeq };
  }

  /** A client starts following this terminal; cancels any pending reap. */
  attach(termId: string, clientId: string): boolean {
    const e = this.entries.get(termId);
    if (!e) return false;
    e.clients.add(clientId);
    e.everAttached = true;
    e.detachedAt = null;
    if (!e.info.exited) this.cancelReap(e);
    return true;
  }

  /**
   * Full-screen programs only repaint on SIGWINCH, and a replayed ring can
   * start mid-state — nudge the size so they redraw for the new viewer.
   */
  repaint(termId: string): void {
    const e = this.entries.get(termId);
    if (!e || e.info.exited || e.info.rows < 2) return;
    const { cols, rows } = e.info;
    e.ops.resize({ cols, rows: rows - 1 });
    e.ops.resize({ cols, rows });
  }

  detach(termId: string, clientId: string): void {
    const e = this.entries.get(termId);
    if (!e || !e.clients.delete(clientId)) return;
    if (e.clients.size === 0) this.orphaned(e);
  }

  /** A client went away entirely (its socket closed). */
  detachClient(clientId: string): void {
    for (const e of [...this.entries.values()]) this.detach(e.info.termId, clientId);
  }

  disposeAll(): void {
    for (const e of this.entries.values()) this.cancelReap(e);
    this.entries.clear();
    this.heldChars = 0;
  }

  private orphaned(e: Entry): void {
    if (e.info.exited || !e.everAttached) return;
    e.detachedAt = this.now();
    const { graceMs } = this.policy;
    if (graceMs <= 0) {
      e.ops.close();
      return;
    }
    if (graceMs !== Infinity) {
      e.reapTimer = setTimeout(() => e.ops.close(), graceMs);
    }
    const cap = this.policy.maxDetached;
    if (cap === undefined) return;
    const detached = [...this.entries.values()]
      .filter((x) => x.detachedAt !== null && !x.info.exited)
      .sort((a, b) => (a.detachedAt ?? 0) - (b.detachedAt ?? 0));
    for (const victim of detached.slice(0, Math.max(0, detached.length - cap))) {
      victim.ops.close();
    }
  }

  private cancelReap(e: Entry): void {
    if (e.reapTimer !== null) clearTimeout(e.reapTimer);
    e.reapTimer = null;
  }

  private drop(termId: string): void {
    const e = this.entries.get(termId);
    if (!e) return;
    this.cancelReap(e);
    for (const c of e.chunks) this.heldChars -= c.length;
    this.entries.delete(termId);
  }

  /** Whole chunks only: a chunk never splits a surrogate pair, a slice could. */
  private trim(e: Entry): void {
    let held = e.endSeq - e.startSeq;
    while (held > this.policy.ringChars && e.chunks.length > 1) {
      const dropped = e.chunks.shift() as string;
      held -= dropped.length;
      e.startSeq += dropped.length;
      this.heldChars -= dropped.length;
    }
  }

  private enforceGlobalCap(): void {
    const cap = this.policy.globalRingChars;
    if (cap === undefined || this.heldChars <= cap) return;
    const victims = [...this.entries.values()]
      .filter((e) => e.detachedAt !== null && e.chunks.length > 0)
      .sort((a, b) => (a.detachedAt ?? 0) - (b.detachedAt ?? 0));
    for (const e of victims) {
      if (this.heldChars <= cap) return;
      for (const c of e.chunks) this.heldChars -= c.length;
      e.chunks = [];
      e.startSeq = e.endSeq;
    }
  }
}
