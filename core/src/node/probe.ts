import { connect } from 'node:net';
import type { ProbeResult } from '../types';

/**
 * Probe one endpoint for a live SSH listener. Latency is measured to the
 * first data chunk carrying the `SSH-` version banner — an open port that
 * isn't an sshd (or never speaks) reports failure, not a false positive.
 * Never rejects: failures come back in the result.
 */
export function probeSsh(addr: string, port: number, timeoutMs = 4000): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = connect({ host: addr, port });
    let settled = false;
    const finish = (result: ProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: false, error: 'timeout' }), timeoutMs);

    socket.once('data', (chunk: Buffer) => {
      const banner = chunk.toString('utf8').split('\n')[0]?.trim();
      if (banner?.startsWith('SSH-')) {
        finish({ ok: true, latencyMs: Math.max(1, Date.now() - started), banner });
      } else {
        finish({ ok: false, error: 'other', detail: 'not an SSH listener' });
      }
    });
    socket.once('error', (err: NodeJS.ErrnoException) => {
      const code = err.code ?? '';
      const error =
        code === 'ECONNREFUSED'
          ? 'refused'
          : code === 'EHOSTUNREACH' || code === 'ENETUNREACH' || code === 'ENOTFOUND'
            ? 'unreachable'
            : 'other';
      finish({ ok: false, error, detail: err.message });
    });
  });
}
