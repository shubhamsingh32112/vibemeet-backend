/**
 * Contract tests for creator promotion bonus-reversal ledger behavior.
 * These tests verify deterministic id generation and that promotion entry points
 * wire the idempotent ledger helper.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CREATOR_PROMOTION_BONUS_REVERSAL_COINS,
  creatorPromotionBonusReversalTransactionId,
} from './creator-starter.service';

test('creator promotion bonus reversal amount is fixed to 30', () => {
  assert.equal(CREATOR_PROMOTION_BONUS_REVERSAL_COINS, 30);
});

test('creator promotion bonus reversal transaction id is deterministic', () => {
  assert.equal(
    creatorPromotionBonusReversalTransactionId('abc123'),
    'creator_promotion_bonus_reversal_abc123'
  );
});

test('admin promotion flow must call bonus reversal ledger helper', () => {
  const src = readFileSync(join(__dirname, '../user/user.controller.ts'), 'utf8');
  assert.ok(
    src.includes('ensureCreatorPromotionBonusReversalEntry(targetUser, session)'),
    'expected admin promote flow to write bonus reversal transaction entry'
  );
});

test('agency promotion flow must call bonus reversal ledger helper', () => {
  const src = readFileSync(join(__dirname, '../agency/agency-portal.controller.ts'), 'utf8');
  assert.ok(
    src.includes('ensureCreatorPromotionBonusReversalEntry(targetUser, session)'),
    'expected agency create-creator flow to write bonus reversal transaction entry'
  );
});

test('admin createCreator flow must call bonus reversal ledger helper', () => {
  const src = readFileSync(join(__dirname, 'creator.controller.ts'), 'utf8');
  assert.ok(
    src.includes('ensureCreatorPromotionBonusReversalEntry(targetUser, session)'),
    'expected admin createCreator flow to write bonus reversal transaction entry'
  );
});

