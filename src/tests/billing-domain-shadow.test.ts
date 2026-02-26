import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BillingLegacySettlementSnapshot,
  compareSettlementSnapshots,
} from '../modules/billing/billing-domain.service';

test('billing shadow compare: matching snapshots have no mismatch', () => {
  const legacy: BillingLegacySettlementSnapshot = {
    callId: 'call_1',
    elapsedSeconds: 30,
    finalCoins: 120,
    finalEarnings: 9,
    totalDeducted: 30,
  };

  const shadow: BillingLegacySettlementSnapshot = {
    callId: 'call_1',
    elapsedSeconds: 30,
    finalCoins: 120,
    finalEarnings: 9,
    totalDeducted: 30,
  };

  const report = compareSettlementSnapshots(legacy, shadow, 12);
  assert.equal(report.mismatch, false);
  assert.equal(report.mismatchFields.length, 0);
});

test('billing shadow compare: detects mismatched fields', () => {
  const legacy: BillingLegacySettlementSnapshot = {
    callId: 'call_2',
    elapsedSeconds: 60,
    finalCoins: 40,
    finalEarnings: 18,
    totalDeducted: 60,
  };

  const shadow: BillingLegacySettlementSnapshot = {
    callId: 'call_2',
    elapsedSeconds: 59,
    finalCoins: 41,
    finalEarnings: 17.7,
    totalDeducted: 59,
  };

  const report = compareSettlementSnapshots(legacy, shadow, 20);
  assert.equal(report.mismatch, true);
  assert.ok(report.mismatchFields.includes('elapsedSeconds'));
  assert.ok(report.mismatchFields.includes('finalCoins'));
  assert.ok(report.mismatchFields.includes('totalDeducted'));
  assert.ok(report.mismatchFields.includes('finalEarnings'));
});

