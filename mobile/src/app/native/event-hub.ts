import type { PearSshPlugin } from './pear-ssh';

type EventSource = Pick<PearSshPlugin, 'addListener'>;

export interface ChannelHandlers {
  onData: (chunk: string) => void;
  onExit: (code: number) => void;
  /** Only non-PTY channels emit stderr separately. */
  onStderr?: (chunk: string) => void;
}

/**
 * Routes the plugin's global event streams (shellData/shellStderr/shellExit/
 * sessionClosed) to per-channel and per-session handlers. Output that
 * arrives before a channel's handlers are bound — possible in the gap
 * between shellOpen resolving and the caller wiring onData — is buffered
 * and flushed on bind, so no bytes are dropped.
 */
export class SshEventHub {
  private readonly channels = new Map<string, ChannelHandlers>();
  private readonly closed = new Map<string, () => void>();
  private readonly pendingData = new Map<string, string[]>();
  private readonly pendingStderr = new Map<string, string[]>();
  private readonly pendingExit = new Map<string, number>();
  private readonly transfers = new Map<string, (bytes: number, total: number) => void>();

  constructor(source: EventSource) {
    void source.addListener('transferProgress', ({ transferId, bytes, total }) => {
      this.transfers.get(transferId)?.(bytes, total);
    });
    void source.addListener('shellData', ({ channelId, data }) => {
      const handlers = this.channels.get(channelId);
      if (handlers) handlers.onData(data);
      else push(this.pendingData, channelId, data);
    });
    void source.addListener('shellStderr', ({ channelId, data }) => {
      const handlers = this.channels.get(channelId);
      if (handlers) handlers.onStderr?.(data);
      else push(this.pendingStderr, channelId, data);
    });
    void source.addListener('shellExit', ({ channelId, code }) => {
      const handlers = this.channels.get(channelId);
      if (handlers) {
        this.unbindChannel(channelId);
        handlers.onExit(code);
      } else {
        this.pendingExit.set(channelId, code);
      }
    });
    void source.addListener('sessionClosed', ({ sessionId }) => {
      const handler = this.closed.get(sessionId);
      this.closed.delete(sessionId);
      handler?.();
    });
  }

  bindChannel(channelId: string, handlers: ChannelHandlers): void {
    this.channels.set(channelId, handlers);
    const data = this.pendingData.get(channelId);
    if (data) {
      this.pendingData.delete(channelId);
      for (const chunk of data) handlers.onData(chunk);
    }
    const stderr = this.pendingStderr.get(channelId);
    if (stderr) {
      this.pendingStderr.delete(channelId);
      for (const chunk of stderr) handlers.onStderr?.(chunk);
    }
    if (this.pendingExit.has(channelId)) {
      const code = this.pendingExit.get(channelId)!;
      this.unbindChannel(channelId);
      handlers.onExit(code);
    }
  }

  unbindChannel(channelId: string): void {
    this.channels.delete(channelId);
    this.pendingData.delete(channelId);
    this.pendingStderr.delete(channelId);
    this.pendingExit.delete(channelId);
  }

  bindSession(sessionId: string, onClose: () => void): void {
    this.closed.set(sessionId, onClose);
  }

  unbindSession(sessionId: string): void {
    this.closed.delete(sessionId);
  }

  bindTransfer(transferId: string, onProgress: (bytes: number, total: number) => void): void {
    this.transfers.set(transferId, onProgress);
  }

  unbindTransfer(transferId: string): void {
    this.transfers.delete(transferId);
  }
}

function push(map: Map<string, string[]>, key: string, data: string): void {
  const buf = map.get(key) ?? [];
  buf.push(data);
  map.set(key, buf);
}
