// Helpers shared by the engine (pure) and the Node tar glue for driving a
// PipeChannel: backpressure-aware writes, and the batch checksum exchange.

import type { PipeChannel } from '../ssh/transport';

declare class TextEncoder {
  encode(s: string): Uint8Array;
}
declare class TextDecoder {
  constructor(label?: string);
  decode(b: Uint8Array, opts?: { stream?: boolean }): string;
}

export class PipeClosedError extends Error {
  constructor(message = 'the remote command ended before the stream was complete') {
    super(message);
    this.name = 'PipeClosedError';
  }
}

/**
 * Serialises writes to a pipe against its window: `write` resolves once the
 * chunk was accepted (at once, or after the next drain) and rejects with
 * PipeClosedError if the channel closes first. ssh2 never calls a write's
 * callback once the channel is closed, so settling on 'close' is the only
 * way out of a stalled write.
 */
export class PipeWriter {
  closed = false;
  private waiters: (() => void)[] = [];

  constructor(private readonly pipe: PipeChannel) {
    pipe.onDrain(() => this.wake());
    pipe.onClose(() => {
      this.closed = true;
      this.wake();
    });
  }

  async write(chunk: Uint8Array): Promise<void> {
    if (this.closed) throw new PipeClosedError();
    if (chunk.length === 0 || this.pipe.write(chunk)) return;
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    if (this.closed) throw new PipeClosedError();
  }

  end(): void {
    if (!this.closed) this.pipe.end();
  }

  private wake(): void {
    const list = this.waiters;
    this.waiters = [];
    for (const w of list) w();
  }
}

/** Collect a pipe's stdout as text and resolve with it and the exit code. */
export function collectPipe(pipe: PipeChannel): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    const decoder = new TextDecoder();
    let stdout = '';
    pipe.onData((chunk) => (stdout += decoder.decode(chunk, { stream: true })));
    pipe.onClose((code) => resolve({ code, stdout: stdout + decoder.decode(new Uint8Array(0)) }));
  });
}

/** NUL-separated list, the form `xargs -0` reads. */
export function encodeNulList(names: string[]): Uint8Array {
  return new TextEncoder().encode(names.map((n) => n + '\0').join(''));
}

/**
 * Parse `sha256sum`/`shasum` output into name → hex. coreutils prints a
 * leading backslash and escapes `\` and newline in names that need it.
 */
export function parseHashLines(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of text.split('\n')) {
    let line = raw.replace(/\r$/, '');
    if (!line) continue;
    const escaped = line.startsWith('\\');
    if (escaped) line = line.slice(1);
    const m = line.match(/^([0-9a-fA-F]{64}) [ *](.*)$/);
    if (!m) continue;
    let name = m[2];
    if (escaped) name = name.replace(/\\(\\|n)/g, (_, c: string) => (c === 'n' ? '\n' : '\\'));
    out.set(name, m[1].toLowerCase());
  }
  return out;
}

/** The far side of a verify pass: hash every name under `dir`, NUL list on stdin. */
export function batchHashCommand(dir: string, shq: (s: string) => string): string {
  return (
    `cd ${shq(dir)} && if command -v sha256sum >/dev/null 2>&1; ` +
    `then xargs -0 sha256sum; else xargs -0 shasum -a 256; fi`
  );
}
