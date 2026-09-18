import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApiClient, channelsOf } from './channels';

test('wire channels are unique within and across kinds', () => {
  const all = [...channelsOf('invoke'), ...channelsOf('send'), ...channelsOf('event')];
  assert.equal(new Set(all).size, all.length);
});

test('the irregular legacy names survive (the preload hard-codes them)', () => {
  assert.ok(channelsOf('invoke').includes('hostgroups:list'));
  assert.ok(channelsOf('invoke').includes('history:import'));
  assert.ok(channelsOf('send').includes('claude:chatAutoApprove'));
  assert.ok(channelsOf('send').includes('claude:uiResponse'));
  assert.ok(channelsOf('event').includes('transfer:update'));
  assert.ok(channelsOf('event').includes('host:disconnected'));
});

test('buildApiClient routes each member by its row', async () => {
  const log: string[] = [];
  const subs = new Map<string, (...a: never[]) => void>();
  const api = buildApiClient(
    {
      invoke: async (ch, args) => (log.push(`invoke ${ch} ${JSON.stringify(args)}`), 'ok'),
      send: (ch, args) => void log.push(`send ${ch} ${JSON.stringify(args)}`),
      subscribe: (ev, cb) => {
        subs.set(ev, cb);
        return () => subs.delete(ev);
      },
    },
    { 'transfers.pathForFile': () => '/local/path' },
  );

  assert.equal(await api.hostGroups.setMembership('h', 'g', true), 'ok');
  api.term.write('t1', 'ls\n');
  const off = api.onHostDisconnected(() => {});
  assert.deepEqual(log, [
    'invoke hostgroups:setMembership ["h","g",true]',
    'send term:write ["t1","ls\\n"]',
  ]);
  assert.ok(subs.has('host:disconnected'));
  off();
  assert.ok(!subs.has('host:disconnected'));
  assert.equal(api.transfers.pathForFile({}), '/local/path');
});

test('a local member without an implementation throws when called', () => {
  const api = buildApiClient({
    invoke: async () => null,
    send: () => {},
    subscribe: () => () => {},
  });
  assert.throws(() => api.transfers.pathForFile({}), /not available/);
});
