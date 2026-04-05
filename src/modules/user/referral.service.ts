/**
 * Referral Service
 *
 * Handles:
 * - Generating unique referral codes for new users
 * - Applying referral code on signup (referredBy, referrer.referrals)
 * - Creator promotion when referrer is a creator
 * - Granting 60 coins to referrer when referred user buys coins >= ₹100
 */

import mongoose, { Types } from 'mongoose';
import { User, IUser } from './user.model';
import { Creator } from '../creator/creator.model';
import { CreatorApplication } from '../agent/creator-application.model';
import { promoteUserToCreatorWithStarterProfile } from '../creator/creator-starter.service';
import { CoinTransaction } from './coin-transaction.model';
import { getIO } from '../../config/socket';
import {
  generateUniqueReferralCode,
  isValidReferralCodeFormat,
  normalizeReferralCode,
} from '../../utils/referral-code';
import { logInfo, logDebug, logError } from '../../utils/logger';

export const REFERRAL_REWARD_COINS = 60;
export const REFERRAL_MIN_PURCHASE_INR = 100;

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
    const existing = await User.findOne({ referralCode: c });
    return !!existing;
  });

  user.referralCode = code;
  await user.save();
  logDebug('Referral code assigned', { userId: user._id.toString(), referralCode: code });
  return code;
}

/**
 * Apply referral code when a new user signs up.
 * - Sets newUser.referredBy = referrer
 * - Pushes entry to referrer.referrals
 * - If referrer is a Creator, promotes newUser to creator role
 *
 * @returns true if referral was applied, false if invalid/not found
 */
export async function applyReferralCode(
  newUser: IUser,
  referralCodeRaw: string | null | undefined
): Promise<boolean> {
  if (!referralCodeRaw || !isValidReferralCodeFormat(referralCodeRaw)) return false;

  const code = normalizeReferralCode(referralCodeRaw);
  const referrer = await User.findOne({ referralCode: code });

  if (!referrer) return false;

  // Cannot refer self
  if (referrer._id.equals(newUser._id)) return false;

  // Disabled agent codes behave as invalid (do not set referredBy or pending state)
  if (referrer.role === 'agent' && referrer.agentDisabled) {
    logInfo('Referral skipped: agent account disabled', { code, referrerId: referrer._id.toString() });
    return false;
  }

  // Apply referral
  newUser.referredBy = referrer._id;
  await newUser.save();

  // Add to referrer's referrals list
  if (!referrer.referrals) referrer.referrals = [];
  referrer.referrals.push({
    user: newUser._id,
    rewardGranted: false,
    createdAt: new Date(),
  });
  await referrer.save();

  logInfo('Referral applied', {
    newUserId: newUser._id.toString(),
    referrerId: referrer._id.toString(),
    referralCode: code,
  });

  // Agent referral: pending application only (stay role user); agentDisabled already filtered above
  if (referrer.role === 'agent') {
    const existingPending = await CreatorApplication.findOne({
      applicantUserId: newUser._id,
      status: 'pending',
    })
      .select('_id')
      .lean();
    if (!existingPending) {
      await CreatorApplication.create({
        applicantUserId: newUser._id,
        agentUserId: referrer._id,
        referralCodeUsed: code,
        status: 'pending',
      });
    }
    logInfo('Agent referral: creator application pending', {
      newUserId: newUser._id.toString(),
      agentUserId: referrer._id.toString(),
    });
    return true;
  }

  // Creator promotion: if referrer has a creator profile, promote + always create Creator doc
  const creatorProfile = await Creator.findOne({ userId: referrer._id });
  if (creatorProfile) {
    const existingCreatorForNewUser = await Creator.findOne({ userId: newUser._id });
    if (existingCreatorForNewUser) {
      logInfo('Creator referral skipped: applicant already has creator profile', {
        newUserId: newUser._id.toString(),
      });
      return true;
    }

    const session = await mongoose.startSession();
    session.startTransaction();
    try {
      newUser.$session(session);
      await promoteUserToCreatorWithStarterProfile(newUser, { session });
      await session.commitTransaction();
      logInfo('Creator referral: promoted with starter Creator document', {
        newUserId: newUser._id.toString(),
        referrerId: referrer._id.toString(),
      });
    } catch (err) {
      await session.abortTransaction();
      logError('Creator referral promotion failed', err as Error, {
        newUserId: newUser._id.toString(),
      });
      throw err;
    } finally {
      newUser.$session(null);
      session.endSession();
    }
  }

  return true;
}

/**
 * Process referral reward when a referred user completes a coin purchase >= ₹100.
 * Credits 60 coins to the referrer and marks rewardGranted = true.
 *
 * Call this from payment verification after crediting coins to the buyer.
 *
 * @param referredUserId - MongoDB User._id of the user who made the purchase
 * @param purchasePriceInr - Amount paid in INR
 * @returns true if reward was granted, false otherwise
 */
export async function processReferralRewardOnPurchase(
  referredUserId: Types.ObjectId,
  purchasePriceInr: number
): Promise<boolean> {
  if (purchasePriceInr < REFERRAL_MIN_PURCHASE_INR) return false;

  const referredUser = await User.findById(referredUserId);
  if (!referredUser || !referredUser.referredBy) return false;

  const referrer = await User.findById(referredUser.referredBy);
  if (!referrer || !referrer.referrals) return false;

  const referralEntry = referrer.referrals.find((r) =>
    (r.user as Types.ObjectId).equals(referredUserId)
  );
  if (!referralEntry || referralEntry.rewardGranted) return false;

  // Grant reward
  referralEntry.rewardGranted = true;
  referrer.coins = (referrer.coins || 0) + REFERRAL_REWARD_COINS;
  await referrer.save();

  // Record transaction for audit
  const txnId = `referral_${referredUserId}_${Date.now()}`;
  await CoinTransaction.create({
    transactionId: txnId,
    userId: referrer._id,
    type: 'credit',
    coins: REFERRAL_REWARD_COINS,
    source: 'referral_reward',
    description: `Referral reward: referred user purchased coins (₹${purchasePriceInr})`,
    status: 'completed',
  });

  logInfo('Referral reward granted', {
    referrerId: referrer._id.toString(),
    referredUserId: referredUserId.toString(),
    coins: REFERRAL_REWARD_COINS,
    purchasePriceInr,
  });

  // Emit coins_updated for referrer
  try {
    const io = getIO();
    io.to(`user:${referrer.firebaseUid}`).emit('coins_updated', {
      userId: referrer._id.toString(),
      coins: referrer.coins,
    });
  } catch (e) {
    logError('Failed to emit coins_updated for referrer', e as Error);
  }

  return true;
}
