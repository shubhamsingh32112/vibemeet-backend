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
import {
  creatorReferralRewardTransactionId,
  creatorReferralStageTransactionId,
} from './creator-referral-reward.service';
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
const paymentFinalizeSrc = fs.readFileSync(
  path.join(__dirname, '../payment/payment-finalization.service.ts'),
  'utf8'
);
const vipFinalizeSrc = fs.readFileSync(
  path.join(__dirname, '../vip/vip-purchase-finalization.service.ts'),
  'utf8'
);
const momentsFinalizeSrc = fs.readFileSync(
  path.join(
    __dirname,
    '../moments-premium/moments-premium-purchase-finalization.service.ts'
  ),
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
  test('legacy and stage transaction ids are stable', () => {
    const a = new mongoose.Types.ObjectId();
    const b = new mongoose.Types.ObjectId();
    assert.equal(
      creatorReferralRewardTransactionId(a, b),
      `creator_referral_reward_${a}_${b}`
    );
    assert.equal(
      creatorReferralStageTransactionId('attach', a, b),
      `creator_referral_attach_${a}_${b}`
    );
    assert.equal(
      creatorReferralStageTransactionId('telegram', a, b),
      `creator_referral_telegram_${a}_${b}`
    );
    assert.equal(
      creatorReferralStageTransactionId('purchase', a, b),
      `creator_referral_purchase_${a}_${b}`
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
  });

  test('call-path successful_referral still requires referrer.role === user', () => {
    assert.match(
      callHookSrc,
      /tryCreditSuccessfulReferralOnCall[\s\S]*referrer\.role !== 'user'/
    );
  });

  test('video call no longer wires creator referral payout', () => {
    assert.doesNotMatch(callHookSrc, /onCreatorReferralCallSettled/);
  });

  test('attach pays on edge create; telegram and purchase stages exist', () => {
    assert.match(rewardServiceSrc, /tryCreditAttach/);
    assert.match(rewardServiceSrc, /tryCreditTelegram/);
    assert.match(rewardServiceSrc, /tryCreditPurchase/);
    assert.match(rewardServiceSrc, /createCreatorReferralEdgeAfterAttach/);
    assert.match(rewardServiceSrc, /source: 'creator_referral_attach_reward'/);
    assert.match(rewardServiceSrc, /source: 'creator_referral_telegram_reward'/);
    assert.match(rewardServiceSrc, /source: 'creator_referral_purchase_reward'/);
  });

  test('purchase finalize hooks call onCreatorReferralPurchase', () => {
    assert.match(paymentFinalizeSrc, /onCreatorReferralPurchase/);
    assert.match(vipFinalizeSrc, /onCreatorReferralPurchase/);
    assert.match(momentsFinalizeSrc, /onCreatorReferralPurchase/);
  });

  test('creator apply path creates CreatorReferralEdge', () => {
    assert.match(referralServiceSrc, /createCreatorReferralEdgeAfterAttach/);
    assert.match(referralServiceSrc, /CREATOR_DISABLED/);
  });

  test('admin creator-referral handlers require assertAdmin', () => {
    assert.match(controllerSrc, /assertAdmin/);
    assert.match(
      controllerSrc,
      /getCreatorReferralConfigAdmin[\s\S]*assertAdmin/
    );
    assert.match(
      controllerSrc,
      /updateCreatorReferralConfigAdmin[\s\S]*assertAdmin/
    );
    assert.match(controllerSrc, /listCreatorReferralsAdmin[\s\S]*assertAdmin/);
    assert.match(
      controllerSrc,
      /getCreatorReferralDetailAdmin[\s\S]*assertAdmin/
    );
  });

  test('late attach backfills purchase when user already qualified', () => {
    assert.match(
      rewardServiceSrc,
      /createCreatorReferralEdgeAfterAttach[\s\S]*referredUserHasQualifyingPurchase[\s\S]*tryCreditPurchase/
    );
  });

  test('reconcile fetches purchase unpaid separately from attach/telegram', () => {
    assert.match(
      rewardServiceSrc,
      /reconcileUnpaidCreatorReferrals[\s\S]*purchaseRewardedAt: null[\s\S]*sort\(\{ createdAt: 1 \}\)/
    );
  });
});
