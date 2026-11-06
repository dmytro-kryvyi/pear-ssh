import { spawn } from 'node:child_process';

export const posix = process.platform !== 'win32';

/**
 * The user's login shell, for running `claude`. A login shell so PATH
 * additions (nvm, ~/.local/bin, …) apply — Electron launched from a desktop
 * entry doesn't inherit them.
 */
export function loginShell(): { file: string; commandArgs: (cmd: string) => string[] } {
  if (!posix) {
    const file = process.env['COMSPEC'] ?? 'cmd.exe';
    return { file, commandArgs: (cmd) => ['/c', cmd] };
  }
  const file = process.env['SHELL'] ?? '/bin/bash';
  return { file, commandArgs: (cmd) => ['-l', '-c', cmd] };
}

/**
 * Run one command in the login shell and collect stdout. Resolves on exit
 * (any code) or rejects on spawn failure / timeout. Used for the quick
 * `claude` queries (auth status, model list).
 */
export function runInLoginShell(
  command: string,
  opts: { timeoutMs: number; stdin?: string; cwd?: string },
): Promise<{ code: number | null; stdout: string }> {
  const { file, commandArgs } = loginShell();
  return new Promise((resolve, reject) => {
    const child = spawn(file, commandArgs(command), {
      cwd: opts.cwd,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    let stdout = '';
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      child.kill('SIGTERM');
      reject(new Error(`${command.split(' ')[0]} timed out`));
    }, opts.timeoutMs);
    child.stdout!.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, stdout });
    });
    if (opts.stdin !== undefined) child.stdin!.write(opts.stdin);
    child.stdin!.end();
  });
}
