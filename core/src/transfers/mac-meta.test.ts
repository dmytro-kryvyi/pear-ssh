import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isMacMeta } from './mac-meta';

test('isMacMeta recognises Finder and AppleDouble leftovers only', () => {
  assert.equal(isMacMeta('__MACOSX', 'dir'), true);
  assert.equal(isMacMeta('__MACOSX', 'file'), false);
  assert.equal(isMacMeta('.DS_Store', 'file'), true);
  assert.equal(isMacMeta('._photo.jpg', 'file'), true);
  assert.equal(isMacMeta('._photo.jpg', 'link'), true);
  assert.equal(isMacMeta('_config.yml', 'file'), false);
  assert.equal(isMacMeta('.gitignore', 'file'), false);
  assert.equal(isMacMeta('.DS_Store', 'dir'), false);
});
