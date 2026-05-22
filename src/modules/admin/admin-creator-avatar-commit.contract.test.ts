import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';

test('admin routes register POST /creators/:id/avatar/commit', () => {
  const src = readFileSync(join(__dirname, 'admin.routes.ts'), 'utf8');
  assert.ok(src.includes("router.post('/creators/:id/avatar/commit', adminCreatorAvatarCommit)"));
  assert.ok(src.includes('adminCreatorAvatarCommit'));
});

test('adminCreatorAvatarCommit checks IMAGES_DISABLED before session validation', () => {
  const src = readFileSync(join(__dirname, 'admin.controller.ts'), 'utf8');
  const fnStart = src.indexOf('export const adminCreatorAvatarCommit');
  assert.ok(fnStart >= 0);
  const block = src.slice(fnStart, fnStart + 1200);
  const disabledIdx = block.indexOf('IMAGES_DISABLED');
  const sessionIdx = block.indexOf('sessionId is required');
  assert.ok(disabledIdx >= 0 && sessionIdx >= 0);
  assert.ok(disabledIdx < sessionIdx);
});
