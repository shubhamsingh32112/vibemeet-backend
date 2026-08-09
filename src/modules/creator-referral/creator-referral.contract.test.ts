import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import mongoose from 'mongoose';
import {
  generateCreatorReferralCode,
  isCreatorReferralCodeFormat,
  isValidReferralCodeFormat,
  normalizeReferralCode,
} from '../../utils/referral-code';
import { creatorReferralRewardTransactionId } from './creator-referral-reward.service';
import { CREATOR_REFERRAL_COINS_MAX } from './creator-referral.config';

const referralServiceSrc = fs.readFileSync(
  path.join(__dirname, '../user/referral.service.ts'),
  'utf8'
);
const callHookSrc = fs.readFileSync(
  path.join(__dirname, '../consumer-rewards/hooks.ts'),
  'utf8'
);
const rewardServiceSrc = fs.readFileSync(
  path.join(__dirname, 'creator-referral-reward.service.ts'),
  'utf8'
);
const controllerSrc = fs.readFileSync(
  path.join(__dirname, 'creator-referral.controller.ts'),
  'utf8'
);

describe('creator referral code format', () => {
  test('accepts CR- + 6 alphanumeric', () => {
    assert.equal(isValidReferralCodeFormat('CR-A7K2M9'), true);
    assert.equal(isCreatorReferralCodeFormat('cr-a7k2m9'), true);
    assert.equal(isCreatorReferralCodeFormat('CR-A7K2M9'), true);
  });

  test('still accepts legacy consumer formats', () => {
    assert.equal(isValidReferralCodeFormat('JO4832'), true);
    assert.equal(isValidReferralCodeFormat('JOE48392'), true);
  });

  test('rejects malformed creator codes', () => {
    assert.equal(isValidReferralCodeFormat('CR-SHORT'), false);
    assert.equal(isValidReferralCodeFormat('CR-TOOLONG1'), false);
    assert.equal(isValidReferralCodeFormat('XX-A7K2M9'), false);
    assert.equal(isCreatorReferralCodeFormat('JOE48392'), false);
  });

  test('generateCreatorReferralCode always matches format', () => {
    for (let i = 0; i < 20; i++) {
      const code = generateCreatorReferralCode();
      assert.equal(isCreatorReferralCodeFormat(code), true);
      assert.equal(normalizeReferralCode(code), code);
    }
  });
});

describe('creator referral reward helpers', () => {
  test('transaction id is stable and unique per pair', () => {
    const a = new mongoose.Types.ObjectId();
    const b = new mongoose.Types.ObjectId();
    const id1 = creatorReferralRewardTransactionId(a, b);
    const id2 = creatorReferralRewardTransactionId(a, b);
    assert.equal(id1, id2);
    assert.match(id1, /^creator_referral_reward_/);
    assert.notEqual(
      creatorReferralRewardTransactionId(a, b),
      creatorReferralRewardTransactionId(b, a)
    );
  });

  test('coins max is sane', () => {
    assert.equal(CREATOR_REFERRAL_COINS_MAX, 10000);
  });
});

describe('creator referral payout / apply contracts', () => {
  test('purchase successful_referral skips non-user referrers (no double-pay to creators)', () => {
    assert.match(
      referralServiceSrc,
      /processReferralRewardOnPurchase[\s\S]*referrerRoleDoc\.role !== 'user'/
    );
    assert.match(
      referralServiceSrc,
      /Creator affiliate payouts use CreatorReferralEdge/
    );
  });

  test('call-path successful_referral still requires referrer.role === user', () => {
    assert.match(
      callHookSrc,
      /tryCreditSuccessfulReferralOnCall[\s\S]*referrer\.role !== 'user'/
    );
  });

  test('creator apply path creates CreatorReferralEdge and skips invite_friend for creators', () => {
    assert.match(referralServiceSrc, /createCreatorReferralEdgeAfterAttach/);
    assert.match(referralServiceSrc, /isCreatorAffiliate/);
    assert.match(referralServiceSrc, /CREATOR_DISABLED/);
    // invite_friend only when referrer.role === 'user'
    assert.match(
      referralServiceSrc,
      /if \(referrer\.role === 'user' && applicant\.role === 'user'\)/
    );
  });

  test('tryCredit uses dedicated ledger source and CAS rewardedAt', () => {
    assert.match(rewardServiceSrc, /source: 'creator_referral_reward'/);
    assert.match(rewardServiceSrc, /creatorRewardedAt: null/);
    assert.match(rewardServiceSrc, /telegramJoinedAt: \{ \$ne: null \}/);
    assert.match(rewardServiceSrc, /videoCallCompletedAt: \{ \$ne: null \}/);
  });

  test('config save reconciles unpaid when enabled', () => {
    assert.match(controllerSrc, /reconcileUnpaidCreatorReferrals/);
  });

  test('preview/apply allow role===creator (not CREATOR_CANNOT_REFER for hosts)', () => {
    assert.match(referralServiceSrc, /role === 'creator'/);
    assert.match(referralServiceSrc, /creatorDisplayName/);
  });
});
