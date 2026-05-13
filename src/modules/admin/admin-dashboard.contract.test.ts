/**
 * Contract tests for admin dashboard BFF routes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

test('admin routes expose dashboard BFF endpoints', () => {
  const src = readFileSync(join(__dirname, 'admin.routes.ts'), 'utf8');
  assert.ok(src.includes("router.get('/dashboard/overview'"), 'overview route');
  assert.ok(src.includes("router.get('/dashboard/revenue'"), 'revenue route');
  assert.ok(src.includes("router.get('/dashboard/live-calls'"), 'live-calls route');
  assert.ok(src.includes("router.get('/dashboard/geo'"), 'geo route');
});

test('admin-dashboard.controller exports handlers', () => {
  const src = readFileSync(join(__dirname, 'admin-dashboard.controller.ts'), 'utf8');
  assert.ok(src.includes('getDashboardOverview'));
  assert.ok(src.includes('assertAdmin'));
});
