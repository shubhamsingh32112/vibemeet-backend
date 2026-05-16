/**
 * Referral Service
 *
 * Handles:
 * - Generating unique referral codes for new users
 * - Applying referral code (signup + one-time late attach)
 * - Agent referrals link via User.referredBy (no CreatorApplication); creator-as-referrer is disabled (see applyReferralCode)
 * - Atomic reward when referred user buys coins (≥ min INR)
 */

import { Types } from 'mongoose';
import { User, IUser } from './user.model';
import { Creator } from '../creator/creator.model';
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
import { isAgencyRole, isBdRole, isBdStaffDisabled } from '../../utils/staff-roles';

/**
 * Existing-account login: agency join links use agency_host; consumer codes use late_attach.
 */
export async function resolveReferralApplyModeForExistingUser(
  referralCodeRaw: string
): Promise<'agency_host' | 'late_attach'> {
  if (!isValidReferralCodeFormat(referralCodeRaw)) {
    return 'late_attach';
  }
  const code = normalizeReferralCode(referralCodeRaw);
  const referrer = await User.findOne({ referralCode: code }).select('role').lean();
  if (referrer && isAgencyRole(referrer.role)) {
    return 'agency_host';
  }
  return 'late_attach';
}

export {
  getReferralAttachWindowMs,
  getReferralMinPurchaseInr,
  getReferralRewardCoins,
} from './referral-config';

/** Backwards-compatible defaults (runtime values use getReferral*()) */
export const REFERRAL_REWARD_COINS = 60;
export const REFERRAL_MIN_PURCHASE_INR = 100;

export type ApplyReferralCodeMode = 'signup' | 'late_attach' | 'agency_host';

export type ApplyReferralCodeErrorCode =
  | 'INVALID_FORMAT'
  | 'NOT_FOUND'
  | 'SELF'
  | 'AGENT_DISABLED'
  | 'ALREADY_REFERRED'
  | 'CREATOR_CANNOT_REFER'
  | 'WINDOW_EXPIRED'
  | 'PURCHASE_ALREADY'
  | 'NOT_ELIGIBLE_ROLE'
  | 'AGENCY_REFERRAL_ONLY'
  | 'ALREADY_LINKED_TO_AGENCY';

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
async function rollbackReferralClaim(
  applicantId: Types.ObjectId,
  referrerId: Types.ObjectId
): Promise<void> {
  await User.updateOne(
    { _id: applicantId },
    { $unset: { referredBy: 1, hostOnboardingStatus: 1 } }
  );
  await User.updateOne(
    { _id: referrerId },
    { $pull: { referrals: { user: applicantId } } }
  );
}

export async function assignReferralCodeToUser(user: IUser): Promise<string> {
  if (user.referralCode) return user.referralCode;

  const name = getDisplayNameForCode(user);
  const maxAttempts = 8;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const code = await generateUniqueReferralCode(name, async (c) => {
      const hit = await User.findOne({ referralCode: c }).select('_id').lean();
      return !!hit;
    });
    user.referralCode = code;
    try {
      await user.save();
      logDebug('Referral code assigned', { userId: user._id.toString(), referralCode: code });
      return code;
    } catch (err) {
      if (isDuplicateKeyError(err)) {
        user.referralCode = undefined;
        continue;
      }
      throw err;
    }
  }
  throw new Error('Unable to assign unique referral code after retries');
}

export type PreviewReferralCodeResult =
  | { ok: true; code: string; agencyDisplayName?: string }
  | { ok: false; code: ApplyReferralCodeErrorCode };

/** Label for agency host referral dialog (username, email local, or fallback). */
export function agencyDisplayNameFromUser(user: {
  username?: string | null;
  email?: string | null;
}): string {
  if (user.username && user.username.trim().length >= 2) {
    return user.username.trim();
  }
  if (user.email) {
    const local = user.email.split('@')[0]?.trim();
    if (local && local.length >= 2) return local;
  }
  return 'Agency';
}

async function applicantHasAgencyAssignment(userId: Types.ObjectId): Promise<boolean> {
  const creator = await Creator.findOne({ userId }).select('assignedAgencyId').lean();
  return !!(creator?.assignedAgencyId);
}

async function previewAgencyHostApplicantEligibility(
  applicant: IUser
): Promise<ApplyReferralCodeErrorCode | null> {
  if (applicant.referredBy) {
    return 'ALREADY_REFERRED';
  }
  if (await applicantHasAgencyAssignment(applicant._id)) {
    return 'ALREADY_LINKED_TO_AGENCY';
  }
  return null;
}

type PreviewReferralOptions = {
  mode?: ApplyReferralCodeMode;
  applicant?: IUser | null;
};

async function previewApplicantEligibility(
  applicant: IUser,
  mode: ApplyReferralCodeMode
): Promise<ApplyReferralCodeErrorCode | null> {
  if (mode === 'agency_host') {
    return previewAgencyHostApplicantEligibility(applicant);
  }
  if (applicant.referredBy) {
    return 'ALREADY_REFERRED';
  }
  if (mode !== 'late_attach') {
    return null;
  }
  if (applicant.role !== 'user') {
    return 'NOT_ELIGIBLE_ROLE';
  }
  const creatorProf = await Creator.findOne({ userId: applicant._id }).select('_id').lean();
  if (creatorProf) {
    return 'NOT_ELIGIBLE_ROLE';
  }
  const createdAt = applicant.createdAt ? new Date(applicant.createdAt).getTime() : 0;
  if (Date.now() - createdAt > getReferralAttachWindowMs()) {
    return 'WINDOW_EXPIRED';
  }
  if (await userHasCompletedCoinPurchase(applicant._id)) {
    return 'PURCHASE_ALREADY';
  }
  return null;
}

/**
 * Validate a referral code for pre-login preview (existence + creator/agent rules).
 */
export async function previewReferralCode(
  referralCodeRaw: string | null | undefined,
  options?: PreviewReferralOptions
): Promise<PreviewReferralCodeResult> {
  const mode: ApplyReferralCodeMode = options?.mode ?? 'signup';
  const applicant = options?.applicant ?? null;

  if (!referralCodeRaw || !isValidReferralCodeFormat(referralCodeRaw)) {
    return { ok: false, code: 'INVALID_FORMAT' };
  }
  if (applicant) {
    const applicantError = await previewApplicantEligibility(applicant, mode);
    if (applicantError) {
      return { ok: false, code: applicantError };
    }
  }
  const code = normalizeReferralCode(referralCodeRaw);
  const referrer = await User.findOne({ referralCode: code });
  if (!referrer) {
    return { ok: false, code: 'NOT_FOUND' };
  }
  if (applicant && referrer._id.equals(applicant._id)) {
    return { ok: false, code: 'SELF' };
  }
  if (isAgencyRole(referrer.role) && referrer.agencyDisabled) {
    return { ok: false, code: 'AGENT_DISABLED' };
  }
  if (isBdRole(referrer.role) && isBdStaffDisabled(referrer)) {
    return { ok: false, code: 'AGENT_DISABLED' };
  }
  if (mode === 'agency_host') {
    if (!isAgencyRole(referrer.role)) {
      return { ok: false, code: 'AGENCY_REFERRAL_ONLY' };
    }
    return {
      ok: true,
      code,
      agencyDisplayName: agencyDisplayNameFromUser(referrer),
    };
  }
  if (!isAgencyRole(referrer.role) && !isBdRole(referrer.role)) {
    const referrerCreatorProfile = await Creator.findOne({ userId: referrer._id })
      .select('_id')
      .lean();
    if (referrerCreatorProfile) {
      return { ok: false, code: 'CREATOR_CANNOT_REFER' };
    }
  }
  return { ok: true, code };
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

  if (mode === 'agency_host') {
    const agencyHostError = await previewAgencyHostApplicantEligibility(applicant);
    if (agencyHostError) {
      return { ok: false, code: agencyHostError };
    }
  } else if (applicant.referredBy) {
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

  if (isAgencyRole(referrer.role) && referrer.agencyDisabled) {
    logInfo('Referral skipped: agent account disabled', {
      code,
      referrerId: referrer._id.toString(),
    });
    return { ok: false, code: 'AGENT_DISABLED' };
  }
  if (isBdRole(referrer.role) && isBdStaffDisabled(referrer)) {
    logInfo('Referral skipped: BD account disabled', {
      code,
      referrerId: referrer._id.toString(),
    });
    return { ok: false, code: 'AGENT_DISABLED' };
  }

  if (mode === 'agency_host') {
    if (!isAgencyRole(referrer.role)) {
      return { ok: false, code: 'AGENCY_REFERRAL_ONLY' };
    }
  }

  // Creators cannot refer (non-staff). Agency/BD staff may refer even if they have a creator profile.
  if (!isAgencyRole(referrer.role) && !isBdRole(referrer.role)) {
    const referrerCreatorProfile = await Creator.findOne({ userId: referrer._id })
      .select('_id')
      .lean();
    if (referrerCreatorProfile) {
      logInfo('Referral skipped: creator referrals disabled', {
        code,
        referrerId: referrer._id.toString(),
      });
      return { ok: false, code: 'CREATOR_CANNOT_REFER' };
    }
  }

  const referredByUpdate: Record<string, unknown> = { referredBy: referrer._id };
  if (isAgencyRole(referrer.role)) {
    referredByUpdate.hostOnboardingStatus = 'pending_agency_approval';
    referredByUpdate.hostOnboardingRejectedReason = null;
  }

  const claimed = await User.findOneAndUpdate(
    { _id: applicant._id, referredBy: null },
    { $set: referredByUpdate },
    { new: true }
  );
  if (!claimed) {
    return { ok: false, code: 'ALREADY_REFERRED' };
  }

  const pushResult = await User.updateOne(
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
  if ((pushResult.matchedCount ?? 0) === 0) {
    await rollbackReferralClaim(applicant._id, referrer._id);
    return { ok: false, code: 'NOT_FOUND' };
  }

  try {
    await ReferralEdge.create({
      referrerId: referrer._id,
      referredUserId: applicant._id,
      referralCodeUsed: code,
      rewardGranted: false,
    });
  } catch (err) {
    await rollbackReferralClaim(applicant._id, referrer._id);
    if (isDuplicateKeyError(err)) {
      return { ok: false, code: 'ALREADY_REFERRED' };
    }
    logError('ReferralEdge.create failed after claim', err as Error, {
      applicantId: applicant._id.toString(),
      referrerId: referrer._id.toString(),
    });
    return { ok: false, code: 'NOT_FOUND' };
  }

  logInfo('Referral applied', {
    newUserId: applicant._id.toString(),
    referrerId: referrer._id.toString(),
    referralCode: code,
    mode,
  });

  if (isAgencyRole(referrer.role)) {
    logInfo('Agency referral: user linked; promotion via agency or admin dashboard', {
      newUserId: applicant._id.toString(),
      agencyUserId: referrer._id.toString(),
    });
    return { ok: true };
  }

  // Non-BD creator referrers are rejected before linkage; no invitee promotion path here.
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
