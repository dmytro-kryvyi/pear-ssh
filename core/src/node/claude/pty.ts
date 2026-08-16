import { spawn } from 'node:child_process';
import type { TermSize } from '../../types';
import type { ShellChannel } from '../../ssh/transport';
import { PtyChannel, loadPty } from '../local';

const posix = process.platform !== 'win32';

function loginShell(): { file: string; commandArgs: (cmd: string) => string[] } {
  if (!posix) {
    const file = process.env['COMSPEC'] ?? 'cmd.exe';
    return { file, commandArgs: (cmd) => ['/c', cmd] };
  }
  const file = process.env['SHELL'] ?? '/bin/bash';
  // Login shell so the user's PATH additions (nvm, ~/.local/bin, …) apply —
  // Electron launched from a desktop entry doesn't inherit them.
  return { file, commandArgs: (cmd) => ['-l', '-c', cmd] };
}

/**
 * Launches the user's own `claude` CLI in a PTY inside the given workspace
 * dir. Pear never handles credentials: the CLI authenticates itself (its
 * login flow, if needed, renders right in this PTY).
 */
export function launchClaudePty(dir: string, size: TermSize): ShellChannel {
  const { file, commandArgs } = loginShell();
  const pty = loadPty().spawn(file, commandArgs(posix ? 'exec claude' : 'claude'), {
    name: 'xterm-256color',
    cols: size.cols,
    rows: size.rows,
    cwd: dir,
    env: process.env as Record<string, string>,
  });
  return new PtyChannel(pty);
}

/** Whether `claude` resolves in the user's login shell. */
export function claudeInstalled(): Promise<boolean> {
  return new Promise((resolve) => {
    const { file, commandArgs } = loginShell();
    const child = spawn(file, commandArgs(posix ? 'command -v claude' : 'where claude'), {
      stdio: 'ignore',
    });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}
