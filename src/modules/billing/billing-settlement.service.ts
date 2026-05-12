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
  callUserIntroMicrosKey,
  callUserWalletMicrosKey,
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
import { buildAvatarUrls } from '../images/image-url';
import {
  COIN_MICROS,
  BILLING_SESSION_SCHEMA_VERSION,
  microsToUserDebitWholeCoins,
  microsToCreatorCreditWholeCoins,
} from './billing.constants';
import { billingService, finalFlushMarkerKey } from './billing.service';
import { getBillingCheckpoint } from './billing-checkpoint.service';
import { featureFlags } from '../../config/feature-flags';
import { isBdRole } from '../../utils/staff-roles';
import { StaffWalletLedger } from './staff-wallet-ledger.model';
import { resolveStaffCommissionBps } from '../payment/commission-resolve.service';
import { enqueueSettlementDomainEvents } from '../events/domain-event.service';

interface CallSession {
  schemaVersion?: number;
  billingVersion?: number;
  introPromoActive?: boolean;
  totalIntroDeductedMicros?: number;
  totalWalletDeductedMicros?: number;
  billingPricePerSecondMicros?: number;
  initialIntroMicros?: number;
  initialWalletMicros?: number;
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

function buildSettlementSessionFromCheckpoint(checkpoint: Record<string, unknown>, callId: string): CallSession | null {
  const userMongoId = String(checkpoint.userMongoId || '');
  const creatorMongoId = String(checkpoint.creatorMongoId || '');
  const userFirebaseUid = String(checkpoint.userFirebaseUid || '');
  const creatorFirebaseUid = String(checkpoint.creatorFirebaseUid || '');
  if (!userMongoId || !creatorMongoId || !userFirebaseUid || !creatorFirebaseUid) return null;

  const pricePerSecondMicros = Math.max(0, Number(checkpoint.pricePerSecondMicros) || 0);
  const startTimeMs = Number(checkpoint.startTimeMs) || Date.now();
  const lastProcessedAtMs = Number(checkpoint.lastProcessedAtMs) || startTimeMs;
  const totalDeductedMicros = Math.max(0, Number(checkpoint.totalDeductedMicros) || 0);
  const totalEarnedMicros = Math.max(0, Number(checkpoint.totalEarnedMicros) || 0);
  const elapsedSeconds =
    pricePerSecondMicros > 0 ? Math.floor(totalDeductedMicros / pricePerSecondMicros) : 0;
  const pricePerMinute =
    pricePerSecondMicros > 0 ? Math.round((pricePerSecondMicros * 60) / COIN_MICROS) : 0;

  return {
    schemaVersion: BILLING_SESSION_SCHEMA_VERSION,
    callId,
    userFirebaseUid,
    creatorFirebaseUid,
    userMongoId,
    creatorMongoId,
    pricePerMinute,
    pricePerSecondMicros,
    creatorEarningsPerSecondMicros: Math.max(
      0,
      Number(checkpoint.creatorEarningsPerSecondMicros) || 0
    ),
    startTime: startTimeMs,
    lastProcessedAt: lastProcessedAtMs,
    totalDeductedMicros,
    totalEarnedMicros,
    elapsedSeconds,
    effectiveDurationLimitSeconds: Number(checkpoint.effectiveDurationLimitSeconds) || undefined,
  };
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
const SETTLE_LOCK_TTL_SECONDS = 120;
const SETTLE_LOCK_HEARTBEAT_MS = 30_000;
const RELEASE_IF_MATCH_LUA = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0
`;

function callpairKey(uid1: string, uid2: string): string {
  const a = String(uid1 || '');
  const b = String(uid2 || '');
  const [min, max] = a <= b ? [a, b] : [b, a];
  return `callpair:${min}:${max}`;
}

/** Remove live billing keys only after Mongo commit (or idempotent cleanup). */
async function deleteBillingSessionRedisKeys(
  redis: ReturnType<typeof getRedis>,
  callId: string,
  userFirebaseUid: string,
  creatorFirebaseUid: string
): Promise<void> {
  const userSlotKey = activeCallByUserKey(userFirebaseUid);
  const creatorSlotKey = activeCallByUserKey(creatorFirebaseUid);
  const pairKey = callpairKey(userFirebaseUid, creatorFirebaseUid);
  await Promise.all([
    redis.del(callSessionKey(callId)),
    redis.del(callUserCoinsKey(callId)),
    redis.del(callUserIntroMicrosKey(callId)),
    redis.del(callUserWalletMicrosKey(callId)),
    redis.del(callCreatorEarningsKey(callId)),
    redis.eval(RELEASE_IF_MATCH_LUA, 1, userSlotKey, callId),
    redis.eval(RELEASE_IF_MATCH_LUA, 1, creatorSlotKey, callId),
    redis.eval(RELEASE_IF_MATCH_LUA, 1, pairKey, callId),
  ]);
}

export async function settleCall(io: Server, callId: string): Promise<void> {
  const redis = getRedis();
  const settleStartedAt = Date.now();

  const settledKey = settledCallKey(callId);
  if (await redis.get(settledKey)) {
    logWarning('Call already settled (Redis) — skipping', { callId });
    return;
  }

  await billingService.flushBillingToQuiescence(io, callId);
  const flushMarkerRaw = await redis.get(finalFlushMarkerKey(callId));
  if (!flushMarkerRaw) {
    recordBillingMetric('settlement_final_flush_marker_missing', 1, { callId });
    logWarning('Settlement proceeding without final flush marker', { callId });
  } else {
    recordBillingMetric('settlement_final_flush_marker_present', 1, { callId });
  }

  if (await redis.get(settledKey)) {
    logWarning('Call already settled (Redis) — skipping', { callId });
    return;
  }

  const lockToken = crypto.randomUUID();
  const settleLockRedisKey = settleLockKey(callId);
  const lockResult = await redis.set(settleLockRedisKey, lockToken, 'EX', SETTLE_LOCK_TTL_SECONDS, 'NX');
  const lockAcquired = lockResult === 'OK';
  if (!lockAcquired) {
    logWarning('Settlement already in progress / completed — skipping', { callId });
    return;
  }
  const lockHeartbeat = setInterval(() => {
    redis
      .set(settleLockRedisKey, lockToken, 'EX', SETTLE_LOCK_TTL_SECONDS, 'XX')
      .catch(() => {});
  }, SETTLE_LOCK_HEARTBEAT_MS);

  logInfo('Settling call - reading from Redis', {
    callId,
    redisKeys: {
      session: callSessionKey(callId),
      introMicros: callUserIntroMicrosKey(callId),
      walletMicros: callUserWalletMicrosKey(callId),
      earnings: callCreatorEarningsKey(callId),
    },
  });

  await removeCallFromBilling(callId);

  let sessionRaw: string | null;
  try {
    sessionRaw = await redis.get(callSessionKey(callId));
  } catch (redisError) {
    logError('CRITICAL: Redis error reading session during settlement', redisError, {
      callId,
      alert: true,
    });
    await redis.eval(RELEASE_IF_MATCH_LUA, 1, settleLockRedisKey, lockToken).catch(() => {});
    return;
  }

  if (!sessionRaw) {
    if (featureFlags.billingDeltaCursorV3Enabled) {
      const checkpoint = await getBillingCheckpoint(callId);
      const checkpointSession = checkpoint
        ? buildSettlementSessionFromCheckpoint(checkpoint as Record<string, unknown>, callId)
        : null;
      if (checkpointSession) {
        sessionRaw = JSON.stringify(checkpointSession);
      }
    }
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
    await redis.eval(RELEASE_IF_MATCH_LUA, 1, settleLockRedisKey, lockToken).catch(() => {});
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
    await redis.eval(RELEASE_IF_MATCH_LUA, 1, settleLockRedisKey, lockToken).catch(() => {});
    return;
  }

  let finalCoinsRaw: string | null;
  let finalEarningsRaw: string | null;

  try {
    const [introR, walletR, legacyMerged, earnR] = await Promise.all([
      redis.get(callUserIntroMicrosKey(callId)),
      redis.get(callUserWalletMicrosKey(callId)),
      redis.get(callUserCoinsKey(callId)),
      redis.get(callCreatorEarningsKey(callId)),
    ]);
    finalEarningsRaw = earnR;
    let introRemain = Math.max(0, parseInt(String(introR ?? '0'), 10) || 0);
    let walletRemain = Math.max(0, parseInt(String(walletR ?? '0'), 10) || 0);
    if (introR === null && walletR === null && legacyMerged !== null && legacyMerged !== undefined) {
      walletRemain = Math.max(0, parseInt(String(legacyMerged), 10) || 0);
      introRemain = 0;
    }
    finalCoinsRaw = String(introRemain + walletRemain);
  } catch (redisError) {
    logError('CRITICAL: Redis error reading coins/earnings during settlement', redisError, {
      callId,
      alert: true,
    });
    await redis.eval(RELEASE_IF_MATCH_LUA, 1, settleLockRedisKey, lockToken).catch(() => {});
    return;
  }

  if (featureFlags.billingDeltaCursorV3Enabled && (finalCoinsRaw === null || finalEarningsRaw === null)) {
    const checkpoint = await getBillingCheckpoint(callId);
    if (checkpoint) {
      if (finalCoinsRaw === null) {
        finalCoinsRaw = String(Number((checkpoint as any).remainingUserBalanceMicros || 0));
      }
      if (finalEarningsRaw === null) {
        finalEarningsRaw = String(Number((checkpoint as any).totalEarnedMicros || 0));
      }
    }
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

  const introDeductedMicros = Math.max(0, Number(session.totalIntroDeductedMicros) || 0);
  let walletDeductedMicros = session.totalWalletDeductedMicros;
  if (walletDeductedMicros === undefined || walletDeductedMicros === null) {
    walletDeductedMicros = Math.max(0, (session.totalDeductedMicros ?? 0) - introDeductedMicros);
  }

  let totalDeducted = microsToUserDebitWholeCoins(session.totalDeductedMicros ?? 0);
  let totalEarnedCreator = microsToCreatorCreditWholeCoins(earningsMicros);
  const sessionEarnedMicros = Number(session.totalEarnedMicros ?? 0);
  const settlementMicrosDiff = Math.abs(sessionEarnedMicros - earningsMicros);
  recordBillingMetric('settlement_redis_session_earned_diff_micros', settlementMicrosDiff, { callId });
  if (settlementMicrosDiff > COIN_MICROS) {
    recordBillingMetric('settlement_redis_session_earned_diff_alert', 1, { callId });
    logWarning('Settlement earned discrepancy above threshold', {
      callId,
      sessionEarnedMicros,
      redisEarnedMicros: earningsMicros,
      diffMicros: settlementMicrosDiff,
    });
  }

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

  let mongoTransactionCommitted = false;

  try {
    const user = await User.findById(session.userMongoId).session(dbSession);
    if (!user) {
      throw new Error(`User not found: ${session.userMongoId}`);
    }

    const targetWalletDebitWhole = Math.max(0, microsToUserDebitWholeCoins(walletDeductedMicros));
    const existingUserDebitTxn = await CoinTransaction.findOne({
      callId,
      userId: session.userMongoId,
      type: 'debit',
    }).session(dbSession);
    const alreadyDebited = Math.max(0, existingUserDebitTxn?.coins || 0);
    const userDebitDelta = Math.max(0, targetWalletDebitWhole - alreadyDebited);

    let updatedUserCoins = user.coins || 0;
    if (userDebitDelta > 0) {
      const updatedUser = await User.findByIdAndUpdate(
        user._id,
        [
          {
            $set: {
              coins: {
                $max: [0, { $subtract: ['$coins', userDebitDelta] }],
              },
            },
          },
        ],
        {
          new: true,
          session: dbSession,
        }
      );
      if (!updatedUser) {
        throw new Error(`User not found during debit update: ${session.userMongoId}`);
      }
      updatedUserCoins = updatedUser.coins || 0;
    }

    if (targetWalletDebitWhole > 0) {
      await CoinTransaction.findOneAndUpdate(
        { callId, userId: session.userMongoId, type: 'debit' },
        {
          transactionId: `call_debit_${callId}`,
          userId: session.userMongoId,
          type: 'debit',
          coins: targetWalletDebitWhole,
          source: 'video_call',
          description: `Video call (${durationSeconds}s) @ ${session.pricePerMinute} coins/min`,
          callId,
          status: 'completed',
        },
        { upsert: true, new: true, session: dbSession }
      );
    }

    if (session.introPromoActive === true && introDeductedMicros > 0) {
      await User.findOneAndUpdate(
        {
          _id: user._id,
          welcomeFreeCallConsumedAt: null,
          introFreeCallCredits: { $gt: 0 },
        },
        {
          $set: {
            welcomeFreeCallConsumedAt: new Date(),
            introFreeCallCredits: 0,
          },
        },
        { session: dbSession }
      );
    }

    let creatorUser: (mongoose.Document<unknown, object, IUser> & IUser) | null = null;
    if (totalEarnedCreator > 0) {
      // Settlement safety rule: do not hard-fail settlement if creator docs are missing.
      // We settle conservatively (user debit) and alert via logs/metrics for reconciliation.
      try {
        const creator = await Creator.findById(session.creatorMongoId).session(dbSession);
        if (!creator) {
          logWarning('Creator missing during settlement; settling without creator credit', {
            callId,
            creatorMongoId: session.creatorMongoId,
          });
          totalEarnedCreator = 0;
        } else {
          creatorUser = await User.findById(creator.userId).session(dbSession);
          if (!creatorUser) {
            logWarning('Creator user missing during settlement; settling without creator credit', {
              callId,
              creatorUserId: creator.userId?.toString(),
            });
            totalEarnedCreator = 0;
          } else {
            const existingCreatorCreditTxn = await CoinTransaction.findOne({
              callId,
              userId: creator.userId,
              type: 'credit',
            }).session(dbSession);
            const alreadyCredited = Math.max(0, existingCreatorCreditTxn?.coins || 0);
            const targetCreatorCredit = Math.max(0, totalEarnedCreator);
            const creatorCreditDelta = Math.max(0, targetCreatorCredit - alreadyCredited);

            let creatorCoinsBefore = creatorUser.coins || 0;
            if (creatorCreditDelta > 0) {
              const updatedCreatorUser = await User.findByIdAndUpdate(
                creatorUser._id,
                { $inc: { coins: creatorCreditDelta } },
                { new: true, session: dbSession }
              );
              if (!updatedCreatorUser) {
                logWarning('Creator user missing during credit update; skipping creator credit', {
                  callId,
                  creatorUserId: creator.userId?.toString(),
                });
                totalEarnedCreator = 0;
              } else {
                creatorCoinsBefore = Math.max(
                  0,
                  (updatedCreatorUser.coins || 0) - creatorCreditDelta
                );
                creatorUser = updatedCreatorUser;
              }
            }

            if (totalEarnedCreator > 0) {
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

              // Staff revenue: BD/agency % of host-earned coins (gross). Snapshots stored on ledger rows.
              const bdOid = creator.assignedAgentId;
              if (bdOid && totalEarnedCreator > 0) {
                const bdUser = await User.findById(bdOid)
                  .select('role agencyId')
                  .session(dbSession)
                  .lean();
                if (bdUser && isBdRole(bdUser.role)) {
                  const rates = await resolveStaffCommissionBps({
                    bdUserId: bdOid as mongoose.Types.ObjectId,
                    agencyId: bdUser.agencyId ?? null,
                  });
                  const bdBpsSnap = rates.bdBps;
                  const agencyBpsSnap = rates.agencyBps;
                  const bdCut = Math.floor((totalEarnedCreator * bdBpsSnap) / 10000);
                  const agencyCut =
                    bdUser.agencyId != null
                      ? Math.floor((totalEarnedCreator * agencyBpsSnap) / 10000)
                      : 0;

                  const bdKey = `staff_ledger_call_${callId}_bd_credit`;
                  const agKey = `staff_ledger_call_${callId}_agency_credit`;

                  if (bdCut > 0) {
                    const existingBdLine = await StaffWalletLedger.findOne({ idempotencyKey: bdKey })
                      .session(dbSession)
                      .select('_id')
                      .lean();
                    if (!existingBdLine) {
                      const bdAfterDoc = await User.findByIdAndUpdate(
                        bdOid,
                        { $inc: { staffCoinsBalance: bdCut } },
                        { new: true, session: dbSession }
                      )
                        .select('staffCoinsBalance')
                        .lean();
                      await StaffWalletLedger.create(
                        [
                          {
                            staffUserId: bdOid,
                            direction: 'credit',
                            amountCoins: bdCut,
                            balanceAfter: bdAfterDoc?.staffCoinsBalance,
                            sourceType: 'call_settlement',
                            callId,
                            hostUserId: creator.userId as mongoose.Types.ObjectId,
                            creatorMongoId: creator._id,
                            bdUserId: bdOid,
                            ...(bdUser.agencyId
                              ? { agencyUserId: bdUser.agencyId as mongoose.Types.ObjectId }
                              : {}),
                            bdBpsSnapshot: bdBpsSnap,
                            agencyBpsSnapshot: agencyBpsSnap,
                            description: `BD share from call`,
                            idempotencyKey: bdKey,
                          },
                        ],
                        { session: dbSession }
                      );
                    }
                  }

                  if (agencyCut > 0 && bdUser.agencyId) {
                    const agOid = bdUser.agencyId;
                    const existingAgLine = await StaffWalletLedger.findOne({ idempotencyKey: agKey })
                      .session(dbSession)
                      .select('_id')
                      .lean();
                    if (!existingAgLine) {
                      const agAfterDoc = await User.findByIdAndUpdate(
                        agOid,
                        { $inc: { staffCoinsBalance: agencyCut } },
                        { new: true, session: dbSession }
                      )
                        .select('staffCoinsBalance')
                        .lean();
                      await StaffWalletLedger.create(
                        [
                          {
                            staffUserId: agOid,
                            direction: 'credit',
                            amountCoins: agencyCut,
                            balanceAfter: agAfterDoc?.staffCoinsBalance,
                            sourceType: 'call_settlement',
                            callId,
                            hostUserId: creator.userId as mongoose.Types.ObjectId,
                            creatorMongoId: creator._id,
                            bdUserId: bdOid,
                            agencyUserId: agOid,
                            bdBpsSnapshot: bdBpsSnap,
                            agencyBpsSnapshot: agencyBpsSnap,
                            description: `Agency share from call`,
                            idempotencyKey: agKey,
                          },
                        ],
                        { session: dbSession }
                      );
                    }
                  }
                }
              }
            }
          }
        }
      } catch (e) {
        logError('Creator settlement credit failed; proceeding without creator credit', e, { callId });
        totalEarnedCreator = 0;
        creatorUser = null;
      }
    }

    const creatorDoc = await Creator.findById(session.creatorMongoId).session(dbSession);
    const userDoc = await User.findById(session.userMongoId).session(dbSession);
    const creatorUserDoc = creatorDoc
      ? await User.findById(creatorDoc.userId).session(dbSession)
      : null;

    const userName = userDoc?.username || userDoc?.phone || userDoc?.email || 'User';
    const creatorName = creatorDoc?.name || 'Creator';
    // CallHistory stores avatars as string URLs; resolve the medium avatar
    // variant from the canonical IImageAsset (post Phase E removal of
    // `creator.photo` / legacy `user.avatar` string fields).
    const userAvatar = userDoc?.avatar?.imageId
      ? buildAvatarUrls(userDoc.avatar.imageId).md
      : undefined;
    const creatorAvatar = creatorDoc?.avatar?.imageId
      ? buildAvatarUrls(creatorDoc.avatar.imageId).md
      : undefined;
    const creatorOwnerUserId = creatorDoc?.userId;
    const creatorFirebaseUid = creatorUserDoc?.firebaseUid || session.creatorFirebaseUid;

    const initiatedByRole = (session as any).initiatedByRole as string | undefined;
    const creatorInitiated = initiatedByRole === 'creator' || initiatedByRole === 'admin';
    const userDirection = creatorInitiated ? 'incoming' : 'outgoing';
    const creatorDirection = creatorInitiated ? 'outgoing' : 'incoming';

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
        direction: userDirection,
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
          direction: creatorDirection,
          durationSeconds,
          coinsDeducted: 0,
          coinsEarned: totalEarnedCreator,
        },
        { upsert: true, new: true, session: dbSession }
      );
    }

    const txnStartedAt = Date.now();
    await dbSession.commitTransaction();
    mongoTransactionCommitted = true;
    recordBillingMetric('settlement_transaction_ms', Date.now() - txnStartedAt, { callId });
    logInfo('Settlement transaction committed', { callId });

    void enqueueSettlementDomainEvents({
      callId,
      totalEarnedCreator,
      durationSeconds,
    }).catch((err) =>
      logError('enqueueSettlementDomainEvents failed', err instanceof Error ? err : new Error(String(err)), {
        callId,
      })
    );

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
      coins: updatedUserCoins,
    });

    if (creatorUser) {
      io.to(`user:${session.creatorFirebaseUid}`).emit('coins_updated', {
        userId: creatorUser._id.toString(),
        coins: creatorUser.coins,
      });
    }

    const postCommitStartedAt = Date.now();
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

    io.to(`user:${session.userFirebaseUid}`).emit('billing:settled', {
      callId,
      finalCoins: updatedUserCoins,
      totalDeducted,
      durationSeconds,
    });

    io.to(`user:${session.creatorFirebaseUid}`).emit('billing:settled', {
      callId,
      totalEarned: totalEarnedCreator,
      durationSeconds,
    });

    const sideEffects: Promise<unknown>[] = [
      invalidateAdminCaches('overview', 'coins', 'creators_performance'),
      verifyUserBalance(session.userMongoId),
    ];
    if (creatorOwnerUserId) {
      sideEffects.push(invalidateCreatorTasks(creatorOwnerUserId.toString()));
      sideEffects.push(invalidateCreatorDashboard(creatorOwnerUserId.toString()));
      sideEffects.push(verifyUserBalance(creatorOwnerUserId.toString()));
      sideEffects.push(
        Promise.resolve().then(() =>
          emitCreatorDataUpdated(session.creatorFirebaseUid, {
            reason: 'call_settled',
            callId,
            totalEarned: totalEarnedCreator,
            durationSeconds,
          })
        )
      );
    }
    const sideEffectResults = await Promise.allSettled(sideEffects);
    const sideEffectFailures = sideEffectResults.filter((r) => r.status === 'rejected').length;
    if (sideEffectFailures > 0) {
      logWarning('Some post-settlement side effects failed', { callId, sideEffectFailures });
    }
    recordBillingMetric('settlement_post_commit_ms', Date.now() - postCommitStartedAt, { callId });

    emitToAdmin('billing:settled', {
      callId,
      userFirebaseUid: session.userFirebaseUid,
      creatorFirebaseUid: session.creatorFirebaseUid,
      durationSeconds,
      coinsDeducted: totalDeducted,
      creatorEarned: totalEarnedCreator,
    });

    logInfo('Settlement complete', { callId });
    recordBillingMetric('settlement_total_ms', Date.now() - settleStartedAt, { callId });
  } catch (err) {
    try {
      await dbSession.abortTransaction();
      logError('Settlement transaction aborted', err, { callId });
      recordBillingMetric('settlement_transaction_failed', 1, { callId });
    } catch (abortErr) {
      logError('Failed to abort transaction', abortErr, { callId });
    }
    if (!mongoTransactionCommitted) {
      try {
        await redis.del(settledKey);
      } catch {
        /* allow settlement retry if a mistaken settled flag was set pre-commit */
      }
    }
    throw err;
  } finally {
    clearInterval(lockHeartbeat);
    await dbSession.endSession();
    await redis.eval(RELEASE_IF_MATCH_LUA, 1, settleLockRedisKey, lockToken).catch(() => {});
  }
}
