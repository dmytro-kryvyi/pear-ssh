import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SubHostTransport,
  parseStatListing,
  probeCommand,
  probeError,
  subExec,
  subShellCommand,
} from './subhost';
import type { ExecResult, ShellChannel, SshTransport } from './transport';
import type { DirListing, SubHostTarget, TermSize } from '../types';

const DOCKER: SubHostTarget = { type: 'docker', ref: 'web' };
const LXC: SubHostTarget = { type: 'lxc', ref: '101' };
const SIZE: TermSize = { cols: 80, rows: 24 };

const ok = (stdout = ''): ExecResult => ({ code: 0, stdout, stderr: '' });
const fail = (stderr: string, code = 1): ExecResult => ({ code, stdout: '', stderr });

class FakeChannel implements ShellChannel {
  closed = false;
  private closeCbs: Array<() => void> = [];
  write(): void {}
  resize(): void {}
  close(): void {
    this.closed = true;
    for (const cb of this.closeCbs) cb();
  }
  onData(): void {}
  onClose(cb: () => void): void {
    this.closeCbs.push(cb);
  }
}

/** Parent transport recording every call; exec answers come from a handler. */
class FakeParent implements SshTransport {
  isConnected = true;
  execs: string[] = [];
  shellCommands: string[] = [];
  channels: FakeChannel[] = [];
  reads: string[] = [];
  writes: Array<[string, string]> = [];
  uploads: Array<[string, string]> = [];
  disposed = false;
  private closeCbs: Array<() => void> = [];

  constructor(private readonly answer: (cmd: string) => ExecResult = () => ok()) {}

  async connect(): Promise<void> {}
  onClose(cb: () => void): void {
    this.closeCbs.push(cb);
  }
  async shell(): Promise<ShellChannel> {
    throw new Error('sub-hosts never open the parent login shell');
  }
  async shellCommand(command: string): Promise<ShellChannel> {
    this.shellCommands.push(command);
    const channel = new FakeChannel();
    this.channels.push(channel);
    return channel;
  }
  async exec(command: string): Promise<ExecResult> {
    this.execs.push(command);
    return this.answer(command);
  }
  async listDir(): Promise<DirListing> {
    return { path: '/', entries: [] };
  }
  async readFile(path: string): Promise<string> {
    this.reads.push(path);
    return 'file-content';
  }
  async writeFile(path: string, content: string): Promise<void> {
    this.writes.push([path, content]);
  }
  async upload(localPath: string): Promise<string> {
    this.uploads.push([localPath, '/tmp']);
    return `/tmp/${localPath.split('/').pop()}`;
  }
  async stat(): Promise<null> {
    return null;
  }
  async mkdir(): Promise<void> {}
  async remove(): Promise<void> {}
  async rename(): Promise<void> {}
  async copy(): Promise<void> {}
  downloads: Array<[string, string]> = [];
  uploadFiles: Array<[string, string]> = [];
  async download(remotePath: string, localPath: string): Promise<void> {
    this.downloads.push([remotePath, localPath]);
  }
  async uploadFile(localPath: string, remotePath: string): Promise<void> {
    this.uploadFiles.push([localPath, remotePath]);
  }
  dispose(): void {
    this.disposed = true;
  }

  drop(): void {
    this.isConnected = false;
    for (const cb of this.closeCbs) cb();
  }
}

async function connected(parent: FakeParent, target = DOCKER): Promise<SubHostTransport> {
  const sub = new SubHostTransport(parent, target);
  await sub.connect();
  return sub;
}

// ---- Command builders ------------------------------------------------------

test('subExec quotes refs and nested commands safely', () => {
  const cmd = subExec({ type: 'docker', ref: "we'b" }, `cat 'a b.txt'`);
  assert.equal(cmd, `docker exec 'we'\\''b' /bin/sh -c 'cat '\\''a b.txt'\\'''`);
});

test('subExec targets lxc through pct', () => {
  assert.equal(subExec(LXC, 'ls'), `pct exec '101' -- /bin/sh -c 'ls'`);
});

test('subShellCommand prefers bash, falls back to sh; lxc uses pct enter', () => {
  const docker = subShellCommand(DOCKER);
  assert.ok(docker.startsWith(`docker exec -it -e TERM=xterm-256color 'web'`));
  assert.ok(docker.includes('exec bash -l'));
  assert.ok(docker.includes('exec sh -l'));
  assert.equal(subShellCommand(LXC), `pct enter '101'`);
});

// ---- Probe error mapping ---------------------------------------------------

test('probe errors map to friendly messages', () => {
  assert.equal(
    probeError(DOCKER, fail('Error: No such container: web')),
    `Container 'web' not found`,
  );
  assert.equal(
    probeError(DOCKER, fail('container web is not running')),
    `Container 'web' is not running`,
  );
  assert.equal(
    probeError(DOCKER, fail('OCI runtime exec failed: exec failed: executable file not found')),
    `Container 'web' has no shell (distroless image?)`,
  );
  assert.equal(
    probeError(LXC, fail('Configuration file "nodes/pve/lxc/101.conf" does not exist')),
    'CT 101 not found',
  );
  assert.equal(probeError(LXC, fail('CT 101 not running')), 'CT 101 is not running');
  // Newer containerd/crun drop the "OCI runtime exec failed" prefix.
  assert.equal(
    probeError(
      DOCKER,
      fail('exec failed: unable to start container process: exec: "/bin/sh": stat /bin/sh: no such file or directory', 127),
    ),
    `Container 'web' has no shell (distroless image?)`,
  );
  assert.equal(
    probeError(DOCKER, fail('exec: "nosuchcmd": executable file not found in $PATH', 127)),
    `Container 'web' has no shell (distroless image?)`,
  );
  // Some shims report on stdout with an empty stderr.
  assert.equal(
    probeError(DOCKER, { code: 127, stdout: 'Error: No such container: web', stderr: '' }),
    `Container 'web' not found`,
  );
  // zsh words its "not found" the other way round.
  assert.equal(
    probeError(DOCKER, fail('zsh:1: command not found: docker', 127)),
    'docker not available on the parent host',
  );
  // A silent cannot-exec exit still points at the likely cause.
  assert.equal(
    probeError(DOCKER, fail('', 127)),
    `Container 'web' has no shell to enter (distroless image?) — exit 127`,
  );
  assert.equal(probeError(DOCKER, fail('', 1)), `Cannot enter Container 'web': exit 1`);
});

test('connect rejects with the friendly message and stays disconnected', async () => {
  const parent = new FakeParent(() => fail('Error: No such container: web'));
  const sub = new SubHostTransport(parent, DOCKER);

  await assert.rejects(() => sub.connect(), /Container 'web' not found/);
  assert.equal(sub.isConnected, false);
});

// ---- Directory listing -----------------------------------------------------

test('parseStatListing decodes hex modes, sizes, mtimes and spaced names', () => {
  const listing = parseStatListing(
    ['/opt/app', '41ed 4096 1700000000 src', '81a4 120 1700000100 my file.txt', 'a1ff 12 1700000200 link'].join(
      '\n',
    ),
  );
  assert.equal(listing.path, '/opt/app');
  assert.deepEqual(listing.entries, [
    { name: 'src', kind: 'dir', size: 4096, mtimeMs: 1700000000000, mode: 'drwxr-xr-x' },
    { name: 'my file.txt', kind: 'file', size: 120, mtimeMs: 1700000100000, mode: '-rw-r--r--' },
    { name: 'link', kind: 'link', size: 12, mtimeMs: 1700000200000, mode: 'lrwxrwxrwx' },
  ]);
});

test('listDir resolves ~ to the container home and parses entries', async () => {
  const parent = new FakeParent((cmd) =>
    cmd.includes('while IFS=') ? ok('/root\n41ed 4096 1700000000 .ssh') : ok('root\n'),
  );
  const sub = await connected(parent);

  const listing = await sub.listDir('~');

  assert.equal(listing.path, '/root');
  assert.equal(listing.entries[0].name, '.ssh');
  // The home fallback avoids `cd --` (docker exec may not set HOME usefully).
  assert.ok(parent.execs.at(-1)!.includes('cd 2>/dev/null || cd /'));
});

test('listDir surfaces missing stat as a utilities error', async () => {
  const parent = new FakeParent((cmd) =>
    cmd.includes('while IFS=') ? fail('sh: stat: not found', 127) : ok('root\n'),
  );
  const sub = await connected(parent);

  await assert.rejects(() => sub.listDir('/'), /lacks basic shell utilities/);
});

// ---- File content ops (SFTP + docker cp / pct staging) ---------------------

test('readFile stages through docker cp and always cleans the tmp file', async () => {
  const parent = new FakeParent((cmd) => (cmd.includes('stat -c %s') ? ok('42\n') : ok()));
  const sub = await connected(parent);

  const content = await sub.readFile('/etc/app.conf');

  assert.equal(content, 'file-content');
  const cp = parent.execs.find((c) => c.startsWith('docker cp'));
  assert.ok(cp?.includes(`'web:/etc/app.conf'`));
  assert.equal(parent.reads.length, 1);
  assert.ok(parent.reads[0].startsWith('/tmp/.pear-'));
  assert.ok(parent.execs.at(-1)!.startsWith('rm -f '));
});

test('readFile rejects oversized files before copying anything', async () => {
  const parent = new FakeParent((cmd) =>
    cmd.includes('stat -c %s') ? ok(`${20 * 1024 * 1024}\n`) : ok(),
  );
  const sub = await connected(parent);

  await assert.rejects(() => sub.readFile('/var/log/big.log'), /too large to edit/);
  assert.equal(parent.execs.some((c) => c.startsWith('docker cp')), false);
});

test('readFile cleans the tmp file even when the copy fails', async () => {
  const parent = new FakeParent((cmd) => {
    if (cmd.includes('stat -c %s')) return ok('42\n');
    if (cmd.startsWith('docker cp')) return fail('no such file');
    return ok();
  });
  const sub = await connected(parent);

  await assert.rejects(() => sub.readFile('/gone'), /copy out of container/);
  assert.ok(parent.execs.at(-1)!.startsWith('rm -f '));
});

test('writeFile stages through the parent SFTP then pct push for lxc', async () => {
  const parent = new FakeParent();
  const sub = await connected(parent, LXC);

  await sub.writeFile('/etc/motd', 'hi');

  const [tmpPath, content] = parent.writes[0];
  assert.ok(tmpPath.startsWith('/tmp/.pear-'));
  assert.equal(content, 'hi');
  const push = parent.execs.find((c) => c.startsWith('pct push'));
  assert.ok(push?.includes(`'101' '${tmpPath}' '/etc/motd'`));
  assert.ok(parent.execs.at(-1)!.startsWith('rm -f '));
});

test('upload lands in the container dir and cleans the parent tmp copy', async () => {
  const parent = new FakeParent();
  const sub = await connected(parent);

  const dest = await sub.upload('/home/me/notes.txt', '/opt/data/');

  assert.equal(dest, '/opt/data/notes.txt');
  const cp = parent.execs.find((c) => c.startsWith('docker cp'));
  assert.ok(cp?.includes(`'/tmp/notes.txt' 'web:/opt/data/notes.txt'`));
  assert.ok(parent.execs.at(-1)!.startsWith('rm -f '));
});

// ---- Shells and lifecycle --------------------------------------------------

test('shell opens the enter command in a parent PTY', async () => {
  const parent = new FakeParent();
  const sub = await connected(parent);

  await sub.shell(SIZE);

  assert.deepEqual(parent.shellCommands, [subShellCommand(DOCKER)]);
});

test('shellCommand re-wraps so sub-hosts nest', async () => {
  const parent = new FakeParent();
  const sub = await connected(parent);

  await sub.shellCommand(`pct enter '200'`, SIZE);

  assert.ok(parent.shellCommands[0].startsWith('docker exec -it'));
  assert.ok(parent.shellCommands[0].includes(`pct enter '\\''200'\\''`));
});

test('dispose closes tracked channels and never touches the parent', async () => {
  const parent = new FakeParent();
  const sub = await connected(parent);
  const channel = (await sub.shell(SIZE)) as FakeChannel;
  let closed = false;
  sub.onClose(() => (closed = true));

  sub.dispose();

  assert.ok(channel.closed);
  assert.ok(closed);
  assert.equal(parent.disposed, false);
  assert.ok(parent.isConnected);
});

test('a parent drop tears the sub-host down', async () => {
  const parent = new FakeParent();
  const sub = await connected(parent);
  let closed = false;
  sub.onClose(() => (closed = true));

  parent.drop();

  assert.ok(closed);
  assert.equal(sub.isConnected, false);
});

test('probeCommand asks for the effective user in one round trip', () => {
  assert.ok(probeCommand(DOCKER).includes('whoami'));
  assert.ok(probeCommand(DOCKER).startsWith(`docker exec 'web'`));
});
