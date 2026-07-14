import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { rechargeInrFromRow } from './admin-dashboard.service';
import { istDateKey } from '../../utils/ist-time';

test('rechargeInrFromRow prefers priceInr over description', () => {
  assert.equal(
    rechargeInrFromRow({ priceInr: 99, description: 'Purchase 100 coins for ₹50' }),
    99
  );
});

test('rechargeInrFromRow parses INR from purchase description fallback', () => {
  assert.equal(rechargeInrFromRow({ description: 'Purchase 650 coins for ₹197' }), 197);
});

test('rechargeInrFromRow returns 0 when no INR source', () => {
  assert.equal(rechargeInrFromRow({ description: 'bonus' }), 0);
});

test('completed payment buckets by updatedAt IST not createdAt', () => {
  // Order created Jul 4 23:50 IST
  const createdAt = new Date('2026-07-04T18:20:00.000Z');
  // Payment completed Jul 5 00:10 IST
  const updatedAt = new Date('2026-07-04T18:40:00.000Z');
  assert.equal(istDateKey(createdAt), '2026-07-04');
  assert.equal(istDateKey(updatedAt), '2026-07-05');
});

test('admin dashboard service uses IST updatedAt for recharge series', () => {
  const src = readFileSync(join(__dirname, 'admin-dashboard.service.ts'), 'utf8');
  assert.ok(src.includes("updatedAt: { $gte: windowStart }"), 'series filters on updatedAt');
  assert.ok(src.includes('istDateKey(row.updatedAt)'), 'series buckets by IST updatedAt');
  assert.ok(src.includes('Asia/Kolkata'), 'uses IST timezone constant');
  assert.ok(!src.includes('dashboardRechargeDailySeries(90, range)'), 'recharge decoupled from header range');
});

test('admin routes expose recharge-transactions endpoint', () => {
  const src = readFileSync(join(__dirname, 'admin.routes.ts'), 'utf8');
  assert.ok(src.includes("router.get('/dashboard/recharge-transactions'"));
});

test('admin dashboard controller exports recharge transactions handler', () => {
  const src = readFileSync(join(__dirname, 'admin-dashboard.controller.ts'), 'utf8');
  assert.ok(src.includes('getDashboardRechargeTransactions'));
  assert.ok(src.includes('dashboardRechargeTransactionsForDay'));
});
