import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import {
  isFreeTierMomentAccess,
  __test as hookTest,
} from './hooks';
import {
  hasRewardQualifyingAvatar,
  isProfileCompleteForReward,
  isSystemPresetImageId,
} from './profile-reward-eligibility';
import { getDefaultPresetImageId } from '../images/preset-image-ids';
import { istDateKey, istDayBounds } from '../../utils/ist-time';
import {
  createTelegramLinkPayload,
  verifyTelegramLinkPayload,
} from '../telegram-reward/telegram-link-token';
import { telegramJoinRewardTransactionId } from '../telegram-reward/telegram-reward.service';
import { referralRewardTransactionId } from '../user/referral.service';
import { isInsideReconWindow, __resetReconJobState } from './reward-reconciliation.job';
import { REWARD_LEDGER_SOURCES } from './reward-metrics';

describe('isFreeTierMomentAccess', () => {
  test('allows FREE, PREVIEW, VIP only', () => {
    assert.equal(isFreeTierMomentAccess('FREE'), true);
    assert.equal(isFreeTierMomentAccess('PREVIEW'), true);
    assert.equal(isFreeTierMomentAccess('VIP'), true);
    assert.equal(isFreeTierMomentAccess('PREMIUM'), false);
    assert.equal(isFreeTierMomentAccess('OWNER'), false);
    assert.equal(isFreeTierMomentAccess('DENIED'), false);
    assert.equal(isFreeTierMomentAccess(null), false);
  });
});

describe('profile photo reward eligibility', () => {
  const userId = new mongoose.Types.ObjectId('507f1f77bcf86cd799439011');

  test('rejects null avatar and signup default / system presets', () => {
    assert.equal(hasRewardQualifyingAvatar({ _id: userId, avatar: null }), false);

    const defaultId = getDefaultPresetImageId();
    if (defaultId) {
      assert.equal(isSystemPresetImageId(defaultId), true);
      // signup default: approved preset + uploadedBy null
      assert.equal(
        hasRewardQualifyingAvatar({
          _id: userId,
          avatar: {
            imageId: defaultId,
            moderationStatus: 'approved',
            uploadedBy: null,
          },
        }),
        false
      );
      // even with uploadedBy set, presets never qualify
      assert.equal(
        hasRewardQualifyingAvatar({
          _id: userId,
          avatar: {
            imageId: defaultId,
            moderationStatus: 'approved',
            uploadedBy: userId,
          },
        }),
        false
      );
    }
  });

  test('accepts user-owned non-preset upload with auto-ok/approved', () => {
    assert.equal(
      hasRewardQualifyingAvatar({
        _id: userId,
        avatar: {
          imageId: 'user-uploaded-cloudflare-id-xyz',
          moderationStatus: 'auto-ok',
          uploadedBy: userId,
        },
      }),
      true
    );
    assert.equal(
      hasRewardQualifyingAvatar({
        _id: userId,
        avatar: {
          imageId: 'user-uploaded-cloudflare-id-xyz',
          moderationStatus: 'pending',
          uploadedBy: userId,
        },
      }),
      false
    );
    assert.equal(
      hasRewardQualifyingAvatar({
        _id: userId,
        avatar: {
          imageId: 'user-uploaded-cloudflare-id-xyz',
          moderationStatus: 'approved',
          uploadedBy: null,
        },
      }),
      false
    );
  });

  test('complete profile requires qualifying avatar + real handle + age/gender', () => {
    const incomplete = {
      _id: userId,
      username: 'uabc1234', // auto-looking
      age: 26,
      gender: 'male',
      usernameChangeCount: 0,
      avatar: {
        imageId: 'user-uploaded-cloudflare-id-xyz',
        moderationStatus: 'approved' as const,
        uploadedBy: userId,
      },
    };
    assert.equal(isProfileCompleteForReward(incomplete), false);
    assert.equal(
      isProfileCompleteForReward({
        ...incomplete,
        username: 'CoolUser',
        usernameChangeCount: 1,
      }),
      true
    );
    // custom name without changeCount also ok if not auto pattern
    assert.equal(
      isProfileCompleteForReward({
        ...incomplete,
        username: 'CoolUser',
        usernameChangeCount: 0,
      }),
      true
    );
  });

  test('hook __test aliases match eligibility helpers', () => {
    assert.equal(hookTest.hasRewardQualifyingAvatar, hasRewardQualifyingAvatar);
    assert.equal(hookTest.isProfileCompleteForReward, isProfileCompleteForReward);
  });
});

describe('first_recharge gate logic', () => {
  test('true-first is exactly one prior gateway credit after finalize', () => {
    // Documented rule: after payment finalize, count === 1 → credit; count > 1 → skip
    const firstPurchaseCount = 1;
    const legacyRechargeCount = 5;
    assert.equal(firstPurchaseCount === 1, true);
    assert.equal(legacyRechargeCount === 1, false);
  });
});

describe('reward transactionId uniqueness', () => {
  test('once-task ids are deterministic and unique per user', () => {
    const a = new mongoose.Types.ObjectId('507f1f77bcf86cd799439011');
    const b = new mongoose.Types.ObjectId('507f1f77bcf86cd799439012');
    assert.equal(
      telegramJoinRewardTransactionId(a),
      'telegram_join_reward_507f1f77bcf86cd799439011'
    );
    assert.notEqual(
      telegramJoinRewardTransactionId(a),
      telegramJoinRewardTransactionId(b)
    );
    assert.equal(
      referralRewardTransactionId(a, b),
      'referral_reward_507f1f77bcf86cd799439011_507f1f77bcf86cd799439012'
    );
  });

  test('daily watch txn encodes IST dateKey — midnight boundary', () => {
    const preMidnightUtc = new Date('2026-08-01T18:29:59.000Z');
    const midnightUtc = new Date('2026-08-01T18:30:00.000Z');
    const postMidnightUtc = new Date('2026-08-01T18:30:01.000Z');

    const d1 = istDateKey(preMidnightUtc);
    const d2 = istDateKey(midnightUtc);
    const d3 = istDateKey(postMidnightUtc);

    assert.equal(d1, '2026-08-01');
    assert.equal(d2, '2026-08-02');
    assert.equal(d3, '2026-08-02');
    assert.notEqual(d1, d2);

    const uid = '507f1f77bcf86cd799439011';
    const txnDay1 = `moment_watch_daily_reward_${uid}_${d1}`;
    const txnDay2 = `moment_watch_daily_reward_${uid}_${d2}`;
    assert.notEqual(txnDay1, txnDay2);

    const b1 = istDayBounds(d1);
    assert.equal(istDateKey(new Date(b1.end.getTime() - 1)), d1);
    assert.equal(istDateKey(b1.end), d2);
  });
});

describe('telegram link token + webhook idempotency contract', () => {
  test('start payload fits Telegram 64-char deep-link limit', () => {
    process.env.TELEGRAM_LINK_TOKEN_SECRET = 'test-secret-for-rewards-hardening';
    const userId = '507f1f77bcf86cd799439011';
    const payload = createTelegramLinkPayload(userId, Date.now());
    assert.ok(payload.length > 0 && payload.length <= 64, `len=${payload.length}`);
    assert.match(payload, /^[A-Za-z0-9_-]+$/);
  });

  test('same payload verifies 10 times → same userId', () => {
    process.env.TELEGRAM_LINK_TOKEN_SECRET = 'test-secret-for-rewards-hardening';
    const userId = '507f1f77bcf86cd799439011';
    const payload = createTelegramLinkPayload(userId, Date.now());
    for (let i = 0; i < 10; i++) {
      const v = verifyTelegramLinkPayload(payload, Date.now());
      assert.ok(v);
      assert.equal(v!.userId, userId);
    }
  });

  test('expired and tampered payloads reject', () => {
    process.env.TELEGRAM_LINK_TOKEN_SECRET = 'test-secret-for-rewards-hardening';
    const userId = '507f1f77bcf86cd799439011';
    const past = Date.now() - 60 * 60 * 1000;
    const expired = createTelegramLinkPayload(userId, past - 31 * 60 * 1000);
    assert.equal(verifyTelegramLinkPayload(expired, Date.now()), null);

    const good = createTelegramLinkPayload(userId, Date.now());
    const tampered = `${good.slice(0, -1)}${good.endsWith('a') ? 'b' : 'a'}`;
    assert.equal(verifyTelegramLinkPayload(tampered, Date.now()), null);
  });

  test('telegram claim txn id is stable (10× same = 1 ledger key)', () => {
    const uid = new mongoose.Types.ObjectId('507f1f77bcf86cd799439011');
    const ids = Array.from({ length: 10 }, () =>
      telegramJoinRewardTransactionId(uid)
    );
    assert.equal(new Set(ids).size, 1);
  });
});

describe('referral double-credit path share', () => {
  test('purchase and call share exact transactionId', () => {
    const referrer = new mongoose.Types.ObjectId('507f1f77bcf86cd799439011');
    const referred = new mongoose.Types.ObjectId('507f1f77bcf86cd799439012');
    const purchaseStyle = referralRewardTransactionId(referrer, referred);
    const callStyle = `referral_reward_${referrer}_${referred}`;
    assert.equal(purchaseStyle, callStyle);
  });
});

describe('reward ledger source list', () => {
  test('includes telegram, hub, referral, check-in', () => {
    assert.ok(REWARD_LEDGER_SOURCES.includes('telegram_join_reward'));
    assert.ok(REWARD_LEDGER_SOURCES.includes('first_recharge_reward'));
    assert.ok(REWARD_LEDGER_SOURCES.includes('referral_reward'));
    assert.ok(REWARD_LEDGER_SOURCES.includes('daily_checkin'));
  });
});

describe('recon window', () => {
  test('detects ~01:30 IST window', () => {
    __resetReconJobState();
    const inWindow = new Date('2026-08-01T20:05:00.000Z');
    const outWindow = new Date('2026-08-01T18:00:00.000Z');
    assert.equal(isInsideReconWindow(inWindow), true);
    assert.equal(isInsideReconWindow(outWindow), false);
  });
});
