import type { PearApi } from '../api';
import { buildApiClient } from '../rpc/channels';
import type { HostKeyGate, HostKeyPrompt } from '../ssh/known-hosts';
import type { TermInfo } from '../ssh/term-hub';
import type { TermSize } from '../types';

// The pure layer compiles without DOM or Node typings (see transport.ts's
// AbortSignalLike): the embedder hands us a socket factory, and timers are
// declared structurally.
declare function setTimeout(handler: () => void, timeout?: number): unknown;
declare function clearTimeout(handle: unknown): void;

/** The slice of the DOM WebSocket this client uses. */
export interface WebSocketLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export type RemoteState = 'connecting' | 'open' | 'reconnecting' | 'unauthorized' | 'closed';

export interface RemoteHello {
  proto: number;
  /** New on every server start — terminals from before it no longer exist. */
  instanceId: string;
  build: string;
  /** The server's release version (`0.2.0`). */
  version?: string;
  /** Present once the server knows of a newer release. */
  update?: RemoteUpdate;
  user?: string;
  features: Record<string, boolean>;
}

export interface RemoteUpdate {
  latest: string;
  /** Release notes. */
  url: string;
}

export interface RemoteBackendOpts {
  /** ws(s)://host/api/ws */
  url: string;
  socket(url: string): WebSocketLike;
  /** PearApi members with no wire form (transfers.pathForFile), by dotted path. */
  locals?: Record<string, (...args: never[]) => unknown>;
  /**
   * Asked when a connection dies before the server said hello: is our login
   * still good? A browser cannot see *why* a WebSocket handshake failed, so
   * the embedder checks over plain HTTP. false → state `unauthorized`, and
   * the client stops retrying (the embedder shows the login page).
   */
  checkAuth?(): Promise<boolean>;
  /**
   * Answers trust-on-first-use prompts. The server refuses to connect to a
   * host whose key it has not seen (or that changed); with a gate, the client
   * asks the user, records the answer on the server and retries the call —
   * so the UI above sees one slow call instead of an error. Without a gate the
   * error surfaces as-is.
   */
  hostKeyGate?: HostKeyGate;
  /** Test seam; defaults to the ambient timers. */
  timers?: { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void };
}

export interface RemoteControl {
  state(): RemoteState;
  /** Fires on every change; returns the unsubscribe. */
  onState(cb: (state: RemoteState) => void): () => void;
  hello(): RemoteHello | null;
  /**
   * A newer server release exists. Fires at once if that is already known,
   * and again whenever the server finds out. Returns the unsubscribe.
   */
  onUpdateAvailable(cb: (update: RemoteUpdate) => void): () => void;
  /**
   * The page came back to the foreground. iOS suspends a web app without
   * closing its sockets, so `readyState` lies: prove the link with a ping on a
   * short fuse, and reconnect the moment it fails.
   */
  resume(): void;
  /** Terminals alive on the server — including ones this page never opened
   *  (it may have been reloaded, or they belong to another device). */
  listTerminals(): Promise<TermInfo[]>;
  /**
   * Follow a terminal this page did not open. Its buffered scrollback arrives
   * through term.onData (after a clear-screen), then live output follows.
   */
  adoptTerminal(termId: string, size: TermSize): Promise<void>;
  close(): void;
}

export type RemoteBackend = PearApi & { remote: RemoteControl };

/** Rejections for calls that were in flight, or waiting, when the link dropped. */
export class PearDisconnectedError extends Error {
  readonly code = 'DISCONNECTED';
  constructor(message = 'Connection to the Pear server was lost') {
    super(message);
    this.name = 'PearDisconnectedError';
  }
}

const OPEN = 1;
const RIS = '\x1bc'; // full terminal reset: replayed scrollback starts from a clean screen

const BACKOFF_MS = [300, 1_000, 2_000, 4_000, 8_000];
/** Calls made while reconnecting wait this long for the link before failing —
 *  long enough to ride out a blip, short enough that pollers stay quiet. */
const QUEUE_PATIENCE_MS = 8_000;
const HEARTBEAT_MS = 20_000;
const PONG_DEADLINE_MS = 5_000;
const RESUME_DEADLINE_MS = 2_000;

interface Pending {
  resolve(v: unknown): void;
  reject(e: Error): void;
}

/**
 * PearApi over a WebSocket to pear-server — the fourth implementation of the
 * interface, beside the Electron preload, the Android plugin backend and the
 * mock. Framework-free so both Angular apps (and tests) share it.
 *
 * Losing the link is the normal case here, not the exceptional one: an iPad
 * drops it every time the user switches apps. So the client remembers, per
 * terminal, how much output it has seen, and on reconnect asks the server for
 * exactly the rest. The UI above notices nothing but a "reconnecting" state.
 */
export function createRemoteBackend(opts: RemoteBackendOpts): RemoteBackend {
  const timers = opts.timers ?? {
    set: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clear: (h: unknown) => clearTimeout(h),
  };

  let state: RemoteState = 'connecting';
  let ws: WebSocketLike | null = null;
  let hello: RemoteHello | null = null;
  let attempt = 0;
  let nextId = 0;
  let retryTimer: unknown = null;
  let heartbeatTimer: unknown = null;
  let pongTimer: unknown = null;
  /** True once the server greeted us and our terminals are re-attached. */
  let ready = false;

  const stateSubs = new Set<(s: RemoteState) => void>();
  const subs = new Map<string, Set<(...args: never[]) => void>>();
  const pending = new Map<number, Pending>();
  const waiting: { run(): void; fail(e: Error): void; timer: unknown }[] = [];
  /** termId → output received so far (the server's sequence number). */
  const cursors = new Map<string, number>();
  /** Closes requested while offline — sent first thing after reconnecting. */
  const deferredCloses = new Set<string>();

  /** host:port:fingerprint → the question already on screen. Pollers hit the
   *  same unknown key many times a second; the user is asked once. */
  const asking = new Map<string, Promise<boolean>>();
  const askOnce = (prompt: HostKeyPrompt): Promise<boolean> => {
    const key = `${prompt.host}:${prompt.port}:${prompt.fingerprint}`;
    let answer = asking.get(key);
    if (!answer) {
      answer = (opts.hostKeyGate as HostKeyGate)
        .confirm(prompt)
        .then(async (trusted) => {
          if (trusted) await rawCall('hostkeys:trust', [prompt]);
          return trusted;
        })
        .finally(() => asking.delete(key));
      asking.set(key, answer);
    }
    return answer;
  };

  const updateSubs = new Set<(u: RemoteUpdate) => void>();
  let announced: string | null = null;
  const announce = (update: RemoteUpdate): void => {
    if (announced === update.latest) return; // every reconnect repeats the hello
    announced = update.latest;
    for (const cb of [...updateSubs]) cb(update);
  };

  const setState = (next: RemoteState): void => {
    if (state === next) return;
    state = next;
    for (const cb of [...stateSubs]) cb(next);
  };

  const dispatch = (event: string, args: unknown[]): void => {
    for (const cb of [...(subs.get(event) ?? [])]) (cb as (...a: unknown[]) => void)(...args);
  };

  const rawCall = (method: string, args: unknown[]): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      try {
        (ws as WebSocketLike).send(JSON.stringify({ id, m: method, a: args }));
      } catch {
        pending.delete(id);
        reject(new PearDisconnectedError());
      }
    });

  const trackOpened = (method: string, value: unknown): void => {
    if ((method === 'term:open' || method === 'claude:open') && typeof value === 'string') {
      if (!cursors.has(value)) cursors.set(value, 0);
    }
  };

  const invoke = (method: string, args: unknown[]): Promise<unknown> => {
    if (state === 'closed')
      return Promise.reject(new PearDisconnectedError('Pear client is closed'));
    if (state === 'unauthorized') return Promise.reject(new PearDisconnectedError('Not signed in'));
    const once = (): Promise<unknown> =>
      rawCall(method, args).then((value) => {
        trackOpened(method, value);
        return value;
      });
    const run = (): Promise<unknown> =>
      once().catch(async (err: { code?: string; data?: HostKeyPrompt }) => {
        const asksForTrust = err?.code === 'UNKNOWN_HOST_KEY' || err?.code === 'HOST_KEY_CHANGED';
        if (!asksForTrust || !err.data || !opts.hostKeyGate) throw err;
        if (!(await askOnce(err.data))) throw err;
        return once(); // a second refusal (the key changed again?) surfaces
      });
    if (ready) return run();
    return new Promise((resolve, reject) => {
      const entry = {
        run: () => run().then(resolve, reject),
        fail: reject,
        timer: timers.set(() => {
          waiting.splice(waiting.indexOf(entry), 1);
          reject(new PearDisconnectedError());
        }, QUEUE_PATIENCE_MS),
      };
      waiting.push(entry);
    });
  };

  const send = (method: string, args: unknown[]): void => {
    if (method === 'term:close' && typeof args[0] === 'string') {
      // The UI is done with it either way: stop following, and make sure the
      // server hears about it even if we are offline right now.
      cursors.delete(args[0]);
      if (!ready) return void deferredCloses.add(args[0]);
    }
    // Anything else typed or clicked while offline is dropped on purpose:
    // keystrokes replayed into a shell seconds later are how accidents happen.
    if (!ready || !ws) return;
    try {
      ws.send(JSON.stringify({ m: method, a: args }));
    } catch {
      /* the close handler will notice */
    }
  };

  const failInFlight = (): void => {
    for (const [, p] of pending) p.reject(new PearDisconnectedError());
    pending.clear();
  };

  const failWaiting = (error: Error): void => {
    for (const w of waiting.splice(0)) {
      timers.clear(w.timer);
      w.fail(error);
    }
  };

  const stopHeartbeat = (): void => {
    if (heartbeatTimer !== null) timers.clear(heartbeatTimer);
    if (pongTimer !== null) timers.clear(pongTimer);
    heartbeatTimer = pongTimer = null;
  };

  /** Ping now; if nothing comes back in time the socket is a corpse. */
  const probe = (deadlineMs: number): void => {
    if (!ready || !ws) return;
    const socket = ws;
    if (pongTimer !== null) timers.clear(pongTimer);
    pongTimer = timers.set(() => {
      pongTimer = null;
      if (ws === socket) dropSocket();
    }, deadlineMs);
    rawCall('ping', []).then(
      () => {
        if (ws === socket && pongTimer !== null) {
          timers.clear(pongTimer);
          pongTimer = null;
        }
      },
      () => {},
    );
  };

  const startHeartbeat = (): void => {
    stopHeartbeat();
    const beat = (): void => {
      probe(PONG_DEADLINE_MS);
      heartbeatTimer = timers.set(beat, HEARTBEAT_MS);
    };
    heartbeatTimer = timers.set(beat, HEARTBEAT_MS);
  };

  const scheduleReconnect = (): void => {
    if (state === 'closed' || state === 'unauthorized' || retryTimer !== null) return;
    const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
    attempt++;
    retryTimer = timers.set(() => {
      retryTimer = null;
      connect();
    }, delay);
  };

  /** Tear down the current socket as if it had closed by itself. */
  function dropSocket(): void {
    const socket = ws;
    if (!socket) return;
    socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
    try {
      socket.close();
    } catch {
      /* already gone */
    }
    onSocketGone(socket);
  }

  function onSocketGone(socket: WebSocketLike): void {
    if (ws !== socket) return;
    const greeted = hello !== null && ready;
    ws = null;
    ready = false;
    stopHeartbeat();
    failInFlight();
    if (state === 'closed') return;
    setState('reconnecting');
    if (!greeted && opts.checkAuth) {
      // Died before hello: maybe the server is down, maybe our login expired.
      void opts.checkAuth().then(
        (ok) => {
          if (state === 'closed') return;
          if (ok) return scheduleReconnect();
          failWaiting(new PearDisconnectedError('Not signed in'));
          setState('unauthorized');
        },
        () => scheduleReconnect(),
      );
      return;
    }
    scheduleReconnect();
  }

  /** After (re)connecting: settle our terminals with the server, then go live. */
  async function resync(socket: WebSocketLike, greeting: RemoteHello): Promise<void> {
    const restarted = hello !== null && hello.instanceId !== greeting.instanceId;
    hello = greeting;
    if (greeting.update) announce(greeting.update);
    if (restarted) {
      // The server process is new: every terminal we knew died with the old one.
      for (const termId of [...cursors.keys()]) {
        cursors.delete(termId);
        dispatch('term:exit', [termId]);
      }
      deferredCloses.clear();
    }
    for (const termId of [...deferredCloses]) {
      deferredCloses.delete(termId);
      socket.send(JSON.stringify({ m: 'term:close', a: [termId] }));
    }
    for (const [termId, seq] of [...cursors]) {
      try {
        await rawCall('term:attach', [termId, null, seq]);
      } catch (err) {
        if (ws !== socket) return; // dropped again mid-resync; the next round redoes this
        cursors.delete(termId);
        dispatch('term:exit', [termId]);
      }
    }
    if (ws !== socket) return;
    ready = true;
    attempt = 0;
    startHeartbeat();
    setState('open');
    for (const w of waiting.splice(0)) {
      timers.clear(w.timer);
      w.run();
    }
  }

  function onMessage(socket: WebSocketLike, data: unknown): void {
    if (ws !== socket || typeof data !== 'string') return;
    let msg: {
      hello?: RemoteHello;
      id?: number;
      ok?: boolean;
      v?: unknown;
      e?: { message?: string; code?: string; data?: unknown };
      ev?: string;
      a?: unknown[];
    };
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (msg.hello) return void resync(socket, msg.hello);
    if (typeof msg.id === 'number') {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.v);
      else {
        const error = new Error(msg.e?.message ?? 'Request failed') as Error & {
          code?: string;
          data?: unknown;
        };
        if (msg.e?.code) error.code = msg.e.code;
        if (msg.e?.data !== undefined) error.data = msg.e.data;
        p.reject(error);
      }
      return;
    }
    if (typeof msg.ev !== 'string') return;
    const args = msg.a ?? [];
    if (msg.ev === 'term:data') {
      const [termId, chunk, seq, reset] = args as [string, string, number, boolean?];
      if (!cursors.has(termId)) return; // closed locally while this was in flight
      cursors.set(termId, seq);
      return dispatch('term:data', [termId, reset ? RIS + chunk : chunk]);
    }
    if (msg.ev === 'server:update') {
      const update = args[0] as RemoteUpdate;
      if (hello) hello = { ...hello, update };
      return announce(update);
    }
    if (msg.ev === 'term:exit') cursors.delete(args[0] as string);
    dispatch(msg.ev, args);
  }

  function connect(): void {
    if (state === 'closed' || ws) return;
    let socket: WebSocketLike;
    try {
      socket = opts.socket(opts.url);
    } catch {
      return scheduleReconnect();
    }
    ws = socket;
    socket.onmessage = (ev) => onMessage(socket, ev.data);
    socket.onclose = () => onSocketGone(socket);
    socket.onerror = () => {
      /* always followed by close */
    };
  }

  const api = buildApiClient(
    {
      invoke,
      send,
      subscribe: (event, cb) => {
        let set = subs.get(event);
        if (!set) subs.set(event, (set = new Set()));
        set.add(cb);
        return () => set.delete(cb);
      },
    },
    opts.locals,
  );

  const remote: RemoteControl = {
    state: () => state,
    onState: (cb) => {
      stateSubs.add(cb);
      return () => stateSubs.delete(cb);
    },
    hello: () => hello,
    onUpdateAvailable: (cb) => {
      updateSubs.add(cb);
      if (hello?.update) cb(hello.update);
      return () => updateSubs.delete(cb);
    },
    resume: () => {
      if (state === 'closed' || state === 'unauthorized') return;
      if (ws && ready && ws.readyState === OPEN) return probe(RESUME_DEADLINE_MS);
      if (!ws) {
        // Don't sit out a long backoff when the user is looking at the screen.
        if (retryTimer !== null) timers.clear(retryTimer);
        retryTimer = null;
        attempt = 0;
        connect();
      }
    },
    listTerminals: () => invoke('term:list', []) as Promise<TermInfo[]>,
    adoptTerminal: async (termId, size) => {
      cursors.set(termId, 0); // accept its data from now on; the reset replay sets the real seq
      try {
        await invoke('term:attach', [termId, size, null]);
      } catch (err) {
        cursors.delete(termId);
        throw err;
      }
    },
    close: () => {
      if (retryTimer !== null) timers.clear(retryTimer);
      retryTimer = null;
      setState('closed');
      failWaiting(new PearDisconnectedError('Pear client is closed'));
      if (ws) dropSocket();
    },
  };

  connect();
  return Object.assign(api, { remote });
}
