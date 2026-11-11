/**
 * Errors the transports raise for a command that could not run, phrased for
 * the person at the screen rather than for ssh2's debug log.
 */

/** A command exceeded the deadline its caller set; its channel was closed. */
export class ExecTimeoutError extends Error {
  readonly command: string;
  readonly timeoutMs: number;

  constructor(command: string, timeoutMs: number) {
    super(`Command timed out after ${Math.round(timeoutMs / 1000)} s: ${briefCommand(command)}`);
    this.name = 'ExecTimeoutError';
    this.command = command;
    this.timeoutMs = timeoutMs;
  }
}

function briefCommand(command: string): string {
  const flat = command.replace(/\s+/g, ' ').trim();
  return flat.length > 80 ? `${flat.slice(0, 77)}…` : flat;
}

/** SSH channel-open failure reason codes (RFC 4254 §5.1). */
const ADMINISTRATIVELY_PROHIBITED = 1;
const CONNECT_FAILED = 2;
const RESOURCE_SHORTAGE = 4;

/**
 * Translate ssh2's bare "(SSH) Channel open failure: open failed" into what
 * happened. OpenSSH answers a session request with CONNECT_FAILED / "open
 * failed" when the connection already holds `MaxSessions` session channels
 * (10 by default) — every terminal tab, the SFTP channel and each running
 * command count. Anything that is not a channel-open failure passes through.
 */
export function describeChannelOpenError(err: unknown, hostLabel: string): Error {
  const e = err as { message?: unknown; reason?: unknown } | null;
  const message = typeof e?.message === 'string' ? e.message : String(err);
  if (!/channel open failure/i.test(message)) {
    return err instanceof Error ? err : new Error(message);
  }
  const reason = typeof e?.reason === 'number' ? e.reason : undefined;
  let text: string;
  if (reason === CONNECT_FAILED || reason === RESOURCE_SHORTAGE) {
    text =
      `${hostLabel} refused to open another SSH session: this connection has reached ` +
      `sshd's MaxSessions limit (10 by default). Close some terminals on this host, ` +
      `or disconnect and reconnect it.`;
  } else if (reason === ADMINISTRATIVELY_PROHIBITED) {
    text = `${hostLabel} does not allow this kind of SSH channel (administratively prohibited).`;
  } else {
    text = `${hostLabel}: SSH channel open failed (${message.replace(/^\(SSH\)\s*/, '')}).`;
  }
  const out = new Error(text, { cause: err });
  out.name = 'ChannelOpenError';
  return out;
}
