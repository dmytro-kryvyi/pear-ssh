import type { PearSshPlugin } from './pear-ssh';

type EventSource = Pick<PearSshPlugin, 'addListener'>;

/**
 * Routes the plugin's global event streams (shellData/shellExit/
 * sessionClosed) to per-channel and per-session handlers. Output that
 * arrives before a channel's handler is bound — possible in the gap between
 * shellOpen resolving and the caller wiring onData — is buffered and
 * flushed on bind, so no bytes are dropped.
 */
export class SshEventHub {
  private readonly data = new Map<string, (chunk: string) => void>();
  private readonly exit = new Map<string, () => void>();
  private readonly closed = new Map<string, () => void>();
  private readonly pendingData = new Map<string, string[]>();
  private readonly pendingExit = new Set<string>();

  constructor(source: EventSource) {
    void source.addListener('shellData', ({ channelId, data }) => {
      const handler = this.data.get(channelId);
      if (handler) {
        handler(data);
      } else {
        const buf = this.pendingData.get(channelId) ?? [];
        buf.push(data);
        this.pendingData.set(channelId, buf);
      }
    });
    void source.addListener('shellExit', ({ channelId }) => {
      const handler = this.exit.get(channelId);
      if (handler) {
        this.unbindChannel(channelId);
        handler();
      } else {
        this.pendingExit.add(channelId);
      }
    });
    void source.addListener('sessionClosed', ({ sessionId }) => {
      const handler = this.closed.get(sessionId);
      this.closed.delete(sessionId);
      handler?.();
    });
  }

  bindChannel(channelId: string, onData: (chunk: string) => void, onExit: () => void): void {
    this.data.set(channelId, onData);
    this.exit.set(channelId, onExit);
    const buffered = this.pendingData.get(channelId);
    if (buffered) {
      this.pendingData.delete(channelId);
      for (const chunk of buffered) onData(chunk);
    }
    if (this.pendingExit.delete(channelId)) {
      this.unbindChannel(channelId);
      onExit();
    }
  }

  unbindChannel(channelId: string): void {
    this.data.delete(channelId);
    this.exit.delete(channelId);
    this.pendingData.delete(channelId);
    this.pendingExit.delete(channelId);
  }

  bindSession(sessionId: string, onClose: () => void): void {
    this.closed.set(sessionId, onClose);
  }

  unbindSession(sessionId: string): void {
    this.closed.delete(sessionId);
  }
}
