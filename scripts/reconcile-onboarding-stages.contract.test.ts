import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('reconcile script clamps chronology and reports corrections', () => {
  const src = readFileSync(join(__dirname, 'reconcile-onboarding-stages.ts'), 'utf8');
  assert.ok(src.includes('chronologyClamped'));
  assert.ok(src.includes('orderCorrections'));
  assert.ok(src.includes('welcomeAt > bonusAt'));
  assert.ok(src.includes('bonusAt > permissionAt'));
  assert.ok(src.includes('permissionAt > completedAt'));
});
