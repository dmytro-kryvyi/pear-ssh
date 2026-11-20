import { spawn } from 'node:child_process';
import type { TermSize } from '../../types';
import type { ShellChannel } from '../../ssh/transport';
import { PtyChannel, loadPty } from '../local';
import { loginShell, posix, runInLoginShell } from './shell';

/** What a Claude PTY runs: the interactive CLI, or its sign-in flow. */
export type ClaudePtyCommand = 'claude' | 'login';

/**
 * Launches the user's own `claude` CLI in a PTY inside the given workspace
 * dir. Pear never handles credentials: the CLI authenticates itself (its
 * login flow, if needed, renders right in this PTY — `login` runs it
 * directly, `claude auth login`, and exits when done).
 */
export function launchClaudePty(
  dir: string,
  size: TermSize,
  command: ClaudePtyCommand = 'claude',
): ShellChannel {
  const { file, commandArgs } = loginShell();
  const cli = command === 'login' ? 'claude auth login' : 'claude';
  const pty = loadPty().spawn(file, commandArgs(posix ? `exec ${cli}` : cli), {
    name: 'xterm-256color',
    cols: size.cols,
    rows: size.rows,
    cwd: dir,
    env: process.env as Record<string, string>,
  });
  return new PtyChannel(pty);
}

/**
 * Whether the CLI reports itself signed in (`claude auth status --json`).
 * undefined when the CLI can't be asked (old version, timeout, parse error)
 * so callers fall back to "unknown" rather than a false "signed out". Pear
 * reads only this report — never the credential store behind it.
 */
export async function claudeAuthStatus(): Promise<boolean | undefined> {
  try {
    // Non-zero exit is normal when signed out; the JSON on stdout still says why.
    const { stdout } = await runInLoginShell('claude auth status --json', { timeoutMs: 4_000 });
    const start = stdout.indexOf('{');
    if (start < 0) return undefined;
    const parsed = JSON.parse(stdout.slice(start)) as { loggedIn?: unknown };
    return typeof parsed.loggedIn === 'boolean' ? parsed.loggedIn : undefined;
  } catch {
    return undefined;
  }
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
