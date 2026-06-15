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
  assert.ok(src.includes('dashboardWalletFlowSeries'));
  assert.ok(src.includes('revenueDailyBalance'));
  assert.ok(src.includes('creditCoins: credit'));
});

test('dashboardTopHosts does not use unbounded Creator.find({})', () => {
  const src = readFileSync(join(__dirname, 'admin-dashboard.service.ts'), 'utf8');
  const start = src.indexOf('export async function dashboardTopHosts');
  const end = src.indexOf('export async function dashboardTopBds');
  assert.ok(start > 0 && end > start);
  const block = src.slice(start, end);
  assert.ok(!block.includes('Creator.find({})'));
  assert.ok(block.includes('aggregateCreatorPerformanceInRange'));
});

test('admin date range parser reports invalid reasons', () => {
  const src = readFileSync(join(__dirname, 'admin-date-range.ts'), 'utf8');
  assert.ok(src.includes("invalidReason: 'missing_from'"));
  assert.ok(src.includes("invalidReason: 'missing_to'"));
  assert.ok(src.includes("invalidReason: 'invalid_bounds'"));
});

test('creators performance uses Redis batch presence', () => {
  const src = readFileSync(join(__dirname, 'admin.controller.ts'), 'utf8');
  const start = src.indexOf('async function computeCreatorsPerformance');
  const end = src.indexOf('// GET /admin/users/analytics');
  assert.ok(start > 0 && end > start);
  const block = src.slice(start, end);
  assert.ok(block.includes('getBatchCreatorPresence'));
  assert.ok(block.includes('presenceStatus'));
});

test('computeCreatorsPerformance does not use unbounded CallHistory.find for abuse refunds', () => {
  const src = readFileSync(join(__dirname, 'admin.controller.ts'), 'utf8');
  const start = src.indexOf('async function computeCreatorsPerformance');
  const end = src.indexOf('// GET /admin/users/analytics');
  assert.ok(start > 0 && end > start);
  const block = src.slice(start, end);
  assert.ok(!block.includes('CallHistory.find({'));
  assert.ok(block.includes('REFUND_LOOKUP_BATCH'));
  assert.ok(block.includes('$addToSet: \'$callId\''));
});
