// Dev runner: builds core+desktop, starts ng serve, then launches Electron
// pointed at the dev server. Ctrl+C tears everything down.
import { spawn } from 'node:child_process';
import { connect } from 'node:net';

const root = new URL('..', import.meta.url).pathname;
const run = (cmd, args, opts = {}) =>
  spawn(cmd, args, { cwd: root, stdio: 'inherit', ...opts });

const runWait = (cmd, args) =>
  new Promise((resolve, reject) => {
    run(cmd, args).on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(' ')} -> ${code}`)),
    );
  });

const waitForPort = (port, timeoutMs = 120_000) =>
  new Promise((resolve, reject) => {
    const started = Date.now();
    const tryOnce = () => {
      const sock = connect(port, '127.0.0.1');
      sock.once('connect', () => { sock.destroy(); resolve(); });
      sock.once('error', () => {
        sock.destroy();
        if (Date.now() - started > timeoutMs) reject(new Error(`port ${port} never opened`));
        else setTimeout(tryOnce, 500);
      });
    };
    tryOnce();
  });

await runWait('npm', ['run', 'build', '-w', 'core']);
await runWait('npm', ['run', 'build', '-w', 'desktop']);

const ng = run('npm', ['start', '-w', 'ui', '--', '--port', '4200']);
await waitForPort(4200);

// VSCode terminals export ELECTRON_RUN_AS_NODE=1, which would turn Electron
// into plain Node — strip it.
const env = { ...process.env, PEAR_DEV_URL: 'http://localhost:4200' };
delete env.ELECTRON_RUN_AS_NODE;

const electron = run('npx', ['electron', 'desktop/dist/main.js'], { env });

const stop = () => { ng.kill('SIGTERM'); electron.kill('SIGTERM'); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
electron.on('exit', stop);
