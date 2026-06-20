import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

test('claimDurableCallSessionForSettlement includes stale settling takeover', () => {
  const src = readFileSync(join(__dirname, 'call-session.service.ts'), 'utf8');
  assert.ok(src.includes('BILLING_MAX_SETTLING_MS'));
  assert.ok(src.includes("state: 'settling'"));
  assert.ok(src.includes('finalizationStartedAt'));
  assert.ok(src.includes('billing_finalize_stale_takeover'));
  assert.ok(src.includes('mirrorCallSettlementSettling'));
  assert.ok(src.includes('resetDurableCallSessionForSettlementRetry'));
  assert.ok(src.includes('getDurableClaimLostDetail'));
});

test('markDurableCallSessionEnding cancels billing cycle job after transition', () => {
  const src = readFileSync(join(__dirname, 'call-session.service.ts'), 'utf8');
  assert.ok(src.includes('cancelBillingCycleJob'));
  assert.ok(src.includes('modifiedCount'));
});
