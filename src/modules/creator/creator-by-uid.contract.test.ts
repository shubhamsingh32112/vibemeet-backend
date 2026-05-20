import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('getCreatorByFirebaseUid serializes avatar for incoming-call lookup', () => {
  const src = readFileSync(join(__dirname, 'creator.controller.ts'), 'utf8');
  const start = src.indexOf('export const getCreatorByFirebaseUid');
  const end = src.indexOf('export const getCreatorById');
  assert.ok(start > 0 && end > start);
  const block = src.slice(start, end);
  assert.ok(block.includes('serializeCreatorImages(creator'));
  assert.ok(block.includes('avatar: images.avatar'));
});
