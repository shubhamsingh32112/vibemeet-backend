import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('agent withdrawals endpoint exposes full payout details contract', () => {
  const src = readFileSync(join(__dirname, 'agency-portal.controller.ts'), 'utf8');
  assert.ok(src.includes('type AgentWithdrawalDetails = {'));
  assert.ok(src.includes('name: string | null;'));
  assert.ok(src.includes('number: string | null;'));
  assert.ok(src.includes('upi: string | null;'));
  assert.ok(src.includes('accountNumber: string | null;'));
  assert.ok(src.includes('ifsc: string | null;'));
});

test('agent withdrawals query uses bounded pagination and batched hydration', () => {
  const src = readFileSync(join(__dirname, 'agency-portal.controller.ts'), 'utf8');
  assert.ok(src.includes('Math.min(50, Math.max(1, parseInt(req.query.limit as string) || 50))'));
  assert.ok(src.includes('User.find({ _id: { $in: creatorUserIds } })'));
  assert.ok(src.includes('Creator.find({ userId: { $in: creatorUserIds } })'));
});

test('creator withdrawal processing requires super admin for non-staff payouts', () => {
  const src = readFileSync(join(__dirname, '../creator/withdrawal-processing.service.ts'), 'utf8');
  assert.ok(src.includes('Creator withdrawal actions require super admin'));
});

test('agency routes do not expose creator withdrawal mutation endpoints', () => {
  const routes = readFileSync(join(__dirname, 'agency.routes.ts'), 'utf8');
  assert.ok(routes.includes("router.get('/withdrawals', getAgencyWithdrawals)"));
  assert.ok(!routes.includes('/withdrawals/:id/approve'));
  assert.ok(!routes.includes('/withdrawals/:id/reject'));
  assert.ok(!routes.includes('/withdrawals/:id/mark-paid'));
});
