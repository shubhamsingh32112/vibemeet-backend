import mongoose from 'mongoose';
import { Creator } from '../creator/creator.model';
import { User } from '../user/user.model';
import { ReferralEdge } from '../user/referral-edge.model';
import { isAgencyRole } from '../../utils/staff-roles';
import { CoinTransaction } from '../user/coin-transaction.model';
import { Withdrawal } from '../creator/withdrawal.model';
import { getReferralRewardCoins } from '../user/referral.service';

function isDuplicateKeyError(err: unknown): boolean {
  return Boolean(
    err &&
      typeof err === 'object' &&
      'code' in err &&
      (err as { code?: number }).code === 11000
  );
}

export type TransferCreatorToAgencyResult =
  | {
      ok: true;
      data: {
        creatorId: string;
        creatorUserId: string;
        oldAssignedAgencyId: string | null;
        newAssignedAgencyId: string;
        oldReferredByUserId: string | null;
        newReferredByUserId: string;
        oldReferralCodeUsed: string | null;
        newReferralCodeUsed: string;
        rewardMoved: boolean;
        assignmentEffectiveFrom: string;
        moveGrantedReferralRewardsAttempted: boolean;
        pendingWithdrawalsReassigned: number;
      };
    }
  | {
      ok: false;
      status: number;
      error: string;
    };

type TransferOptions = {
  idempotencyKey?: string | null;
  moveGrantedReferralRewards?: boolean;
  assignmentEffectiveFrom?: Date | string;
};

/**
 * Admin transfer: moves creator to a target agency and re-attributes referral retroactively.
 */
export async function transferCreatorToAgency(
  creatorIdRaw: string,
  targetAgencyIdRaw: string,
  options?: TransferOptions
): Promise<TransferCreatorToAgencyResult> {
  const creatorId = String(creatorIdRaw || '').trim();
  const targetAgencyId = String(targetAgencyIdRaw || '').trim();
  const idem = (options?.idempotencyKey || '').trim();

  if (!mongoose.Types.ObjectId.isValid(creatorId)) {
    return { ok: false, status: 400, error: 'Invalid creator id' };
  }
  if (!mongoose.Types.ObjectId.isValid(targetAgencyId)) {
    return { ok: false, status: 400, error: 'Invalid targetAgencyId' };
  }

  const creatorOid = new mongoose.Types.ObjectId(creatorId);
  const targetAgencyOid = new mongoose.Types.ObjectId(targetAgencyId);

  const session = await mongoose.startSession();
  try {
    let result: TransferCreatorToAgencyResult | null = null;

    await session.withTransaction(async () => {
      const effectiveFromRaw = options?.assignmentEffectiveFrom;
      const assignmentEffectiveFromIso =
        effectiveFromRaw != null
          ? new Date(effectiveFromRaw).toISOString()
          : new Date().toISOString();

      const creator = await Creator.findById(creatorOid).session(session);
      if (!creator) {
        result = { ok: false, status: 404, error: 'Creator not found' };
        return;
      }
      const creatorUserId = creator.userId as mongoose.Types.ObjectId | undefined;
      if (!creatorUserId) {
        result = { ok: false, status: 409, error: 'Creator is missing linked userId' };
        return;
      }

      const targetAgency = await User.findOne({
        _id: targetAgencyOid,
        role: 'agency',
        agencyDisabled: { $ne: true },
      })
        .select('_id role agencyDisabled referralCode email displayName username')
        .session(session);
      if (!targetAgency) {
        result = { ok: false, status: 404, error: 'Target agency not found or disabled' };
        return;
      }
      const targetReferralCode = targetAgency.referralCode?.toUpperCase?.() || '';
      if (!targetReferralCode) {
        result = {
          ok: false,
          status: 409,
          error: 'Target agency has no referralCode. Run backfill-referral-codes or recreate agency.',
        };
        return;
      }

      const user = await User.findById(creatorUserId).session(session);
      if (!user) {
        result = { ok: false, status: 404, error: 'Creator linked user not found' };
        return;
      }

      const oldAssignedAgencyId = creator.assignedAgencyId
        ? (creator.assignedAgencyId as mongoose.Types.ObjectId).toString()
        : null;
      const oldReferredBy = user.referredBy
        ? (user.referredBy as mongoose.Types.ObjectId).toString()
        : null;

      const existingEdge = await ReferralEdge.findOne({ referredUserId: creatorUserId })
        .select('_id referrerId referralCodeUsed rewardGranted')
        .session(session);
      const oldReferralCodeUsed = existingEdge?.referralCodeUsed ?? null;
      const rewardGranted = existingEdge?.rewardGranted ?? false;

      const isReferrerChanging =
        !!oldReferredBy &&
        mongoose.Types.ObjectId.isValid(oldReferredBy) &&
        oldReferredBy !== targetAgencyOid.toString();

      let rewardMoveEligible = false;
      const allowRewardCoinMove = options?.moveGrantedReferralRewards === true;
      if (allowRewardCoinMove && rewardGranted && isReferrerChanging) {
        const rewardCoins = getReferralRewardCoins();
        const oldRefOid = new mongoose.Types.ObjectId(oldReferredBy!);
        const oldRef = await User.findById(oldRefOid).select('role coins').session(session).lean();
        if (!oldRef) {
          result = { ok: false, status: 404, error: 'Previous referrer not found' };
          throw new Error('ABORT_TX');
        }
        if (isAgencyRole(oldRef.role)) {
          const oldCoins = typeof oldRef.coins === 'number' ? oldRef.coins : 0;
          if (oldCoins < rewardCoins) {
            result = {
              ok: false,
              status: 409,
              error:
                'Previous agency has insufficient coin balance to move an already-granted referral reward. Top up or handle manually, then retry.',
            };
            throw new Error('ABORT_TX');
          }
          rewardMoveEligible = true;
        }
      }

      if (existingEdge) {
        await ReferralEdge.updateOne(
          { _id: existingEdge._id },
          {
            $set: {
              referrerId: targetAgencyOid,
              referralCodeUsed: targetReferralCode,
            },
          },
          { session }
        );
      } else {
        try {
          await ReferralEdge.create(
            [
              {
                referrerId: targetAgencyOid,
                referredUserId: creatorUserId,
                referralCodeUsed: targetReferralCode,
                rewardGranted: false,
              },
            ],
            { session }
          );
        } catch (e) {
          if (!isDuplicateKeyError(e)) throw e;
          await ReferralEdge.updateOne(
            { referredUserId: creatorUserId },
            {
              $set: {
                referrerId: targetAgencyOid,
                referralCodeUsed: targetReferralCode,
              },
            },
            { session }
          );
        }
      }

      if (!creator.assignedAgencyId || !(creator.assignedAgencyId as mongoose.Types.ObjectId).equals(targetAgencyOid)) {
        creator.assignedAgencyId = targetAgencyOid;
        await creator.save({ session });
      }

      if (!user.referredBy || !(user.referredBy as mongoose.Types.ObjectId).equals(targetAgencyOid)) {
        user.referredBy = targetAgencyOid;
        await user.save({ session });
      }

      const creatorUserOid = creatorUserId as mongoose.Types.ObjectId;
      if (oldReferredBy && mongoose.Types.ObjectId.isValid(oldReferredBy)) {
        const oldRefOid = new mongoose.Types.ObjectId(oldReferredBy);
        await User.updateOne(
          { _id: oldRefOid },
          { $pull: { referrals: { user: creatorUserOid } } },
          { session }
        );
      }

      await User.updateOne(
        { _id: targetAgencyOid },
        { $pull: { referrals: { user: creatorUserOid } } },
        { session }
      );
      await User.updateOne(
        { _id: targetAgencyOid },
        {
          $push: {
            referrals: {
              user: creatorUserOid,
              rewardGranted: rewardGranted,
              createdAt: new Date(),
            },
          },
        },
        { session }
      );

      let rewardMoved = false;
      if (
        allowRewardCoinMove &&
        rewardGranted &&
        rewardMoveEligible &&
        oldReferredBy &&
        mongoose.Types.ObjectId.isValid(oldReferredBy) &&
        oldReferredBy !== targetAgencyOid.toString()
      ) {
        const rewardCoins = getReferralRewardCoins();
        const oldRefOid = new mongoose.Types.ObjectId(oldReferredBy);

        const suffix = `${creatorUserOid.toString()}_${oldRefOid.toString()}_${targetAgencyOid.toString()}${
          idem ? `_${idem}` : ''
        }`;
        const debitTxnId = `referral_reward_transfer_out_${suffix}`;
        const creditTxnId = `referral_reward_transfer_in_${suffix}`;

        const [debitExists, creditExists] = await Promise.all([
          CoinTransaction.findOne({ transactionId: debitTxnId }).select('_id').session(session).lean(),
          CoinTransaction.findOne({ transactionId: creditTxnId }).select('_id').session(session).lean(),
        ]);

        if (!debitExists && !creditExists) {
          await CoinTransaction.create(
            [
              {
                transactionId: debitTxnId,
                userId: oldRefOid,
                type: 'debit',
                coins: rewardCoins,
                source: 'referral_reward',
                description: `Referral reward moved out due to creator transfer (${creatorUserOid.toString()})`,
                status: 'completed',
              },
              {
                transactionId: creditTxnId,
                userId: targetAgencyOid,
                type: 'credit',
                coins: rewardCoins,
                source: 'referral_reward',
                description: `Referral reward moved in due to creator transfer (${creatorUserOid.toString()})`,
                status: 'completed',
              },
            ],
            { session }
          );

          await Promise.all([
            User.updateOne({ _id: oldRefOid }, { $inc: { coins: -rewardCoins } }, { session }),
            User.updateOne({ _id: targetAgencyOid }, { $inc: { coins: rewardCoins } }, { session }),
          ]);

          rewardMoved = true;
        }
      }

      const wdUpdate = await Withdrawal.updateMany(
        { creatorUserId: creatorUserId, status: 'pending' },
        { $set: { assignedAgencyId: targetAgencyOid } },
        { session }
      );

      result = {
        ok: true,
        data: {
          creatorId: creator._id.toString(),
          creatorUserId: creatorUserId.toString(),
          oldAssignedAgencyId,
          newAssignedAgencyId: targetAgencyOid.toString(),
          oldReferredByUserId: oldReferredBy,
          newReferredByUserId: targetAgencyOid.toString(),
          oldReferralCodeUsed,
          newReferralCodeUsed: targetReferralCode,
          rewardMoved,
          assignmentEffectiveFrom: assignmentEffectiveFromIso,
          moveGrantedReferralRewardsAttempted: allowRewardCoinMove,
          pendingWithdrawalsReassigned: wdUpdate.modifiedCount ?? 0,
        },
      };
    });

    return (
      result ?? {
        ok: false,
        status: 500,
        error: 'Transfer failed: unknown error',
      }
    );
  } finally {
    await session.endSession();
  }
}
