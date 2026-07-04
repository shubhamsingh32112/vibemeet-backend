import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeSettlementIssue,
  requiresUserWalletDebitTxn,
} from './admin-call-settlement.service';

const emptyTotals = {
  totalDeductedMicros: 0,
  totalEarnedMicros: 0,
  billingSequence: 0,
  source: 'none' as const,
};

test('requiresUserWalletDebitTxn treats intro-only legacy calls as settled without user debit', () => {
  assert.equal(
    requiresUserWalletDebitTxn({ coinsDeducted: 30, walletCoinsDeducted: undefined }, true),
    false,
  );
});

test('requiresUserWalletDebitTxn flags wallet-billed calls without persisted wallet split', () => {
  assert.equal(
    requiresUserWalletDebitTxn({ coinsDeducted: 30, walletCoinsDeducted: undefined }, false),
    true,
  );
});

test('requiresUserWalletDebitTxn uses walletCoinsDeducted when present', () => {
  assert.equal(requiresUserWalletDebitTxn({ coinsDeducted: 30, walletCoinsDeducted: 0 }, false), false);
  assert.equal(requiresUserWalletDebitTxn({ coinsDeducted: 30, walletCoinsDeducted: 12 }, false), true);
});

test('computeSettlementIssue skips unsettled_ledger for intro-only welcome calls', () => {
  assert.equal(
    computeSettlementIssue(
      { durationSeconds: 29, coinsDeducted: 30, walletCoinsDeducted: 0 },
      { ...emptyTotals, totalDeductedMicros: 30_000_000, billingSequence: 29, source: 'ledger' },
      'settled',
      false,
      true,
    ),
    null,
  );
});

test('computeSettlementIssue flags missing wallet debit when wallet coins were charged', () => {
  assert.equal(
    computeSettlementIssue(
      { durationSeconds: 29, coinsDeducted: 30, walletCoinsDeducted: 30 },
      { ...emptyTotals, totalDeductedMicros: 30_000_000, billingSequence: 29, source: 'ledger' },
      'settled',
      false,
      true,
    ),
    'unsettled_ledger',
  );
});

test('computeSettlementIssue flags legacy wallet calls with no ledger txns at all', () => {
  assert.equal(
    computeSettlementIssue(
      { durationSeconds: 29, coinsDeducted: 30 },
      { ...emptyTotals, totalDeductedMicros: 30_000_000, billingSequence: 29, source: 'ledger' },
      'settled',
      false,
      false,
    ),
    'unsettled_ledger',
  );
});
