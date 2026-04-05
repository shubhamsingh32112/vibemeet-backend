/**
 * Referral Service
 *
 * Handles:
 * - Generating unique referral codes for new users
 * - Applying referral code (signup + one-time late attach)
 * - Creator promotion when referrer is a creator; agent pending applications
 * - Atomic reward when referred user buys coins (≥ min INR)
 */

import mongoose, { Types } from 'mongoose';
import { User, IUser } from './user.model';
import { Creator } from '../creator/creator.model';
import { CreatorApplication } from '../agent/creator-application.model';
import { promoteUserToCreatorWithStarterProfile } from '../creator/creator-starter.service';
import { CoinTransaction } from './coin-transaction.model';
import { ReferralEdge } from './referral-edge.model';
import { getIO } from '../../config/socket';
import {
  generateUniqueReferralCode,
  isValidReferralCodeFormat,
  normalizeReferralCode,
} from '../../utils/referral-code';
import { logInfo, logDebug, logError } from '../../utils/logger';
import {
  getReferralAttachWindowMs,
  getReferralMinPurchaseInr,
  getReferralRewardCoins,
} from './referral-config';

export {
  getReferralAttachWindowMs,
  getReferralMinPurchaseInr,
  getReferralRewardCoins,
} from './referral-config';

/** Backwards-compatible defaults (runtime values use getReferral*()) */
export const REFERRAL_REWARD_COINS = 60;
export const REFERRAL_MIN_PURCHASE_INR = 100;

export type ApplyReferralCodeMode = 'signup' | 'late_attach';

export type ApplyReferralCodeErrorCode =
  | 'INVALID_FORMAT'
  | 'NOT_FOUND'
  | 'SELF'
  | 'AGENT_DISABLED'
  | 'ALREADY_REFERRED'
  | 'WINDOW_EXPIRED'
  | 'PURCHASE_ALREADY'
  | 'NOT_ELIGIBLE_ROLE';

export type ApplyReferralCodeResult =
  | { ok: true }
  | { ok: false; code: ApplyReferralCodeErrorCode };

function isDuplicateKeyError(err: unknown): boolean {
  return Boolean(
    err &&
      typeof err === 'object' &&
      'code' in err &&
      (err as { code?: number }).code === 11000
  );
}

export function referralRewardTransactionId(
  referrerId: Types.ObjectId,
  referredUserId: Types.ObjectId
): string {
  return `referral_reward_${referrerId.toString()}_${referredUserId.toString()}`;
}

async function userHasCompletedCoinPurchase(userId: Types.ObjectId): Promise<boolean> {
  const row = await CoinTransaction.findOne({
    userId,
    source: 'payment_gateway',
    status: 'completed',
  })
    .select('_id')
    .lean();
  return !!row;
}

/**
 * Legacy / backfill: ensure ReferralEdge exists when User.referredBy is set.
 */
export async function ensureReferralEdgeForReferredUser(
  referredUserId: Types.ObjectId
): Promise<void> {
  const existing = await ReferralEdge.findOne({ referredUserId }).lean();
  if (existing) {
    const referrer = await User.findById(existing.referrerId).select('referrals').lean();
    const entry = referrer?.referrals?.find((r) =>
      (r.user as Types.ObjectId).equals(referredUserId)
    );
    if (entry?.rewardGranted && !existing.rewardGranted) {
      await ReferralEdge.updateOne({ _id: existing._id }, { $set: { rewardGranted: true } });
    }
    return;
  }

  const u = await User.findById(referredUserId).select('referredBy').lean();
  if (!u?.referredBy) return;

  const referrer = await User.findById(u.referredBy).select('referrals referralCode').lean();
  if (!referrer) return;

  const inList = referrer.referrals?.some((r) =>
    (r.user as Types.ObjectId).equals(referredUserId)
  );
  if (!inList) return;

  const entry = referrer.referrals!.find((r) =>
    (r.user as Types.ObjectId).equals(referredUserId)
  );

  try {
    await ReferralEdge.create({
      referrerId: u.referredBy,
      referredUserId,
      referralCodeUsed: referrer.referralCode ?? 'LEGACY',
      rewardGranted: entry?.rewardGranted ?? false,
    });
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
  }
}

/**
 * Get display name for referral code prefix (username, email local part, or 'User').
 */
function getDisplayNameForCode(user: {
  username?: string | null;
  email?: string | null;
  phone?: string | null;
}): string | null {
  if (user.username && user.username.trim().length >= 2) return user.username;
  if (user.email) {
    const local = user.email.split('@')[0];
    if (local && local.replace(/[^a-zA-Z]/g, '').length >= 2) return local;
  }
  return null;
}

/**
 * Generate and assign a unique referral code to a new user.
 * Call this when creating a User (login or fast-login).
 */
export async function assignReferralCodeToUser(user: IUser): Promise<string> {
  if (user.referralCode) return user.referralCode;

  const name = getDisplayNameForCode(user);
  const code = await generateUniqueReferralCode(name, async (c) => {
    const hit = await User.findOne({ referralCode: c });
    return !!hit;
  });

  user.referralCode = code;
  await user.save();
  logDebug('Referral code assigned', { userId: user._id.toString(), referralCode: code });
  return code;
}

/**
 * Apply referral code (signup on first login, or one-time late attach via API).
 */
export async function applyReferralCode(
  applicant: IUser,
  referralCodeRaw: string | null | undefined,
  options?: { mode?: ApplyReferralCodeMode }
): Promise<ApplyReferralCodeResult> {
  const mode: ApplyReferralCodeMode = options?.mode ?? 'signup';

  if (!referralCodeRaw || !isValidReferralCodeFormat(referralCodeRaw)) {
    return { ok: false, code: 'INVALID_FORMAT' };
  }

  if (applicant.referredBy) {
    return { ok: false, code: 'ALREADY_REFERRED' };
  }

  if (mode === 'late_attach') {
    if (applicant.role !== 'user') {
      return { ok: false, code: 'NOT_ELIGIBLE_ROLE' };
    }
    const creatorProf = await Creator.findOne({ userId: applicant._id }).select('_id').lean();
    if (creatorProf) {
      return { ok: false, code: 'NOT_ELIGIBLE_ROLE' };
    }
    const createdAt = applicant.createdAt ? new Date(applicant.createdAt).getTime() : 0;
    if (Date.now() - createdAt > getReferralAttachWindowMs()) {
      return { ok: false, code: 'WINDOW_EXPIRED' };
    }
    if (await userHasCompletedCoinPurchase(applicant._id)) {
      return { ok: false, code: 'PURCHASE_ALREADY' };
    }
  }

  const code = normalizeReferralCode(referralCodeRaw);
  const referrer = await User.findOne({ referralCode: code });
  if (!referrer) {
    return { ok: false, code: 'NOT_FOUND' };
  }

  if (referrer._id.equals(applicant._id)) {
    return { ok: false, code: 'SELF' };
  }

  if (referrer.role === 'agent' && referrer.agentDisabled) {
    logInfo('Referral skipped: agent account disabled', {
      code,
      referrerId: referrer._id.toString(),
    });
    return { ok: false, code: 'AGENT_DISABLED' };
  }

  const claimed = await User.findOneAndUpdate(
    { _id: applicant._id, referredBy: null },
    { $set: { referredBy: referrer._id } },
    { new: true }
  );
  if (!claimed) {
    return { ok: false, code: 'ALREADY_REFERRED' };
  }

  await User.updateOne(
    { _id: referrer._id },
    {
      $push: {
        referrals: {
          user: applicant._id,
          rewardGranted: false,
          createdAt: new Date(),
        },
      },
    }
  );

  try {
    await ReferralEdge.create({
      referrerId: referrer._id,
      referredUserId: applicant._id,
      referralCodeUsed: code,
      rewardGranted: false,
    });
  } catch (err) {
    if (isDuplicateKeyError(err)) {
      await User.updateOne({ _id: applicant._id }, { $unset: { referredBy: 1 } });
      await User.updateOne({ _id: referrer._id }, { $pull: { referrals: { user: applicant._id } } });
      return { ok: false, code: 'ALREADY_REFERRED' };
    }
    throw err;
  }

  logInfo('Referral applied', {
    newUserId: applicant._id.toString(),
    referrerId: referrer._id.toString(),
    referralCode: code,
    mode,
  });

  if (referrer.role === 'agent') {
    const existingPending = await CreatorApplication.findOne({
      applicantUserId: applicant._id,
      status: 'pending',
    })
      .select('_id')
      .lean();
    if (!existingPending) {
      await CreatorApplication.create({
        applicantUserId: applicant._id,
        agentUserId: referrer._id,
        referralCodeUsed: code,
        status: 'pending',
      });
    }
    logInfo('Agent referral: creator application pending', {
      newUserId: applicant._id.toString(),
      agentUserId: referrer._id.toString(),
    });
    return { ok: true };
  }

  const creatorProfile = await Creator.findOne({ userId: referrer._id });
  if (creatorProfile) {
    const existingCreatorForApplicant = await Creator.findOne({ userId: applicant._id });
    if (existingCreatorForApplicant) {
      logInfo('Creator referral skipped: applicant already has creator profile', {
        newUserId: applicant._id.toString(),
      });
      return { ok: true };
    }

    const applicantFresh = await User.findById(applicant._id);
    if (!applicantFresh) {
      throw new Error('Applicant missing after referral apply');
    }

    const pSession = await mongoose.startSession();
    pSession.startTransaction();
    try {
      applicantFresh.$session(pSession);
      await promoteUserToCreatorWithStarterProfile(applicantFresh, { session: pSession });
      await pSession.commitTransaction();
      logInfo('Creator referral: promoted with starter Creator document', {
        newUserId: applicant._id.toString(),
        referrerId: referrer._id.toString(),
      });
    } catch (promoteErr) {
      await pSession.abortTransaction();
      logError('Creator referral promotion failed', promoteErr as Error, {
        newUserId: applicant._id.toString(),
      });
      throw promoteErr;
    } finally {
      applicantFresh.$session(null);
      await pSession.endSession();
    }
  }

  return { ok: true };
}

/**
 * Process referral reward when a referred user completes a coin purchase ≥ min INR.
 * Uses atomic User update + ReferralEdge sync + idempotent CoinTransaction.
 */
export async function processReferralRewardOnPurchase(
  referredUserId: Types.ObjectId,
  purchasePriceInr: number
): Promise<boolean> {
  const minInr = getReferralMinPurchaseInr();
  const rewardCoins = getReferralRewardCoins();

  if (purchasePriceInr < minInr) return false;

  await ensureReferralEdgeForReferredUser(referredUserId);

  const referredUser = await User.findById(referredUserId).select('referredBy').lean();
  if (!referredUser?.referredBy) return false;

  const referrerId = referredUser.referredBy as Types.ObjectId;

  const grant = await User.updateOne(
    {
      _id: referrerId,
      referrals: { $elemMatch: { user: referredUserId, rewardGranted: false } },
    },
    {
      $set: { 'referrals.$[r].rewardGranted': true },
      $inc: { coins: rewardCoins },
    },
    {
      arrayFilters: [{ 'r.user': referredUserId, 'r.rewardGranted': false }],
    }
  );

  if (grant.modifiedCount !== 1) {
    return false;
  }

  await ReferralEdge.updateOne(
    { referredUserId },
    { $set: { rewardGranted: true } }
  ).catch(() => {});

  const txnId = referralRewardTransactionId(referrerId, referredUserId);
  try {
    await CoinTransaction.create({
      transactionId: txnId,
      userId: referrerId,
      type: 'credit',
      coins: rewardCoins,
      source: 'referral_reward',
      description: `Referral reward: referred user purchased coins (₹${purchasePriceInr})`,
      status: 'completed',
    });
  } catch (err) {
    if (!isDuplicateKeyError(err)) {
      logError('Referral reward CoinTransaction failed', err as Error, {
        txnId,
        referrerId: referrerId.toString(),
        referredUserId: referredUserId.toString(),
      });
      throw err;
    }
  }

  logInfo('Referral reward granted', {
    referrerId: referrerId.toString(),
    referredUserId: referredUserId.toString(),
    coins: rewardCoins,
    purchasePriceInr,
  });

  const referrer = await User.findById(referrerId).select('firebaseUid coins').lean();
  try {
    if (referrer?.firebaseUid) {
      const io = getIO();
      io.to(`user:${referrer.firebaseUid}`).emit('coins_updated', {
        userId: referrerId.toString(),
        coins: referrer.coins ?? 0,
      });
    }
  } catch (e) {
    logError('Failed to emit coins_updated for referrer', e as Error);
  }

  return true;
}
