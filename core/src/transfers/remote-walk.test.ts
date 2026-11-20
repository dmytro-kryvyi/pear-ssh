import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWalk, walkCommand } from './remote-walk';

test('walkCommand quotes the directory and every root', () => {
  assert.equal(
    walkCommand("/srv/it's", ['a b', '-x']),
    `cd -- '/srv/it'\\''s' && find './a b' './-x' \\( -type d -o -type f -o -type l \\) -exec stat -c '%f %s %Y %n' {} +`,
  );
});

const SAMPLE = [
  '41ed 4096 1700000000 ./tree',
  '81a4 5 1700000001 ./tree/a.txt',
  '41ed 4096 1700000000 ./tree/sub',
  '81ed 12 1700000002 ./tree/sub/run.sh',
  'a1ff 5 1700000003 ./tree/link',
  '81a4 4 1700000004 ./tree/.DS_Store',
  '41ed 4096 1700000000 ./tree/sub/__MACOSX',
  '81a4 4 1700000004 ./tree/sub/__MACOSX/._x',
  '81a4 9 1700000005 ./single file.txt',
  '',
].join('\n');

test('parseWalk splits dirs, files and links with sizes and mtimes', () => {
  const tree = parseWalk(SAMPLE, ['tree', 'single file.txt']);
  assert.ok(tree);
  assert.deepEqual(tree.dirs, ['tree', 'tree/sub', 'tree/sub/__MACOSX']);
  assert.deepEqual(
    tree.files.map((f) => [f.rel, f.size, f.mtimeMs, f.kind]),
    [
      ['tree/a.txt', 5, 1_700_000_001_000, 'file'],
      ['tree/sub/run.sh', 12, 1_700_000_002_000, 'file'],
      ['tree/link', 5, 1_700_000_003_000, 'link'],
      ['tree/.DS_Store', 4, 1_700_000_004_000, 'file'],
      ['tree/sub/__MACOSX/._x', 4, 1_700_000_004_000, 'file'],
      ['single file.txt', 9, 1_700_000_005_000, 'file'],
    ],
  );
});

test('parseWalk drops macOS metadata below the roots when asked', () => {
  const tree = parseWalk(SAMPLE, ['tree', 'single file.txt'], { skipMacMeta: true });
  assert.ok(tree);
  assert.deepEqual(tree.dirs, ['tree', 'tree/sub']);
  assert.deepEqual(
    tree.files.map((f) => f.rel),
    ['tree/a.txt', 'tree/sub/run.sh', 'tree/link', 'single file.txt'],
  );
  // A root that is itself metadata was picked on purpose and stays.
  const picked = parseWalk('81a4 4 1 ./.DS_Store\n', ['.DS_Store'], { skipMacMeta: true });
  assert.deepEqual(
    picked?.files.map((f) => f.rel),
    ['.DS_Store'],
  );
});

test('parseWalk refuses output it cannot trust', () => {
  assert.equal(parseWalk('', ['tree']), null, 'nothing came back');
  assert.equal(parseWalk('81a4 5 1 ./other\n', ['tree']), null, 'root missing');
  assert.equal(parseWalk('81a4 5 1 ./tree/a\nname\n', ['tree']), null, 'newline in a name');
  assert.equal(parseWalk('stat: illegal option -- c\n', ['tree']), null, 'BSD stat');
  assert.ok(parseWalk('81a4 5 1 ./tree\r\n', ['tree']), 'CRLF tolerated');
});
