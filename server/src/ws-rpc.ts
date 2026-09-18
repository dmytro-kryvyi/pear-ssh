import { randomUUID } from 'node:crypto';
import { channelsOf, type ClaudeUiRequestPayload, type TermSize } from '@pear/core';
import type { PearService } from '@pear/core/node';
import { WebSocket } from 'ws';

export const PROTOCOL = 1;

/** Stop feeding a socket whose kernel/proxy buffers are this full; the ring
 *  holds its terminal output until it drains. */
const MAX_BUFFERED = 1024 * 1024;
const FLUSH_MS = 16;
const HEARTBEAT_MS = 25_000;
const MAX_MESSAGE = 8 * 1024 * 1024;

const INVOKE = new Set(channelsOf('invoke'));
const SEND = new Set(channelsOf('send'));
/** Channels that mean "the user is working with Claude from this device". */
const CLAUDE_ACTIVITY = new Set(['claude:chatSend', 'claude:chatAnswer', 'claude:focus']);

interface Client {
  id: string;
  ws: WebSocket;
  /** termId → how much of that terminal's output this socket has been sent. */
  cursors: Map<string, number>;
  lastActive: number;
  lastClaudeActive: number;
  alive: boolean;
  /** Work that must follow the reply to the request being handled — and
   *  precede anything else on this socket (replayed output, in order). */
  afterReply: (() => void)[];
}

export interface Hello {
  proto: number;
  /** Changes on every server start: terminals from before it are gone. */
  instanceId: string;
  build: string;
  version: string;
  /** Set once a newer release is known. */
  update?: { latest: string; url: string };
  user?: string;
  features: Record<string, boolean>;
}

/**
 * PearService over WebSockets, for any number of clients at once.
 *
 *   server → {hello}
 *   client → {id, m, a}     server → {id, ok:true, v} | {id, ok:false, e}
 *   client → {m, a}          (no id: fire-and-forget)
 *   server → {ev, a}
 *
 * Terminal output is not pushed as it arrives. The service's TerminalHub keeps
 * it in a sequence-numbered ring and each socket holds a cursor into it; a
 * 16 ms flusher sends every socket what lies past its cursor. That one
 * mechanism is the batching (per-chunk frames would jank the UI), the
 * backpressure (a slow socket is skipped and catches up later — the SSH
 * channel is never paused, that would stall everyone else) and the reattach
 * (a returning client just names its cursor).
 */
export class WsRpc {
  readonly instanceId = randomUUID();
  private readonly clients = new Map<string, Client>();
  private readonly dirty = new Set<string>();
  private flushTimer: NodeJS.Timeout | null = null;
  private readonly heartbeat: NodeJS.Timeout;

  constructor(
    private readonly service: () => PearService,
    private readonly build: string,
    private readonly features: () => Record<string, boolean>,
    private readonly info: () => {
      version: string;
      update?: { latest: string; url: string };
    } = () => ({
      version: build,
    }),
  ) {
    this.heartbeat = setInterval(() => this.checkAlive(), HEARTBEAT_MS);
    this.heartbeat.unref();
  }

  get clientCount(): number {
    return this.clients.size;
  }

  accept(ws: WebSocket, user?: string): void {
    const client: Client = {
      id: randomUUID(),
      ws,
      cursors: new Map(),
      lastActive: Date.now(),
      lastClaudeActive: 0,
      alive: true,
      afterReply: [],
    };
    this.clients.set(client.id, client);
    ws.on('pong', () => (client.alive = true));
    ws.on('message', (raw, isBinary) => {
      if (isBinary) return;
      client.alive = true;
      void this.onMessage(client, raw.toString());
    });
    ws.on('close', () => this.drop(client));
    ws.on('error', () => this.drop(client));
    const hello: Hello = {
      proto: PROTOCOL,
      instanceId: this.instanceId,
      build: this.build,
      ...this.info(),
      features: this.features(),
      ...(user ? { user } : {}),
    };
    this.post(client, { hello });
  }

  /** PearServiceEnv.emit */
  emit(channel: string, ...args: unknown[]): void {
    if (channel === 'term:data') {
      this.dirty.add(args[0] as string);
      this.flushTimer ??= setTimeout(() => this.flush(), FLUSH_MS);
      return;
    }
    if (channel === 'term:exit') {
      const termId = args[0] as string;
      for (const c of this.clients.values()) {
        if (!c.cursors.has(termId)) continue;
        this.pump(c, termId, true); // last words first
        c.cursors.delete(termId);
        this.post(c, { ev: channel, a: [termId] });
      }
      this.dirty.delete(termId);
      return;
    }
    for (const c of this.clients.values()) this.post(c, { ev: channel, a: args });
  }

  /**
   * PearServiceEnv.sendUiRequest — read_terminal and reveal_in_app need *a*
   * screen. Pick the device the user last drove Claude from, else the one
   * most recently active. None connected → false, and the tool fails at once
   * with a clear message instead of burning its timeout.
   */
  sendUiRequest(request: { id: string; payload: ClaudeUiRequestPayload }): boolean {
    const open = [...this.clients.values()].filter((c) => c.ws.readyState === WebSocket.OPEN);
    if (!open.length) return false;
    open.sort((a, b) => b.lastClaudeActive - a.lastClaudeActive || b.lastActive - a.lastActive);
    this.post(open[0], { ev: 'claude:uiRequest', a: [request] });
    return true;
  }

  close(): void {
    clearInterval(this.heartbeat);
    if (this.flushTimer) clearTimeout(this.flushTimer);
    for (const c of [...this.clients.values()]) c.ws.terminate();
    this.clients.clear();
  }

  // ---------------------------------------------------------------------------

  private async onMessage(client: Client, text: string): Promise<void> {
    if (text.length > MAX_MESSAGE) return;
    let msg: { id?: unknown; m?: unknown; a?: unknown };
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    const method = msg.m;
    if (typeof method !== 'string') return;
    const args = Array.isArray(msg.a) ? msg.a : [];
    client.lastActive = Date.now();
    if (CLAUDE_ACTIVITY.has(method)) client.lastClaudeActive = client.lastActive;

    if (msg.id === undefined) {
      if (SEND.has(method)) this.service().send(method, args, { clientId: client.id });
      return;
    }
    const id = msg.id;
    try {
      const value = await this.call(client, method, args);
      // The reply goes out before any terminal data for a terminal it just
      // opened: both UIs subscribe to onData only after `await open()`.
      this.post(client, { id, ok: true, v: value });
      for (const job of client.afterReply.splice(0)) job();
      if (this.dirty.size) this.flush();
    } catch (err) {
      client.afterReply.length = 0;
      const e = err as { message?: string; code?: string; data?: unknown };
      this.post(client, {
        id,
        ok: false,
        e: {
          message: e?.message ?? String(err),
          ...(e?.code ? { code: e.code } : {}),
          // Structured detail a UI can act on (a host-key prompt's fingerprint).
          ...(e?.data !== undefined ? { data: e.data } : {}),
        },
      });
    }
  }

  private async call(client: Client, method: string, args: unknown[]): Promise<unknown> {
    const service = this.service();
    const ctx = { clientId: client.id };
    switch (method) {
      case 'ping':
        return 'pong';
      case 'term:list':
        return service.terms.list();
      case 'term:attach':
        return this.attach(client, args);
      case 'term:detach': {
        const termId = String(args[0]);
        client.cursors.delete(termId);
        service.terms.detach(termId, client.id);
        return null;
      }
    }
    if (!INVOKE.has(method)) throw new Error(`Unknown method: ${method}`);
    const value = await service.invoke(method, args, ctx);
    if ((method === 'term:open' || method === 'claude:open') && typeof value === 'string') {
      client.cursors.set(value, 0); // from the very first byte (the MOTD)
      this.dirty.add(value);
    }
    return value;
  }

  /**
   * [termId, size|null, fromSeq|null] → {mode, seq}. `delta`: the client keeps
   * its screen and receives what it missed. `reset`: its cursor is unknown to
   * the ring (page reloaded, ring rolled over, server restarted with a
   * colliding number) — it clears and receives everything still buffered.
   */
  private attach(client: Client, args: unknown[]): { mode: 'delta' | 'reset'; seq: number } {
    const terms = this.service().terms;
    const termId = String(args[0]);
    const size = args[1] as TermSize | null;
    const fromSeq = typeof args[2] === 'number' ? args[2] : null;
    const read = terms.read(termId, fromSeq);
    if (!read || !terms.attach(termId, client.id)) {
      throw Object.assign(new Error('Terminal no longer exists'), { code: 'TERM_GONE' });
    }
    if (size && Number.isFinite(size.cols) && Number.isFinite(size.rows)) {
      terms.resize(termId, size);
    }
    client.cursors.set(termId, read.seq);
    // Nothing can interleave between this read and the job below: no await,
    // no timer — so the replay lands right behind the reply, ahead of any
    // newer output the flusher sends from the cursor on.
    client.afterReply.push(() => {
      if (read.data || read.mode === 'reset') {
        this.post(client, {
          ev: 'term:data',
          a: [termId, read.data, read.seq, read.mode === 'reset'],
        });
      }
      const info = terms.list().find((t) => t.termId === termId);
      if (info?.exited) {
        client.cursors.delete(termId);
        this.post(client, { ev: 'term:exit', a: [termId] });
      } else if (read.mode === 'reset' && read.data) {
        terms.repaint(termId);
      }
    });
    return { mode: read.mode, seq: read.seq };
  }

  private flush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    let congested = false;
    for (const termId of [...this.dirty]) {
      let behind = false;
      for (const c of this.clients.values()) {
        if (c.cursors.has(termId) && !this.pump(c, termId, false)) behind = true;
      }
      if (behind) congested = true;
      else this.dirty.delete(termId);
    }
    if (congested) this.flushTimer = setTimeout(() => this.flush(), FLUSH_MS * 4);
  }

  /** Send a client what it has not seen of one terminal. False = still behind. */
  private pump(client: Client, termId: string, force: boolean): boolean {
    const cursor = client.cursors.get(termId);
    if (cursor === undefined) return true;
    if (client.ws.readyState !== WebSocket.OPEN) return true;
    if (!force && client.ws.bufferedAmount > MAX_BUFFERED) return false;
    const read = this.service().terms.read(termId, cursor);
    if (!read) return true;
    if (read.mode === 'delta' && !read.data) return true;
    client.cursors.set(termId, read.seq);
    this.post(client, {
      ev: 'term:data',
      // Fell further behind than the ring holds → the client must start over.
      a: [termId, read.data, read.seq, ...(read.mode === 'reset' ? [true] : [])],
    });
    return true;
  }

  private post(client: Client, message: unknown): void {
    if (client.ws.readyState === WebSocket.OPEN) client.ws.send(JSON.stringify(message));
  }

  private drop(client: Client): void {
    if (!this.clients.delete(client.id)) return;
    // Its terminals stay; the hub starts their grace period.
    this.service().terms.detachClient(client.id);
  }

  /** iOS suspends a PWA without closing its socket; proxies idle them out.
   *  A socket that misses a whole heartbeat is dead, whatever readyState says. */
  private checkAlive(): void {
    for (const c of [...this.clients.values()]) {
      if (!c.alive) {
        c.ws.terminate();
        this.drop(c);
        continue;
      }
      c.alive = false;
      if (c.ws.readyState === WebSocket.OPEN) c.ws.ping();
    }
  }
}
