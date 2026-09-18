import { generateKeyPairSync } from 'node:crypto';
import { Server } from 'ssh2';

export interface ScratchSshd {
  port: number;
  /** Last window-change the server saw, across all sessions. */
  lastResize(): { cols: number; rows: number } | null;
  /** Shells opened since start. */
  shells(): number;
  close(): void;
}

/**
 * In-process ssh2 server for tests (same shape as connection.test.ts): accepts
 * any auth, shells echo input back as `echo:<input>` after a banner, execs
 * answer `ran: <command>` — except the Proxmox probe (facet marker) and its
 * resource fetch (an empty cluster), so orchestration detection has something
 * real to chew on.
 */
export async function startScratchSshd(): Promise<ScratchSshd> {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
  });
  let lastResize: { cols: number; rows: number } | null = null;
  let shells = 0;

  const server = new Server({ hostKeys: [privateKey] }, (client) => {
    client.on('error', () => {});
    client.on('authentication', (ctx) => ctx.accept());
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept();
        session.on('pty', (a) => a?.());
        session.on('window-change', (a, _r, info) => {
          a?.();
          lastResize = { cols: info.cols, rows: info.rows };
        });
        // No SFTP subsystem: refuse it outright (an ignored request would hang
        // the client; core's transports fall back to exec on refusal).
        session.on('sftp', (_accept, reject) => reject?.());
        session.on('shell', (acceptShell) => {
          shells++;
          const stream = acceptShell();
          stream.write('motd-banner\r\n');
          stream.on('data', (d: Buffer) => stream.write(`echo:${d.toString()}`));
        });
        session.on('exec', (acceptExec, _rej, info) => {
          const stream = acceptExec();
          const cmd = info.command;
          if (cmd.includes('command -v pvesh')) stream.write('FACET:proxmox\n');
          else if (cmd.includes('pvesh get')) stream.write('scratch\n[]\n');
          else stream.write(`ran: ${cmd}\n`);
          stream.exit(0);
          stream.end();
        });
      });
    });
  });

  const port = await new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port));
  });
  return { port, lastResize: () => lastResize, shells: () => shells, close: () => server.close() };
}
