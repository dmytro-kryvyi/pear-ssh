import type { DirListing, HostConfig } from '@pear/core';
import { fmtBytes, fmtMtime } from '../util/fmt';

export interface PtyFs {
  list(path: string): Promise<DirListing>;
  read(path: string): Promise<string>;
}

export interface PtyIo {
  emit(data: string): void;
  exit(): void;
}

const CR = '\r\n';
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const blue = (s: string) => `\x1b[1;34m${s}\x1b[0m`;

/**
 * A byte-level PTY emulator behind the mock backend's term API, so the same
 * xterm.js terminal screen works in a desktop browser as on device: echo,
 * backspace, ^C/^L/^D, ANSI-colored prompt and ls, commands answered from
 * the seeded mock filesystem. Not a shell — just enough line discipline for
 * demos and UI development.
 */
export class FakePty {
  private buf = '';
  private cwd: string;
  private inEsc = false;
  private busy = false;
  private closed = false;

  constructor(
    private readonly host: HostConfig,
    private readonly fs: PtyFs,
    private readonly io: PtyIo,
    cwd?: string,
  ) {
    this.cwd = cwd ?? host.cwd ?? '/';
  }

  start(): void {
    const h = this.host;
    const ep = h.endpoints?.[0] ?? { addr: h.host, port: h.port };
    this.io.emit(
      dim(`Connecting to ${h.user}@${ep.addr}${ep.port !== 22 ? ':' + ep.port : ''} ...`) + CR +
      dim('Last login: Sat Aug 16 09:14:22 2026 from 10.0.2.14') + CR +
      `Welcome to ${h.name}` + CR,
    );
    for (const cmd of h.startup ?? []) {
      this.io.emit(this.promptStr() + cmd + CR + dim(`(startup) ${cmd}: ok`) + CR);
    }
    this.prompt();
  }

  private promptStr(): string {
    return `\x1b[1;32m${this.host.user}@${this.host.name}\x1b[0m:${blue(this.cwd)}$ `;
  }

  private prompt(): void {
    this.io.emit(this.promptStr());
  }

  input(data: string): void {
    if (this.closed) return;
    for (const ch of data) {
      if (this.inEsc) {
        // Swallow CSI/SS3 sequences (arrows, etc.) — final byte is @ … ~.
        if (/[@-~]/.test(ch) && ch !== '[' && ch !== 'O') this.inEsc = false;
        continue;
      }
      if (ch === '\x1b') {
        this.inEsc = true;
        continue;
      }
      if (this.busy) continue;
      if (ch === '\r' || ch === '\n') {
        this.io.emit(CR);
        const cmd = this.buf;
        this.buf = '';
        void this.run(cmd.trim());
      } else if (ch === '\x7f' || ch === '\b') {
        if (this.buf) {
          this.buf = this.buf.slice(0, -1);
          this.io.emit('\b \b');
        }
      } else if (ch === '\x03') {
        this.buf = '';
        this.io.emit('^C' + CR);
        this.prompt();
      } else if (ch === '\x04') {
        this.io.emit('logout' + CR);
        this.dispose();
      } else if (ch === '\x0c') {
        this.io.emit('\x1b[2J\x1b[H');
        this.prompt();
      } else if (ch === '\t') {
        // no completion in the mock
      } else if (ch >= ' ') {
        this.buf += ch;
        this.io.emit(ch);
      }
    }
  }

  private resolvePath(p: string): string {
    let next = p.startsWith('/') || p.startsWith('~')
      ? p
      : (this.cwd === '/' ? '/' : this.cwd + '/') + p;
    next = next.replace(/\/+/g, '/');
    if (next.endsWith('/..') || next === '..') {
      const base = next === '..' ? this.cwd : next.slice(0, -3);
      next = base.split('/').slice(0, -1).join('/') || '/';
    }
    if (next !== '/' && next.endsWith('/')) next = next.slice(0, -1);
    return next;
  }

  private async run(cmd: string): Promise<void> {
    if (!cmd) {
      this.prompt();
      return;
    }
    this.busy = true;
    try {
      const [name, ...args] = cmd.split(/\s+/);
      switch (name) {
        case 'clear':
          this.io.emit('\x1b[2J\x1b[H');
          break;
        case 'pwd':
          this.io.emit(this.cwd + CR);
          break;
        case 'whoami':
          this.io.emit(this.host.user + CR);
          break;
        case 'hostname':
          this.io.emit(this.host.name + CR);
          break;
        case 'echo':
          this.io.emit(args.join(' ') + CR);
          break;
        case 'exit':
        case 'logout':
          this.io.emit('logout' + CR);
          this.dispose();
          return;
        case 'cd': {
          const target = args[0] ?? '~';
          const listing = await this.fs.list(this.resolvePath(target));
          this.cwd = listing.path;
          break;
        }
        case 'ls':
        case 'll': {
          const long = name === 'll' || args.includes('-la') || args.includes('-l');
          const dir = args.find((a) => !a.startsWith('-'));
          const listing = await this.fs.list(dir ? this.resolvePath(dir) : this.cwd);
          for (const e of listing.entries) {
            const label = e.kind === 'dir' ? blue(e.name) + '/' : e.name;
            this.io.emit(
              long
                ? `${e.mode} ${this.host.user.padEnd(8)} ${fmtBytes(e.size).padStart(9)} ${fmtMtime(e.mtimeMs)} ${label}${CR}`
                : label + CR,
            );
          }
          break;
        }
        case 'cat': {
          const f = args.find((a) => !a.startsWith('-'));
          if (!f) break;
          const content = await this.fs.read(this.resolvePath(f));
          this.io.emit(content.replace(/\n$/, '').split('\n').join(CR) + CR);
          break;
        }
        case 'docker':
        case 'qm':
        case 'pct':
          // Orch "streaming" commands land here (logs -f, console).
          this.io.emit(
            dim(`[mock] would stream: ${cmd}`) + CR +
            dim('api    | GET /healthz 200 1ms') + CR +
            dim('api    | GET /v1/hosts 200 6ms') + CR,
          );
          break;
        default:
          this.io.emit(red(`zsh: command not found: ${name}`) + CR);
      }
    } catch (err) {
      this.io.emit(red(err instanceof Error ? err.message : String(err)) + CR);
    }
    this.busy = false;
    if (!this.closed) this.prompt();
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.io.exit();
  }
}
