import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { LocalConnection } from './local';
import { detectArchiveTools } from '../fs/archive';
import { planCompress, planExtract } from '../fs/archive-ops';
import { fileInfo } from '../fs/info';
import { applyPerms } from '../fs/perms';
import { FsOpsRunner, type FsOpSnapshot } from '../fs/ops-runner';

/**
 * Real round trip on this machine: tool detection, compress, info, extract,
 * chmod — the whole fs helper stack over LocalConnection's exec and PTY.
 */
const haveTar = process.platform !== 'win32' && spawnSync('tar', ['--version']).status === 0;

test('compress → info → extract → chmod round trip', { skip: !haveTar }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'pear-fsops-'));
  try {
    const src = join(root, 'site');
    mkdirSync(join(src, 'css'), { recursive: true });
    writeFileSync(join(src, 'index.html'), '<h1>hi</h1>');
    writeFileSync(join(src, 'css', 'a.css'), 'body{}');
    const conn = new LocalConnection();
    await conn.connect();
    const exec = (c: string) => conn.exec(c);

    const tools = await detectArchiveTools(exec);
    assert.ok(tools.tools.includes('tar'));
    assert.notEqual(tools.tar, 'none');

    const done = new Map<string, (op: FsOpSnapshot) => void>();
    const runner = new FsOpsRunner(
      { connection: async () => conn },
      {
        onUpdate: (op) => {
          if (op.status !== 'running') done.get(op.id)?.(op);
        },
      },
    );
    const settle = (id: string) => new Promise<FsOpSnapshot>((r) => done.set(id, r));

    const packed = await settle(
      runner.start({
        hostId: 'local',
        ...planCompress(tools, root, ['site'], 'site.tar.gz', 'tar.gz'),
      }),
    );
    assert.equal(packed.status, 'done', packed.error);
    const archive = join(root, 'site.tar.gz');
    const ai = await fileInfo(exec, archive);
    assert.equal(ai.kind, 'file');
    assert.ok(ai.size > 0);
    assert.ok(ai.owner.length > 0);

    const out = join(root, 'out');
    const unpacked = await settle(
      runner.start({ hostId: 'local', ...planExtract(tools, archive, out) }),
    );
    assert.equal(unpacked.status, 'done', unpacked.error);
    assert.equal(readFileSync(join(out, 'site', 'css', 'a.css'), 'utf8'), 'body{}');

    await applyPerms(exec, join(src, 'index.html'), { mode: 0o640 });
    assert.equal((await fileInfo(exec, join(src, 'index.html'))).modeText, '-rw-r-----');

    const deep = await fileInfo(exec, src, { deep: true });
    assert.equal(deep.kind, 'dir');
    assert.deepEqual([deep.dir?.files, deep.dir?.dirs], [2, 1]);
    assert.ok((deep.dir?.bytes ?? 0) > 0);

    const failed = await settle(
      runner.start({ hostId: 'local', ...planExtract(tools, join(root, 'missing.tar.gz'), out) }),
    );
    assert.equal(failed.status, 'error');
    assert.match(failed.error!, /^exit \d+/);
    conn.dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
    assert.ok(!existsSync(root));
  }
});
