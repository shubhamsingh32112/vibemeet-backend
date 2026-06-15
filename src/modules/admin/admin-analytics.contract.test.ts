import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { periodToRange } from './admin-analytics.service';

test('periodToRange today is single UTC day', () => {
  const { from, to } = periodToRange('today');
  assert.ok(from <= to);
  const hours = (to.getTime() - from.getTime()) / 3600000;
  assert.ok(hours < 24.1);
});

test('admin routes register analytics BFF endpoints', () => {
  const routes = fs.readFileSync(
    path.join(__dirname, 'admin.routes.ts'),
    'utf8'
  );
  assert.ok(routes.includes('/analytics/users/summary'));
  assert.ok(routes.includes('/analytics/users/login-series'));
  assert.ok(routes.includes('/analytics/revenue/summary'));
  assert.ok(routes.includes('/wallet/transactions'));
});

test('call history model includes lifecycle timestamp fields', () => {
  const model = fs.readFileSync(
    path.join(__dirname, '../billing/call-history.model.ts'),
    'utf8'
  );
  assert.ok(model.includes('callStartedAt'));
  assert.ok(model.includes('callEndedAt'));
  assert.ok(model.includes('settledAt'));
});

test('getCallsAdmin exposes call lifecycle fields', () => {
  const ctrl = fs.readFileSync(path.join(__dirname, 'admin.controller.ts'), 'utf8');
  assert.ok(ctrl.includes('callStartedAt'));
  assert.ok(ctrl.includes('callEndedAt'));
  assert.ok(ctrl.includes('billingStatus'));
});

test('creators performance uses batch presence', () => {
  const ctrl = fs.readFileSync(path.join(__dirname, 'admin.controller.ts'), 'utf8');
  assert.ok(ctrl.includes('getBatchCreatorPresence'));
  assert.ok(ctrl.includes('presenceStatus'));
});
