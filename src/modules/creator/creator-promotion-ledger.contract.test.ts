/**
 * Contract tests for creator promotion wallet-clear ledger behavior.
 * These tests verify deterministic id generation and that promotion entry points
 * wire the idempotent ledger helper.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { creatorPromotionWalletClearTransactionId } from './creator-starter.service';

test('creator promotion wallet-clear transaction id is deterministic', () => {
  assert.equal(
    creatorPromotionWalletClearTransactionId('abc123'),
    'creator_promotion_wallet_clear_abc123'
  );
});

test('starter service must not use fixed 30-coin bonus reversal', () => {
  const src = readFileSync(join(__dirname, 'creator-starter.service.ts'), 'utf8');
  assert.ok(
    !src.includes('CREATOR_PROMOTION_BONUS_REVERSAL_COINS'),
    'expected fixed bonus-reversal constant to be removed'
  );
  assert.ok(
    !src.includes('creator_promotion_bonus_reversal_'),
    'expected old bonus-reversal transaction id prefix to be removed'
  );
  assert.ok(
    src.includes('ensureCreatorPromotionWalletClearedEntry(user, session)'),
    'expected starter promote helper to clear wallet via ledger-balancing entry'
  );
});

test('admin promotion flow must call wallet-clear ledger helper', () => {
  const src = readFileSync(join(__dirname, '../user/user.controller.ts'), 'utf8');
  assert.ok(
    src.includes('ensureCreatorPromotionWalletClearedEntry(targetUser, session)'),
    'expected admin promote flow to write wallet-clear transaction entry'
  );
});

test('agency promotion flow must use starter promote (wallet clear)', () => {
  const src = readFileSync(join(__dirname, '../agency/agency-portal.controller.ts'), 'utf8');
  assert.ok(
    src.includes('promoteUserToCreatorWithStarterProfile(targetUser, {'),
    'expected agency approve flow to promote via starter profile helper'
  );
});

test('admin createCreator flow must call wallet-clear ledger helper', () => {
  const src = readFileSync(join(__dirname, 'creator.controller.ts'), 'utf8');
  assert.ok(
    src.includes('ensureCreatorPromotionWalletClearedEntry(targetUser, session)'),
    'expected admin createCreator flow to write wallet-clear transaction entry'
  );
});
