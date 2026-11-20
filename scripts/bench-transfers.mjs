#!/usr/bin/env node
// Real-host transfer benchmark: drives the actual TransferEngine with ssh2
// connections against test hosts and prints a timing table. Every case is
// checked (file count and a checksum over the tree) before its time counts.
//
//   node scripts/bench-transfers.mjs --key ~/.ssh/pear-test \
//     --a root@192.168.88.66 --b root@192.168.88.67 \
//     [--docker box-alpine] [--pve root@100.66.0.3 --lxc 118] [--only upload,relay]
//
// Needs `npm run build -w core` first. Fixtures live under ~/.cache/pear-bench
// (never /tmp: on the dev box that is RAM) and are removed afterwards, as are
// the remote ~/pear-bench directories.
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(ROOT, 'package.json'));
const BENCH = join(homedir(), '.cache', 'pear-bench');
mkdirSync(join(BENCH, 'tmp'), { recursive: true });
process.env.TMPDIR = join(BENCH, 'tmp'); // staging dirs of relays land on disk, not tmpfs

const { TransferEngine, SubHostTransport } = require(join(ROOT, 'core/dist/index.js'));
const { SshConnection, LocalConnection, nodeTarIo, makeStagingDir, removeStaging } = require(
  join(ROOT, 'core/dist/node/index.js'),
);

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .reduce(
      (acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc),
      [],
    ),
);
const only = args.only ? new Set(args.only.split(',')) : null;
const want = (group) => !only || only.has(group);
const key = (args.key ?? '~/.ssh/id_ed25519').replace(/^~/, homedir());
const REMOTE = '/root/pear-bench';

function hostConfig(id, spec, keyPath = key) {
  const [user, host] = spec.split('@');
  return {
    id,
    name: id,
    host,
    port: 22,
    user,
    kind: 'plain',
    auth: { method: 'key', privateKeyPath: keyPath },
  };
}

// ---- fixtures ---------------------------------------------------------------

const FIX = join(BENCH, 'fixtures');
function makeFixtures() {
  if (existsSync(join(FIX, '.done'))) return;
  rmSync(FIX, { recursive: true, force: true });
  // tiny: the latency-bound case — many small files in many folders.
  for (let d = 0; d < 100; d++) {
    const dir = join(FIX, 'tiny', `d${String(d).padStart(3, '0')}`);
    mkdirSync(dir, { recursive: true });
    for (let f = 0; f < 50; f++)
      writeFileSync(join(dir, `f${f}.txt`), `tiny ${d}/${f}\n`.repeat(8));
  }
  // text: compressible, a few MB.
  mkdirSync(join(FIX, 'text'), { recursive: true });
  for (let f = 0; f < 200; f++) {
    writeFileSync(
      join(FIX, 'text', `log${f}.txt`),
      `2026-11-20 INFO request ${f} served in 12ms\n`.repeat(6000),
    );
  }
  // big: one incompressible file.
  mkdirSync(join(FIX, 'big'), { recursive: true });
  const fd = require('node:fs').openSync(join(FIX, 'big', 'big.bin'), 'w');
  for (let i = 0; i < 256; i++) require('node:fs').writeSync(fd, randomBytes(1024 * 1024));
  require('node:fs').closeSync(fd);
  writeFileSync(join(FIX, '.done'), '');
}

const treeSum = (dir) =>
  execFileSync('sh', [
    '-c',
    `cd ${JSON.stringify(dir)} && find . -type f | sort | xargs sha256sum | sha256sum`,
  ])
    .toString()
    .split(' ')[0];
const REMOTE_SUM = (dir) => `cd '${dir}' && find . -type f | sort | xargs sha256sum | sha256sum`;

// ---- engine harness -----------------------------------------------------------

/** A transport with the stream channel hidden: how things were before tar streams. */
const sftpOnly = (t) =>
  new Proxy(t, {
    get: (o, p) => (p === 'execPipe' || p === 'prefersPipe' ? undefined : Reflect.get(o, p, o)),
  });

async function run(label, { transports, req, tar = true }) {
  const local = new LocalConnection();
  await local.connect();
  const updates = [];
  const engine = new TransferEngine(
    {
      connection: async (id) => (id === null ? local : transports[id]),
      makeStagingDir,
      removeStaging,
      tar: tar ? nodeTarIo : undefined,
    },
    { onUpdate: (j) => updates.push(j) },
  );
  const t0 = Date.now();
  let id = engine.start({ op: 'copy', conflict: 'overwrite', verify: false, ...req });
  const settle = () =>
    new Promise((resolve) => {
      const timer = setInterval(() => {
        const last = updates.filter((u) => u.id === id).at(-1);
        if (last && ['done', 'error', 'canceled'].includes(last.status)) {
          clearInterval(timer);
          resolve(last);
        }
      }, 20);
    });
  return { engine, updates, settle, t0, setId: (n) => (id = n), label };
}

const rows = [];
function record(group, label, secs, last, note = '') {
  const mb = last.bytesTotal / 1024 / 1024;
  const files = (last.filesDone ?? 0) + (last.filesSkipped ?? 0);
  rows.push({ group, label, secs, files, mb, note, ok: last.status === 'done' });
  const rate =
    secs > 0
      ? `${(mb / secs).toFixed(1)} MB/s, ${Math.round((last.filesDone ?? 0) / secs)} files/s`
      : '';
  console.log(
    `${last.status === 'done' ? 'ok  ' : 'FAIL'} ${group.padEnd(10)} ${label.padEnd(46)} ${secs.toFixed(1).padStart(7)} s  ${rate}  ${note}${last.error ? ' ERROR: ' + last.error : ''}`,
  );
}

async function timed(group, label, opts, check) {
  const h = await run(label, opts);
  const last = await h.settle();
  const secs = (Date.now() - h.t0) / 1000;
  let note = '';
  if (last.status === 'done' && check) {
    const problem = await check(last);
    if (problem) {
      last.status = 'error';
      last.error = problem;
    }
  }
  if (last.direct) note = 'direct';
  if (last.filesSkipped) note = `${last.filesSkipped} skipped`;
  record(group, label, secs, last, note);
  return last;
}

// ---- main ---------------------------------------------------------------------

makeFixtures();
const sums = {
  tiny: treeSum(join(FIX, 'tiny')),
  text: treeSum(join(FIX, 'text')),
  big: treeSum(join(FIX, 'big')),
};
const conns = [];
const connect = async (id, spec, keyPath) => {
  const c = new SshConnection(hostConfig(id, spec, keyPath));
  await c.connect();
  conns.push(c);
  return c;
};
const A = await connect('a', args.a);
const B = args.b ? await connect('b', args.b) : null;
const sh = async (t, cmd) => {
  const r = await t.exec(cmd);
  if (r.code !== 0) throw new Error(`${cmd}: ${r.stderr.trim() || r.code}`);
  return r.stdout.trim();
};
const reset = async (t) => sh(t, `rm -rf ${REMOTE} && mkdir -p ${REMOTE}`);
const remoteIs = (t, dir, sum) => async () => {
  const got = (await sh(t, REMOTE_SUM(dir))).split(' ')[0];
  return got === sum ? '' : `checksum of ${dir} differs`;
};
const up = (hostId, names, extra = {}) => ({
  src: { hostId: null, dir: FIX },
  dest: { hostId, dir: REMOTE },
  names,
  ...extra,
});

console.log(`A = ${args.a} (${await sh(A, 'tar --version 2>&1 | head -1')})`);
if (B) console.log(`B = ${args.b} (${await sh(B, 'tar --version 2>&1 | head -1')})`);
console.log(
  `fixtures: tiny 5000 files, text 200 files (${((200 * 6000 * 44) / 1048576).toFixed(0)} MB), big 256 MB\n`,
);

if (want('upload')) {
  await reset(A);
  await timed(
    'upload',
    'tiny → A, per file (before)',
    { transports: { a: sftpOnly(A) }, req: up('a', ['tiny']), tar: false },
    remoteIs(A, `${REMOTE}/tiny`, sums.tiny),
  );
  await reset(A);
  await timed(
    'upload',
    'tiny → A, tar stream',
    { transports: { a: A }, req: up('a', ['tiny']) },
    remoteIs(A, `${REMOTE}/tiny`, sums.tiny),
  );
  await timed(
    'upload',
    'tiny → A again, Update',
    { transports: { a: A }, req: up('a', ['tiny'], { conflict: 'update' }) },
    remoteIs(A, `${REMOTE}/tiny`, sums.tiny),
  );
  await reset(A);
  await timed(
    'upload',
    'text → A, tar stream',
    { transports: { a: A }, req: up('a', ['text']) },
    remoteIs(A, `${REMOTE}/text`, sums.text),
  );
  await reset(A);
  await timed(
    'upload',
    'text → A, tar stream + gzip',
    { transports: { a: A }, req: up('a', ['text'], { compress: true }) },
    remoteIs(A, `${REMOTE}/text`, sums.text),
  );
  await reset(A);
  await timed(
    'upload',
    'big 256 MB → A, SFTP',
    { transports: { a: A }, req: up('a', ['big']) },
    remoteIs(A, `${REMOTE}/big`, sums.big),
  );
  await timed(
    'upload',
    'tiny+text → A, verify on',
    { transports: { a: A }, req: up('a', ['tiny', 'text'], { verify: true }) },
    remoteIs(A, `${REMOTE}/tiny`, sums.tiny),
  );
}

if (want('download')) {
  await reset(A);
  await timed('setup', 'seed A', { transports: { a: A }, req: up('a', ['tiny', 'text']) });
  const DL = join(BENCH, 'dl');
  const down = (extra = {}) => ({
    src: { hostId: 'a', dir: REMOTE },
    dest: { hostId: null, dir: DL },
    names: ['tiny'],
    ...extra,
  });
  const fresh = () => (
    rmSync(DL, { recursive: true, force: true }),
    mkdirSync(DL, { recursive: true })
  );
  const localIs = (sum) => async () =>
    treeSum(join(DL, 'tiny')) === sum ? '' : 'downloaded tree differs';
  fresh();
  await timed(
    'download',
    'tiny ← A, per file + dir walk (before)',
    {
      transports: {
        a: sftpOnly(
          new Proxy(A, {
            get: (o, p) =>
              p === 'exec'
                ? async () => ({ code: 1, stdout: '', stderr: '' })
                : Reflect.get(o, p, o),
          }),
        ),
      },
      req: down(),
      tar: false,
    },
    localIs(sums.tiny),
  );
  fresh();
  await timed(
    'download',
    'tiny ← A, tar list mode',
    { transports: { a: A }, req: down() },
    localIs(sums.tiny),
  );
  await timed(
    'download',
    'tiny ← A again, Update',
    { transports: { a: A }, req: down({ conflict: 'update' }) },
    localIs(sums.tiny),
  );
  rmSync(DL, { recursive: true, force: true });
}

if (B && want('busybox')) {
  await reset(B);
  await timed(
    'busybox',
    'tiny → B, tar stream',
    { transports: { b: B }, req: up('b', ['tiny']) },
    remoteIs(B, `${REMOTE}/tiny`, sums.tiny),
  );
  await timed(
    'busybox',
    'tiny → B again, Update',
    { transports: { b: B }, req: up('b', ['tiny'], { conflict: 'update' }) },
    remoteIs(B, `${REMOTE}/tiny`, sums.tiny),
  );
  const DL = join(BENCH, 'dl');
  rmSync(DL, { recursive: true, force: true });
  mkdirSync(DL, { recursive: true });
  await timed(
    'busybox',
    'tiny ← B, tar roots mode',
    {
      transports: { b: B },
      req: { src: { hostId: 'b', dir: REMOTE }, dest: { hostId: null, dir: DL }, names: ['tiny'] },
    },
    async () => (treeSum(join(DL, 'tiny')) === sums.tiny ? '' : 'downloaded tree differs'),
  );
  rmSync(DL, { recursive: true, force: true });
  await timed(
    'busybox',
    'text → B, tar stream + gzip',
    { transports: { b: B }, req: up('b', ['text'], { compress: true }) },
    remoteIs(B, `${REMOTE}/text`, sums.text),
  );
}

if (B && want('relay')) {
  await reset(A);
  await timed('setup', 'seed A', { transports: { a: A }, req: up('a', ['tiny', 'text']) });
  const relay = {
    src: { hostId: 'a', dir: REMOTE },
    dest: { hostId: 'b', dir: REMOTE },
    names: ['tiny', 'text'],
  };
  await reset(B);
  await timed(
    'relay',
    'A → B, staged SFTP relay (before)',
    { transports: { a: sftpOnly(A), b: sftpOnly(B) }, req: relay, tar: false },
    remoteIs(B, `${REMOTE}/tiny`, sums.tiny),
  );
  await reset(B);
  await timed(
    'relay',
    'A → B, direct stream',
    { transports: { a: A, b: B }, req: relay },
    remoteIs(B, `${REMOTE}/text`, sums.text),
  );
  await reset(A);
  await timed(
    'relay',
    'B → A, direct stream (busybox source)',
    {
      transports: { a: A, b: B },
      req: {
        src: { hostId: 'b', dir: REMOTE },
        dest: { hostId: 'a', dir: REMOTE },
        names: ['tiny'],
      },
    },
    remoteIs(A, `${REMOTE}/tiny`, sums.tiny),
  );
}

if (want('resume')) {
  await reset(A);
  // A second connection that is cut mid-file: the job fails, the partial stays.
  const flaky = await connect('a', args.a);
  const h = await run('resume', {
    transports: { a: flaky },
    req: up('a', ['big'], { conflict: 'update' }),
  });
  const cutAt = await new Promise((resolve) => {
    const timer = setInterval(() => {
      const last = h.updates.at(-1);
      if (last && last.bytesDone > 150 * 1024 * 1024) {
        clearInterval(timer);
        flaky.dispose();
        resolve(last.bytesDone);
      }
    }, 10);
  });
  const failed = await h.settle();
  const partial = Number(await sh(A, `stat -c %s ${REMOTE}/big/big.bin 2>/dev/null || echo 0`));
  console.log(
    `     connection cut at ${(cutAt / 1048576).toFixed(0)} MB: job ${failed.status}, ${(partial / 1048576).toFixed(0)} MB left on the host`,
  );
  const fresh = await connect('a', args.a);
  const h2 = await run('retry', {
    transports: { a: fresh },
    req: up('a', ['big'], { conflict: 'update' }),
  });
  const done = await h2.settle();
  const secs = (Date.now() - h2.t0) / 1000;
  const firstProgress =
    h2.updates.find((u) => u.phase === 'copying' && u.bytesDone > 0)?.bytesDone ?? 0;
  const problem = done.status === 'done' ? await remoteIs(A, `${REMOTE}/big`, sums.big)() : '';
  if (problem) {
    done.status = 'error';
    done.error = problem;
  }
  record(
    'resume',
    'big → A after a cut, Update',
    secs,
    done,
    `resumed at ${(firstProgress / 1048576).toFixed(0)} MB`,
  );
}

if (args.docker && want('docker')) {
  const box = new SubHostTransport(A, { type: 'docker', ref: args.docker });
  await box.connect();
  await sh(box, `rm -rf ${REMOTE} && mkdir -p ${REMOTE}`);
  await timed('docker', `tiny → ${args.docker}, per file via docker cp (before)`, {
    transports: { c: sftpOnly(box) },
    req: up('c', ['tiny/d000', 'tiny/d001']),
    tar: false,
  });
  await sh(box, `rm -rf ${REMOTE} && mkdir -p ${REMOTE}`);
  await timed(
    'docker',
    `tiny → ${args.docker}, tar through docker exec -i`,
    { transports: { c: box }, req: up('c', ['tiny']) },
    remoteIs(box, `${REMOTE}/tiny`, sums.tiny),
  );
  await timed(
    'docker',
    `big 256 MB → ${args.docker}, pipe`,
    { transports: { c: box }, req: up('c', ['big']) },
    remoteIs(box, `${REMOTE}/big`, sums.big),
  );
  const DL = join(BENCH, 'dl');
  rmSync(DL, { recursive: true, force: true });
  mkdirSync(DL, { recursive: true });
  await timed(
    'docker',
    `big 256 MB ← ${args.docker}, pipe`,
    {
      transports: { c: box },
      req: {
        src: { hostId: 'c', dir: `${REMOTE}/big` },
        dest: { hostId: null, dir: DL },
        names: ['big.bin'],
      },
    },
    async () =>
      createHash('sha256')
        .update(readFileSync(join(DL, 'big.bin')))
        .digest('hex') ===
      createHash('sha256')
        .update(readFileSync(join(FIX, 'big', 'big.bin')))
        .digest('hex')
        ? ''
        : 'file differs',
  );
  rmSync(DL, { recursive: true, force: true });
  await sh(box, `rm -rf ${REMOTE}`);
}

if (args.pve && args.lxc && want('lxc')) {
  const node = await connect('pve', args.pve, join(homedir(), '.ssh', 'id_ed25519'));
  const ct = new SubHostTransport(node, { type: 'lxc', ref: String(args.lxc) });
  await ct.connect();
  await sh(ct, `rm -rf ${REMOTE} && mkdir -p ${REMOTE}`);
  await timed(
    'lxc',
    `tiny → CT ${args.lxc} through pct exec`,
    { transports: { c: ct }, req: up('c', ['tiny']) },
    remoteIs(ct, `${REMOTE}/tiny`, sums.tiny),
  );
  console.log(
    `     stream channel through pct exec: ${typeof ct.execPipe === 'function' ? 'offered' : 'not offered'}`,
  );
  await sh(ct, `rm -rf ${REMOTE}`);
}

for (const t of [A, B].filter(Boolean)) await sh(t, `rm -rf ${REMOTE}`).catch(() => {});
for (const c of conns) c.dispose();
if (!args.keep) rmSync(BENCH, { recursive: true, force: true });
const failed = rows.filter((r) => !r.ok);
console.log(`\n${rows.length - failed.length}/${rows.length} cases passed`);
process.exit(failed.length ? 1 : 0);
