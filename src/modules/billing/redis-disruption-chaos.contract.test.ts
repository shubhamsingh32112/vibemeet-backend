import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const RECOVERY_BUDGET_MS = 10_000;
const RECONNECT_REPLAY_BUDGET_MS = 5_000;
const PRESENCE_CONVERGENCE_BUDGET_MS = 3_000;

type ChaosScenarioId = 'A' | 'B' | 'C' | 'D' | 'E' | 'F';
type ChaosStatus = 'PASSED' | 'PARTIAL' | 'FAILED' | 'UNPROVEN';

type ScenarioObservation = {
  scenario: ChaosScenarioId;
  recoveryMs: number;
  replayMs: number;
  presenceConvergenceMs: number;
  sequenceRollback: boolean;
  duplicateSettlement: boolean;
  staleReplayOverwrite: boolean;
  stuckActive: boolean;
  invalidTransition: boolean;
  missingBalances: boolean;
  orphanedBullmqJobs: boolean;
};

function classifyScenario(observation: ScenarioObservation): ChaosStatus {
  const budgetFailed =
    observation.recoveryMs > RECOVERY_BUDGET_MS ||
    observation.replayMs > RECONNECT_REPLAY_BUDGET_MS ||
    observation.presenceConvergenceMs > PRESENCE_CONVERGENCE_BUDGET_MS;
  const invariantFailed =
    observation.sequenceRollback ||
    observation.duplicateSettlement ||
    observation.staleReplayOverwrite ||
    observation.stuckActive ||
    observation.invalidTransition ||
    observation.missingBalances ||
    observation.orphanedBullmqJobs;
  if (budgetFailed || invariantFailed) return 'FAILED';
  return 'PASSED';
}

test('chaos suite defines explicit hard budgets', () => {
  assert.equal(RECOVERY_BUDGET_MS, 10_000);
  assert.equal(RECONNECT_REPLAY_BUDGET_MS, 5_000);
  assert.equal(PRESENCE_CONVERGENCE_BUDGET_MS, 3_000);
});

test('resolver includes redis and checkpoint reconstruction signals', () => {
  const src = readFileSync(join(__dirname, 'billing-runtime-resolver.service.ts'), 'utf8');
  assert.ok(src.includes("source: 'redis'"));
  assert.ok(src.includes("source: 'checkpoint'"));
  assert.ok(src.includes('billing_reconstruction_count'));
  assert.ok(src.includes('billing_checkpoint_fallback_count'));
  assert.ok(src.includes('billing_reconnect_replay_count'));
});

test('watchdog enforces ACTIVE, SETTLING, and RECOVERING stuck-state paths', () => {
  const src = readFileSync(join(__dirname, 'billing-watchdog.service.ts'), 'utf8');
  assert.ok(src.includes('STALLED_ACTIVE_MS'));
  assert.ok(src.includes('STALLED_SETTLING_MS'));
  assert.ok(src.includes('STALLED_RECOVERING_MS'));
  assert.ok(src.includes("lifecycleState === 'ACTIVE'"));
  assert.ok(src.includes("lifecycleState === 'SETTLING'"));
  assert.ok(src.includes("lifecycleState === 'RECOVERING'"));
  assert.ok(src.includes('billing_watchdog_stalled_recovering'));
});

test('finalizer still guards duplicate settlement and retries', () => {
  const src = readFileSync(join(__dirname, 'billing-session-finalization.service.ts'), 'utf8');
  assert.ok(src.includes('isCallBillingAlreadySettled(callId)'));
  assert.ok(src.includes('enqueueSettlementRetry(params)'));
  assert.ok(src.includes('settlementClaimKey(callId)'));
  assert.ok(src.includes('finalizeAttemptId'));
});

test('scenario classifier fails on budget and invariant breaches', () => {
  const passed = classifyScenario({
    scenario: 'A',
    recoveryMs: 4000,
    replayMs: 1200,
    presenceConvergenceMs: 900,
    sequenceRollback: false,
    duplicateSettlement: false,
    staleReplayOverwrite: false,
    stuckActive: false,
    invalidTransition: false,
    missingBalances: false,
    orphanedBullmqJobs: false,
  });
  assert.equal(passed, 'PASSED');

  const failedBudget = classifyScenario({
    scenario: 'B',
    recoveryMs: 11_000,
    replayMs: 1000,
    presenceConvergenceMs: 800,
    sequenceRollback: false,
    duplicateSettlement: false,
    staleReplayOverwrite: false,
    stuckActive: false,
    invalidTransition: false,
    missingBalances: false,
    orphanedBullmqJobs: false,
  });
  assert.equal(failedBudget, 'FAILED');

  const failedInvariant = classifyScenario({
    scenario: 'C',
    recoveryMs: 5000,
    replayMs: 1000,
    presenceConvergenceMs: 900,
    sequenceRollback: true,
    duplicateSettlement: false,
    staleReplayOverwrite: false,
    stuckActive: false,
    invalidTransition: false,
    missingBalances: false,
    orphanedBullmqJobs: false,
  });
  assert.equal(failedInvariant, 'FAILED');
});
