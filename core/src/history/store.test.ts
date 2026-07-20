import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HistoryStore,
  bestSuggestion,
  looksSensitive,
  normalizeCommand,
  rankSuggestions,
  type HistoryEntry,
  type HistoryStorage,
} from './store';

class MemoryStorage implements HistoryStorage {
  data: string | null = null;
  read(): string | null {
    return this.data;
  }
  write(data: string): void {
    this.data = data;
  }
}

function entry(command: string, over: Partial<HistoryEntry> = {}): HistoryEntry {
  return { command, hostIds: ['h1'], count: 1, lastUsed: 0, imported: false, ...over };
}

test('normalizeCommand trims and skips blanks', () => {
  assert.equal(normalizeCommand('ls -la\n'), 'ls -la');
  assert.equal(normalizeCommand('   '), null);
});

test('normalizeCommand honours the leading-space opt-out', () => {
  assert.equal(normalizeCommand(' secret-thing'), null);
});

test('commands that look like credentials are never stored', () => {
  assert.ok(looksSensitive('mysql -u root -phunter2'));
  assert.ok(looksSensitive('curl -H "x: y" --token abc123'));
  assert.ok(looksSensitive('export API_KEY=abc123'));
  assert.ok(!looksSensitive('docker compose up -d'));
});

test('record deduplicates and counts', () => {
  const store = new HistoryStore(new MemoryStorage());
  store.record('h1', 'docker ps');
  store.record('h1', 'docker ps');
  const list = store.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].count, 2);
  assert.equal(list[0].imported, false);
});

test('a command run on a second host is remembered for both', () => {
  const store = new HistoryStore(new MemoryStorage());
  store.record('h1', 'systemctl status nginx');
  store.record('h2', 'systemctl status nginx');
  const [only] = store.list();
  assert.deepEqual(only.hostIds, ['h2', 'h1']);
});

test('suggestions prefer the host you are on', () => {
  const entries = [
    entry('docker compose up -d', { hostIds: ['h2'], count: 9 }),
    entry('docker compose logs -f', { hostIds: ['h1'], count: 1 }),
  ];
  assert.equal(bestSuggestion(entries, 'docker ', 'h1'), 'docker compose logs -f');
  assert.equal(bestSuggestion(entries, 'docker ', 'h2'), 'docker compose up -d');
});

test('typed commands outrank imported ones at equal use', () => {
  const entries = [
    entry('git pull --rebase', { imported: true }),
    entry('git push origin main', { imported: false }),
  ];
  assert.equal(bestSuggestion(entries, 'git ', 'h1'), 'git push origin main');
});

test('a prefix equal to the whole command suggests nothing', () => {
  assert.equal(bestSuggestion([entry('ls')], 'ls', 'h1'), undefined);
});

test('an empty prefix suggests nothing', () => {
  assert.deepEqual(rankSuggestions([entry('ls -la')], '', 'h1'), []);
});

test('importCommands reports only newly seen commands', () => {
  const store = new HistoryStore(new MemoryStorage());
  store.record('h1', 'htop');
  assert.equal(store.importCommands('h1', ['htop', 'btop', ' skipped']), 1);
  assert.deepEqual(
    store.list().map((e) => e.command).sort(),
    ['btop', 'htop'],
  );
});

test('importing a command already typed keeps it marked as typed', () => {
  const store = new HistoryStore(new MemoryStorage());
  store.record('h1', 'make build');
  store.importCommands('h1', ['make build']);
  assert.equal(store.list()[0].imported, false);
});

test('history survives a reload through storage', () => {
  const storage = new MemoryStorage();
  new HistoryStore(storage).record('h1', 'uptime');
  assert.equal(new HistoryStore(storage).suggest('up', 'h1'), 'uptime');
});

test('corrupt storage falls back to empty history', () => {
  const storage = new MemoryStorage();
  storage.data = 'not json';
  assert.deepEqual(new HistoryStore(storage).list(), []);
});

test('clear(hostId) drops only that host, keeping shared commands', () => {
  const store = new HistoryStore(new MemoryStorage());
  store.record('h1', 'only-here');
  store.record('h1', 'shared');
  store.record('h2', 'shared');
  store.clear('h1');
  assert.deepEqual(
    store.list().map((e) => e.command),
    ['shared'],
  );
  assert.deepEqual(store.list()[0].hostIds, ['h2']);
});
