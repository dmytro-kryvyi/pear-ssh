import { test } from 'node:test';
import assert from 'node:assert/strict';
import { actionCommandText } from './orchestration';

test('actionCommandText: one line per provider, nothing executed', () => {
  assert.equal(
    actionCommandText({ type: 'container', id: 'abc', name: 'web', op: 'logs' }),
    "docker logs -f --tail 100 'web'",
  );
  assert.equal(
    actionCommandText({ type: 'container', id: 'abc', name: 'web', op: 'restart' }),
    "docker restart 'abc'",
  );
  assert.equal(
    actionCommandText({ type: 'service', name: 'api', op: 'scale', replicas: 3 }),
    "docker service scale 'api'=3",
  );
  assert.equal(
    actionCommandText({ type: 'guest', vmid: 101, guestType: 'lxc', op: 'console' }),
    'pct enter 101',
  );
});
