import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('publish flow uses transaction and idempotency safeguards', () => {
  const src = readFileSync(join(__dirname, 'app-update.controller.ts'), 'utf8');
  assert.ok(src.includes('session.withTransaction'));
  assert.ok(src.includes('reservePublishIdempotency'));
  assert.ok(src.includes('x-idempotency-key'));
});

test('active update cache is used by pending endpoint', () => {
  const src = readFileSync(join(__dirname, 'app-update.controller.ts'), 'utf8');
  assert.ok(src.includes('getActiveUpdateCached'));
  assert.ok(src.includes('cacheHit'));
});

test('model enforces single active update index', () => {
  const src = readFileSync(join(__dirname, 'app-update.model.ts'), 'utf8');
  assert.ok(src.includes('partialFilterExpression: { isActive: true }'));
  assert.ok(src.includes('uniq_single_active_global_app_update'));
});
