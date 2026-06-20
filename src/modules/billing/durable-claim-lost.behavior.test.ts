import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDurableSettlingStale } from './call-session.service';
import { BILLING_MAX_SETTLING_MS } from './billing.constants';

test('isDurableSettlingStale uses finalizationStartedAt when present', () => {
  const now = Date.now();
  assert.equal(
    isDurableSettlingStale(
      { finalizationStartedAt: new Date(now - BILLING_MAX_SETTLING_MS - 1000), updatedAt: new Date(now) },
      now
    ),
    true
  );
  assert.equal(
    isDurableSettlingStale(
      { finalizationStartedAt: new Date(now - 1000), updatedAt: new Date(now) },
      now
    ),
    false
  );
});

test('claim settlement exposes claim_lost detail types', () => {
  const src = readFileSync(join(__dirname, 'call-session.service.ts'), 'utf8');
  assert.ok(src.includes("reason: 'claim_lost'; detail: ClaimLostDetail"));
  assert.ok(src.includes("'settling_active'"));
  assert.ok(src.includes("'settling_stale_race'"));
  assert.ok(src.includes('resolveClaimLostDetail'));
});

test('finalizer routes claim_lost through handleDurableClaimLost', () => {
  const src = readFileSync(join(__dirname, 'billing-session-finalization.service.ts'), 'utf8');
  assert.ok(src.includes('handleDurableClaimLost'));
  assert.ok(src.includes('billing_finalize_claim_lost_settling_active'));
  assert.ok(src.includes('billing_finalize_claim_lost_stale_race'));
  assert.ok(src.includes('attemptFailedSettlementRecovery'));
  assert.ok(src.includes('tryStaleDurableSettlingTakeover'));
});
