import mongoose from 'mongoose';
import { Creator } from '../creator/creator.model';
import { User } from '../user/user.model';
import { ReferralEdge } from '../user/referral-edge.model';
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

export type TransferCreatorToAgentResult =
  | {
      ok: true;
      data: {
        creatorId: string;
        creatorUserId: string;
        oldAssignedAgentId: string | null;
        newAssignedAgentId: string;
        oldReferredByUserId: string | null;
        newReferredByUserId: string;
        oldReferralCodeUsed: string | null;
        newReferralCodeUsed: string;
        rewardMoved: boolean;
        pendingWithdrawalsReassigned: number;
      };
    }
  | {
      ok: false;
      status: number;
      error: string;
    };

type TransferOptions = {
  /** Optional idempotency scope key (used in transactionId strings). */
  idempotencyKey?: string | null;
};

/**
 * Admin transfer: moves creator to a target agent and re-attributes referral retroactively.
 * Single MongoDB transaction to keep Creator/User/ReferralEdge/referrer lists consistent.
 */
export async function transferCreatorToAgent(
  creatorIdRaw: string,
  targetAgentIdRaw: string,
  options?: TransferOptions
): Promise<TransferCreatorToAgentResult> {
  const creatorId = String(creatorIdRaw || '').trim();
  const targetAgentId = String(targetAgentIdRaw || '').trim();
  const idem = (options?.idempotencyKey || '').trim();

  if (!mongoose.Types.ObjectId.isValid(creatorId)) {
    return { ok: false, status: 400, error: 'Invalid creator id' };
  }
  if (!mongoose.Types.ObjectId.isValid(targetAgentId)) {
    return { ok: false, status: 400, error: 'Invalid targetAgentId' };
  }

  const creatorOid = new mongoose.Types.ObjectId(creatorId);
  const targetAgentOid = new mongoose.Types.ObjectId(targetAgentId);

  const session = await mongoose.startSession();
  try {
    let result: TransferCreatorToAgentResult | null = null;

    await session.withTransaction(async () => {
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

      const targetAgent = await User.findOne({
        _id: targetAgentOid,
        role: 'agent',
        agentDisabled: { $ne: true },
      })
        .select('_id role agentDisabled referralCode email displayName username')
        .session(session);
      if (!targetAgent) {
        result = { ok: false, status: 404, error: 'Target agent not found or disabled' };
        return;
      }
      const targetReferralCode = targetAgent.referralCode?.toUpperCase?.() || '';
      if (!targetReferralCode) {
        result = {
          ok: false,
          status: 409,
          error: 'Target agent has no referralCode. Run backfill-referral-codes or recreate agent.',
        };
        return;
      }

      const user = await User.findById(creatorUserId).session(session);
      if (!user) {
        result = { ok: false, status: 404, error: 'Creator linked user not found' };
        return;
      }

      const oldAssignedAgentId = creator.assignedAgentId
        ? (creator.assignedAgentId as mongoose.Types.ObjectId).toString()
        : null;
      const oldReferredBy = user.referredBy
        ? (user.referredBy as mongoose.Types.ObjectId).toString()
        : null;

      // Upsert edge first (source-of-truth for referralCodeUsed snapshot)
      const existingEdge = await ReferralEdge.findOne({ referredUserId: creatorUserId })
        .select('_id referrerId referralCodeUsed rewardGranted')
        .session(session);
      const oldReferralCodeUsed = existingEdge?.referralCodeUsed ?? null;
      const rewardGranted = existingEdge?.rewardGranted ?? false;

      // Pre-check reward move eligibility before mutating anything.
      const isReferrerChanging =
        !!oldReferredBy &&
        mongoose.Types.ObjectId.isValid(oldReferredBy) &&
        oldReferredBy !== targetAgentOid.toString();

      let rewardMoveEligible = false;
      if (rewardGranted && isReferrerChanging) {
        const rewardCoins = getReferralRewardCoins();
        const oldRefOid = new mongoose.Types.ObjectId(oldReferredBy!);
        const oldRef = await User.findById(oldRefOid).select('role coins').session(session).lean();
        if (!oldRef) {
          result = { ok: false, status: 404, error: 'Previous referrer not found' };
          throw new Error('ABORT_TX');
        }
        // Only move already-granted referral rewards between agents.
        if (oldRef.role === 'agent') {
          const oldCoins = typeof oldRef.coins === 'number' ? oldRef.coins : 0;
          if (oldCoins < rewardCoins) {
            result = {
              ok: false,
              status: 409,
              error:
                'Previous agent has insufficient coin balance to move an already-granted referral reward. Top up or handle manually, then retry.',
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
              referrerId: targetAgentOid,
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
                referrerId: targetAgentOid,
                referredUserId: creatorUserId,
                referralCodeUsed: targetReferralCode,
                rewardGranted: false,
              },
            ],
            { session }
          );
        } catch (e) {
          if (!isDuplicateKeyError(e)) throw e;
          // If another concurrent op inserted it, align it.
          await ReferralEdge.updateOne(
            { referredUserId: creatorUserId },
            {
              $set: {
                referrerId: targetAgentOid,
                referralCodeUsed: targetReferralCode,
              },
            },
            { session }
          );
        }
      }

      // Creator assignment drives agent dashboard visibility
      if (!creator.assignedAgentId || !(creator.assignedAgentId as mongoose.Types.ObjectId).equals(targetAgentOid)) {
        creator.assignedAgentId = targetAgentOid;
        await creator.save({ session });
      }

      // Referral attribution (retroactive): set referredBy to target agent
      if (!user.referredBy || !(user.referredBy as mongoose.Types.ObjectId).equals(targetAgentOid)) {
        user.referredBy = targetAgentOid;
        await user.save({ session });
      }

      // Keep referrer User.referrals[] lists consistent (best-effort, but in-transaction)
      const creatorUserOid = creatorUserId as mongoose.Types.ObjectId;
      if (oldReferredBy && mongoose.Types.ObjectId.isValid(oldReferredBy)) {
        const oldRefOid = new mongoose.Types.ObjectId(oldReferredBy);
        await User.updateOne(
          { _id: oldRefOid },
          { $pull: { referrals: { user: creatorUserOid } } },
          { session }
        );
      }

      // Ensure a single entry for the new referrer
      await User.updateOne(
        { _id: targetAgentOid },
        { $pull: { referrals: { user: creatorUserOid } } },
        { session }
      );
      await User.updateOne(
        { _id: targetAgentOid },
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

      // Reward move: only if already granted and referrer actually changed
      let rewardMoved = false;
      if (
        rewardGranted &&
        rewardMoveEligible &&
        oldReferredBy &&
        mongoose.Types.ObjectId.isValid(oldReferredBy) &&
        oldReferredBy !== targetAgentOid.toString()
      ) {
        const rewardCoins = getReferralRewardCoins();
        const oldRefOid = new mongoose.Types.ObjectId(oldReferredBy);

        const suffix = `${creatorUserOid.toString()}_${oldRefOid.toString()}_${targetAgentOid.toString()}${
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
                userId: targetAgentOid,
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
            User.updateOne({ _id: targetAgentOid }, { $inc: { coins: rewardCoins } }, { session }),
          ]);

          rewardMoved = true;
        }
      }

      const wdUpdate = await Withdrawal.updateMany(
        { creatorUserId: creatorUserId, status: 'pending' },
        { $set: { assignedAgentId: targetAgentOid } },
        { session }
      );

      result = {
        ok: true,
        data: {
          creatorId: creator._id.toString(),
          creatorUserId: creatorUserId.toString(),
          oldAssignedAgentId,
          newAssignedAgentId: targetAgentOid.toString(),
          oldReferredByUserId: oldReferredBy,
          newReferredByUserId: targetAgentOid.toString(),
          oldReferralCodeUsed,
          newReferralCodeUsed: targetReferralCode,
          rewardMoved,
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

