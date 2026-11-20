import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listModelsRequest, parseModelList } from './models';

test('listModelsRequest: one newline-terminated control_request', () => {
  const line = listModelsRequest('r1');
  assert.ok(line.endsWith('\n'));
  assert.deepEqual(JSON.parse(line), {
    type: 'control_request',
    request_id: 'r1',
    request: { subtype: 'list_models' },
  });
});

test('parseModelList: decodes the CLI reply, keeping disabled entries', () => {
  const reply = {
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: 'r1',
      response: {
        models: [
          {
            value: 'default',
            resolvedModel: 'claude-opus-5[1m]',
            displayName: 'Default (recommended)',
            description: 'Opus 5 with 1M context',
            supportsEffort: true,
          },
          { value: 'sonnet', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet' },
          {
            value: 'cc-update-required-1',
            displayName: 'Fable 5.1 (disabled)',
            description: 'Update to 2.1.255+ to use Fable 5.1',
            disabled: true,
          },
          { displayName: 'no value — skipped' },
        ],
      },
    },
  };
  assert.deepEqual(parseModelList(reply, 'r1'), [
    {
      value: 'default',
      displayName: 'Default (recommended)',
      description: 'Opus 5 with 1M context',
      resolvedModel: 'claude-opus-5[1m]',
    },
    { value: 'sonnet', displayName: 'Sonnet', resolvedModel: 'claude-sonnet-5' },
    {
      value: 'cc-update-required-1',
      displayName: 'Fable 5.1 (disabled)',
      description: 'Update to 2.1.255+ to use Fable 5.1',
      disabled: true,
    },
  ]);
});

test('parseModelList: other messages yield null, CLI errors throw', () => {
  assert.equal(parseModelList({ type: 'system', subtype: 'init' }, 'r1'), null);
  assert.equal(
    parseModelList({ type: 'control_response', response: { subtype: 'success', request_id: 'other' } }, 'r1'),
    null,
  );
  assert.throws(
    () =>
      parseModelList(
        {
          type: 'control_response',
          response: { subtype: 'error', request_id: 'r1', error: 'Unsupported control request subtype' },
        },
        'r1',
      ),
    /Unsupported/,
  );
});
