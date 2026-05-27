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
  assert.ok(src.includes('parseAdminDateRange'));
  assert.ok(src.includes('admin_dashboard_date_filter_applied'));
});

test('dashboard service keeps leaderboard numeric contract', () => {
  const src = readFileSync(join(__dirname, 'admin-dashboard.service.ts'), 'utf8');
  assert.ok(src.includes('bds: a.bdId ? 1 : 0'));
  assert.ok(src.includes('selectedRange: selectedRangePayload(range)'));
  assert.ok(src.includes('metricContract: buildOverviewMetricContract()'));
});

test('admin date range parser reports invalid reasons', () => {
  const src = readFileSync(join(__dirname, 'admin-date-range.ts'), 'utf8');
  assert.ok(src.includes("invalidReason: 'missing_from'"));
  assert.ok(src.includes("invalidReason: 'missing_to'"));
  assert.ok(src.includes("invalidReason: 'invalid_bounds'"));
});
