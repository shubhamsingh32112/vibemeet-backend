/**
 * Video call settlement: Redis session → MongoDB (transactions), chat activity, cache invalidation.
 * Single place for financial writes for billed calls.
 */

import { Server } from 'socket.io';
import mongoose from 'mongoose';
import crypto from 'crypto';
import {
  getRedis,
  callSessionKey,
  callUserCoinsKey,
  callCreatorEarningsKey,
  invalidateCreatorDashboard,
  invalidateCreatorTasks,
  invalidateAdminCaches,
  ACTIVE_BILLING_CALLS_KEY,
  activeCallByUserKey,
  settledCallKey,
  SETTLED_CALL_TTL,
} from '../../config/redis';
import { User, IUser } from '../user/user.model';
import { Creator } from '../creator/creator.model';
import { CoinTransaction } from '../user/coin-transaction.model';
import { CallHistory } from './call-history.model';
import { emitCreatorDataUpdated } from '../creator/creator.controller';
import { verifyUserBalance } from '../../utils/balance-integrity';
import { emitToAdmin } from '../admin/admin.gateway';
import { getStreamClient } from '../../config/stream';
import { recordBillingMetric } from '../../utils/monitoring';
import { logError, logWarning, logInfo, logDebug } from '../../utils/logger';
import {
  COIN_MICROS,
  BILLING_SESSION_SCHEMA_VERSION,
  microsToWholeCoinsFloor,
  microsToUserDebitWholeCoins,
  microsToCreatorCreditWholeCoins,
} from './billing.constants';

interface CallSession {
  schemaVersion?: number;
  callId: string;
  userFirebaseUid: string;
  creatorFirebaseUid: string;
  userMongoId: string;
  creatorMongoId: string;
  pricePerMinute: number;
  pricePerSecondMicros?: number;
  pricePerSecond?: number;
  creatorEarningsPerSecondMicros?: number;
  creatorEarningsPerSecond?: number;
  creatorShareAtCallTime?: number;
  startTime: number;
  lastProcessedAt?: number;
  totalDeductedMicros?: number;
  totalEarnedMicros?: number;
  elapsedSeconds: number;
  effectiveDurationLimitSeconds?: number;
}

function generateUserCreatorChannelId(uid1: string, uid2: string): string {
  const [a, b] = [uid1, uid2].sort();
  const hash = crypto
    .createHash('sha256')
    .update(`${a}:${b}`)
    .digest('hex')
    .slice(0, 32);
  return `uc_${hash}`;
}

function formatDurationLabel(totalSeconds: number): string {
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;

  if (mins <= 0) {
    return `${secs} second${secs === 1 ? '' : 's'}`;
  }
  if (secs === 0) {
    return `${mins} minute${mins === 1 ? '' : 's'}`;
  }
  if (mins < 60) {
    return `${mins} minute${mins === 1 ? '' : 's'} ${secs} second${secs === 1 ? '' : 's'}`;
  }
  const hours = Math.floor(mins / 60);
  const remainingMins = mins % 60;
  if (remainingMins === 0) {
    return `${hours} hour${hours === 1 ? '' : 's'}`;
  }
  return `${hours} hour${hours === 1 ? '' : 's'} ${remainingMins} minute${remainingMins === 1 ? '' : 's'}`;
}

async function removeCallFromBilling(callId: string): Promise<void> {
  const redis = getRedis();
  await redis.zrem(ACTIVE_BILLING_CALLS_KEY, callId);
  logDebug('Removed call from active billing', { callId });
}

const SETTLE_LOCK_PREFIX = 'settle:lock:';
const settleLockKey = (callId: string): string => `${SETTLE_LOCK_PREFIX}${callId}`;

/** Remove live billing keys only after Mongo commit (or idempotent cleanup). */
async function deleteBillingSessionRedisKeys(
  redis: ReturnType<typeof getRedis>,
  callId: string,
  userFirebaseUid: string,
  creatorFirebaseUid: string
): Promise<void> {
  await Promise.all([
    redis.del(callSessionKey(callId)),
    redis.del(callUserCoinsKey(callId)),
    redis.del(callCreatorEarningsKey(callId)),
    redis.del(activeCallByUserKey(userFirebaseUid)),
    redis.del(activeCallByUserKey(creatorFirebaseUid)),
  ]);
}

export async function settleCall(io: Server, callId: string): Promise<void> {
  await removeCallFromBilling(callId);

  const redis = getRedis();

  const settledKey = settledCallKey(callId);
  const alreadySettled = await redis.get(settledKey);
  if (alreadySettled) {
    logWarning('Call already settled (Redis) — skipping', { callId });
    return;
  }

  const lockResult = await redis.set(settleLockKey(callId), '1', 'EX', 60, 'NX');
  const lockAcquired = lockResult === 'OK';
  if (!lockAcquired) {
    logWarning('Settlement already in progress / completed — skipping', { callId });
    return;
  }

  logInfo('Settling call - reading from Redis', {
    callId,
    redisKeys: {
      session: callSessionKey(callId),
      coins: callUserCoinsKey(callId),
      earnings: callCreatorEarningsKey(callId),
    },
  });

  let sessionRaw: string | null;
  try {
    sessionRaw = await redis.get(callSessionKey(callId));
  } catch (redisError) {
    logError('CRITICAL: Redis error reading session during settlement', redisError, {
      callId,
      alert: true,
    });
    await redis.del(settleLockKey(callId)).catch(() => {});
    return;
  }

  if (!sessionRaw) {
    const mongoAlready = await CallHistory.findOne({ callId, ownerRole: 'user' }).lean();
    if (mongoAlready) {
      recordBillingMetric('settlement_idempotent_mongo_no_redis', 1, { callId });
      await redis.setex(settledKey, SETTLED_CALL_TTL, '1');
    } else {
      logWarning('No session in Redis for settlement - call may have already been settled or expired', {
        callId,
        impact: 'Settlement skipped - no billing data available',
      });
    }
    await redis.del(settleLockKey(callId)).catch(() => {});
    return;
  }

  const session: CallSession =
    typeof sessionRaw === 'string' ? JSON.parse(sessionRaw) : (sessionRaw as CallSession);

  const existingUserHistory = await CallHistory.findOne({
    callId,
    ownerUserId: session.userMongoId,
  }).lean();
  if (existingUserHistory) {
    recordBillingMetric('settlement_idempotent_mongo', 1, { callId });
    await deleteBillingSessionRedisKeys(
      redis,
      callId,
      session.userFirebaseUid,
      session.creatorFirebaseUid
    );
    await redis.setex(settledKey, SETTLED_CALL_TTL, '1');
    await redis.del(settleLockKey(callId)).catch(() => {});
    return;
  }

  let finalCoinsRaw: string | null;
  let finalEarningsRaw: string | null;

  try {
    [finalCoinsRaw, finalEarningsRaw] = await Promise.all([
      redis.get(callUserCoinsKey(callId)),
      redis.get(callCreatorEarningsKey(callId)),
    ]);
  } catch (redisError) {
    logError('CRITICAL: Redis error reading coins/earnings during settlement', redisError, {
      callId,
      alert: true,
    });
    await redis.del(settleLockKey(callId)).catch(() => {});
    return;
  }

  const coinsStr = String(finalCoinsRaw ?? '0');
  let balanceMicros: number;
  if (coinsStr.includes('.')) {
    balanceMicros = Math.round(parseFloat(coinsStr) * COIN_MICROS);
  } else {
    balanceMicros = parseInt(coinsStr, 10) || 0;
  }

  const earnRaw = parseInt(String(finalEarningsRaw ?? '0'), 10) || 0;
  let earningsMicros = earnRaw;
  if ((session.schemaVersion ?? 0) < BILLING_SESSION_SCHEMA_VERSION) {
    earningsMicros = Math.round((earnRaw * COIN_MICROS) / 10000);
  }

  const billedSeconds = Math.max(0, Math.floor(Number(session.elapsedSeconds) || 0));
  const durationSeconds = billedSeconds;

  let totalDeducted = microsToUserDebitWholeCoins(session.totalDeductedMicros ?? 0);
  let totalEarnedCreator = microsToCreatorCreditWholeCoins(earningsMicros);

  if ((session.schemaVersion ?? 0) < BILLING_SESSION_SCHEMA_VERSION && session.pricePerSecond) {
    const legacyDeductMicros = Math.round(billedSeconds * session.pricePerSecond * COIN_MICROS);
    totalDeducted = microsToUserDebitWholeCoins(legacyDeductMicros);
    const legacyEarnMicros = Math.round((earnRaw * COIN_MICROS) / 10000);
    totalEarnedCreator = microsToCreatorCreditWholeCoins(legacyEarnMicros);
  }

  const wallClockSeconds = Math.max(0, Math.floor((Date.now() - session.startTime) / 1000));

  logInfo('Settling call - Redis values read', {
    callId,
    elapsedSeconds: session.elapsedSeconds,
    billedSeconds,
    wallClockSeconds,
    durationSeconds,
    balanceMicros,
    totalDeducted,
    totalEarnedCreator,
    redisValues: {
      coinsRaw: finalCoinsRaw,
      earningsRaw: finalEarningsRaw,
      earningsMicros,
    },
  });

  const dbSession = await mongoose.startSession();
  dbSession.startTransaction();

  try {
    const user = await User.findById(session.userMongoId).session(dbSession);
    if (!user) {
      throw new Error(`User not found: ${session.userMongoId}`);
    }
    user.coins = Math.max(0, microsToWholeCoinsFloor(balanceMicros));
    await user.save({ session: dbSession });

    if (totalDeducted > 0) {
      await CoinTransaction.findOneAndUpdate(
        { callId, userId: session.userMongoId, type: 'debit' },
        {
          transactionId: `call_debit_${callId}`,
          userId: session.userMongoId,
          type: 'debit',
          coins: totalDeducted,
          source: 'video_call',
          description: `Video call (${durationSeconds}s) @ ${session.pricePerMinute} coins/min`,
          callId,
          status: 'completed',
        },
        { upsert: true, new: true, session: dbSession }
      );
    }

    let creatorUser: (mongoose.Document<unknown, {}, IUser> & IUser) | null = null;
    if (totalEarnedCreator > 0) {
      const creator = await Creator.findById(session.creatorMongoId).session(dbSession);
      if (!creator) {
        throw new Error(`Creator not found: ${session.creatorMongoId}`);
      }

      creatorUser = await User.findById(creator.userId).session(dbSession);
      if (!creatorUser) {
        throw new Error(`Creator user not found: ${creator.userId}`);
      }

      const creatorCoinsBefore = creatorUser.coins || 0;
      creatorUser.coins = Math.round(creatorCoinsBefore + totalEarnedCreator);
      await creatorUser.save({ session: dbSession });

      logInfo('Settling call - Creator coins updated', {
        callId,
        creatorMongoId: session.creatorMongoId,
        creatorUserId: creator.userId,
        coinsBefore: creatorCoinsBefore,
        coinsAfter: creatorUser.coins,
        coinsEarned: totalEarnedCreator,
      });

      await CoinTransaction.findOneAndUpdate(
        { callId, userId: creator.userId, type: 'credit' },
        {
          transactionId: `call_credit_${callId}`,
          userId: creator.userId,
          type: 'credit',
          coins: totalEarnedCreator,
          source: 'video_call',
          description: `Earned from video call (${durationSeconds}s)`,
          callId,
          status: 'completed',
        },
        { upsert: true, new: true, session: dbSession }
      );
    }

    const creatorDoc = await Creator.findById(session.creatorMongoId).session(dbSession);
    const userDoc = await User.findById(session.userMongoId).session(dbSession);
    const creatorUserDoc = creatorDoc
      ? await User.findById(creatorDoc.userId).session(dbSession)
      : null;

    const userName = userDoc?.username || userDoc?.phone || userDoc?.email || 'User';
    const creatorName = creatorDoc?.name || 'Creator';
    const userAvatar = userDoc?.avatar;
    const creatorAvatar = creatorDoc?.photo;
    const creatorOwnerUserId = creatorDoc?.userId;
    const creatorFirebaseUid = creatorUserDoc?.firebaseUid || session.creatorFirebaseUid;

    await CallHistory.findOneAndUpdate(
      { callId, ownerUserId: session.userMongoId },
      {
        callId,
        ownerUserId: session.userMongoId,
        otherUserId: creatorOwnerUserId || session.creatorMongoId,
        otherCreatorId: creatorDoc?._id,
        otherName: creatorName,
        otherAvatar: creatorAvatar,
        otherFirebaseUid: creatorFirebaseUid,
        ownerRole: 'user',
        durationSeconds,
        coinsDeducted: totalDeducted,
        coinsEarned: 0,
      },
      { upsert: true, new: true, session: dbSession }
    );

    if (creatorOwnerUserId) {
      await CallHistory.findOneAndUpdate(
        { callId, ownerUserId: creatorOwnerUserId },
        {
          callId,
          ownerUserId: creatorOwnerUserId,
          otherUserId: session.userMongoId,
          otherName: userName,
          otherAvatar: userAvatar,
          otherFirebaseUid: session.userFirebaseUid,
          ownerRole: 'creator',
          durationSeconds,
          coinsDeducted: 0,
          coinsEarned: totalEarnedCreator,
        },
        { upsert: true, new: true, session: dbSession }
      );
    }

    await dbSession.commitTransaction();
    logInfo('Settlement transaction committed', { callId });

    try {
      await deleteBillingSessionRedisKeys(
        redis,
        callId,
        session.userFirebaseUid,
        session.creatorFirebaseUid
      );
      await redis.setex(settledKey, SETTLED_CALL_TTL, '1');
    } catch (redisAfterCommitErr) {
      logError(
        'CRITICAL: Redis cleanup after successful Mongo settlement — balances are committed; clear keys via ops/reconciliation',
        redisAfterCommitErr,
        { callId, alert: true }
      );
    }

    io.to(`user:${session.userFirebaseUid}`).emit('coins_updated', {
      userId: user._id.toString(),
      coins: user.coins,
    });

    if (creatorUser) {
      io.to(`user:${session.creatorFirebaseUid}`).emit('coins_updated', {
        userId: creatorUser._id.toString(),
        coins: creatorUser.coins,
      });
    }

    try {
      const streamClient = getStreamClient();
      const channelId = generateUserCreatorChannelId(
        session.userFirebaseUid,
        session.creatorFirebaseUid
      );
      const channelName = creatorName;

      const channel = streamClient.channel('messaging', channelId, {
        members: [session.userFirebaseUid, session.creatorFirebaseUid],
        created_by_id: session.userFirebaseUid,
        name: channelName,
      });

      try {
        await channel.create();
      } catch (_) {
        /* non-fatal */
      }

      const durationLabel = formatDurationLabel(durationSeconds);
      const coinsSpent = totalDeducted;
      await channel.sendMessage({
        id: `call_activity_${callId}`,
        type: 'system',
        text: `Video call completed (${durationLabel}) • ${coinsSpent} coin${coinsSpent === 1 ? '' : 's'} spent`,
      });

      logInfo('Chat call activity message posted', { callId });
    } catch (chatErr) {
      logError('Failed to post call activity in chat', chatErr, { callId });
    }

    try {
      const creatorDoc2 = await Creator.findById(session.creatorMongoId);
      if (creatorDoc2) {
        await invalidateCreatorTasks(creatorDoc2.userId.toString());
        await invalidateCreatorDashboard(creatorDoc2.userId.toString());
      }
      await invalidateAdminCaches('overview', 'coins', 'creators_performance');
    } catch (cacheErr) {
      logError('Failed to invalidate caches', cacheErr, { callId });
    }

    io.to(`user:${session.userFirebaseUid}`).emit('billing:settled', {
      callId,
      finalCoins: user.coins,
      totalDeducted,
      durationSeconds,
    });

    io.to(`user:${session.creatorFirebaseUid}`).emit('billing:settled', {
      callId,
      totalEarned: totalEarnedCreator,
      durationSeconds,
    });

    try {
      const creatorDoc3 = await Creator.findById(session.creatorMongoId);
      if (creatorDoc3) {
        emitCreatorDataUpdated(session.creatorFirebaseUid, {
          reason: 'call_settled',
          callId,
          totalEarned: totalEarnedCreator,
          durationSeconds,
        });
      }
    } catch (emitErr) {
      logError('Failed to emit creator data update', emitErr, { callId });
    }

    verifyUserBalance(session.userMongoId).catch(() => {});
    const creatorDoc4 = await Creator.findById(session.creatorMongoId);
    if (creatorDoc4) verifyUserBalance(creatorDoc4.userId).catch(() => {});

    emitToAdmin('billing:settled', {
      callId,
      userFirebaseUid: session.userFirebaseUid,
      creatorFirebaseUid: session.creatorFirebaseUid,
      durationSeconds,
      coinsDeducted: totalDeducted,
      creatorEarned: totalEarnedCreator,
    });

    logInfo('Settlement complete', { callId });
  } catch (err) {
    try {
      await dbSession.abortTransaction();
      logError('Settlement transaction aborted', err, { callId });
      recordBillingMetric('settlement_transaction_failed', 1, { callId });
    } catch (abortErr) {
      logError('Failed to abort transaction', abortErr, { callId });
    }
    throw err;
  } finally {
    await dbSession.endSession();
    await redis.del(settleLockKey(callId)).catch(() => {});
  }
}
