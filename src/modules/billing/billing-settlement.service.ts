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
  activeCallByUserKey,
  settledCallKey,
  SETTLED_CALL_TTL,
  isInvalidBillingCallId,
} from '../../config/redis';
import { User, IUser } from '../user/user.model';
import { Creator } from '../creator/creator.model';
import { CoinTransaction } from '../user/coin-transaction.model';
import { CallHistory } from './call-history.model';
import { Call } from '../video/call.model';
import { emitCreatorDataUpdated } from '../creator/creator.controller';
import { verifyUserBalance } from '../../utils/balance-integrity';
import { emitStaffDomainEvent, setCreatorStaffScope } from '../staff/staff-dashboard-invalidation.service';
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
import { isAgencyRole } from '../../utils/staff-roles';
import { StaffWalletLedger } from './staff-wallet-ledger.model';
import { resolveStaffCommissionBps } from '../payment/commission-resolve.service';
import { computeStaffCutsFromHostEarnings } from './staff-revenue-share';
import { enqueueSettlementDomainEvents } from '../events/domain-event.service';
import { cancelBillingCycleJob } from './billing.queue';

function throwSettlementTxnError(err: unknown, lastTxnId?: string): never {
  const wrapped = err instanceof Error ? err : new Error(String(err));
  if (lastTxnId) {
    (wrapped as { lastTxnId?: string }).lastTxnId = lastTxnId;
  }
  throw wrapped;
}
import { emitBillingSettledFromSnapshot } from './billing-emitter.service';
import { flushBillingPersist } from './billing-persist.service';
import { sumLedgerForCall } from './billing-ledger.model';
import { isIncrementalBillingPersistEnabled } from './billing-phase-flags';
import {
  classifyFailureStage,
  getMongoErrorCode,
  getMongoErrorLabels,
  getMongoErrorName,
  inferConflictingCollection,
  isTransientMongoTransactionError,
  isUnknownCommitResult,
  settlementTxnBackoffMs,
  sleepMs,
  type SettlementWriteStage,
} from '../../utils/mongo-transaction';
import {
  resolveAuthoritativeSettlementTotals,
  applyAuthoritativeTotalsToSession,
} from './billing-settlement-totals.service';

const SETTLEMENT_TXN_MAX_ATTEMPTS = 3;

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
  billingSequence?: number;
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

export async function removeCallFromBilling(callId: string): Promise<void> {
  await cancelBillingCycleJob(callId);
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
export async function deleteBillingSessionRedisKeys(
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

export interface SettleCallFromFinalizerOptions {
  _fromFinalizer: true;
  lockToken: string;
  settleLockRedisKey: string;
  suppressSettledEmit?: boolean;
  /** Settlement source for instrumentation (billing_tick, force_end, etc.) */
  source?: string;
}

export interface SettlePersistResult {
  totalDeducted: number;
  walletCoinsDeducted: number;
  totalEarnedCreator: number;
  durationSeconds: number;
  userFirebaseUid: string;
  creatorFirebaseUid: string;
  userMongoId: string;
  billingSequence: number;
  finalUserCoins: number;
  lastTxnId?: string;
}

/**
 * Financial persistence for a billed call. When invoked by finalizeCallSession, orchestration
 * (flush, locks, ZSET removal, Redis cleanup) is handled by the finalizer.
 */
export async function settleCall(
  io: Server,
  callId: string,
  opts?: SettleCallFromFinalizerOptions
): Promise<SettlePersistResult | void> {
  const fromFinalizer = opts?._fromFinalizer === true;
  if (isInvalidBillingCallId(callId)) {
    logWarning('settlement rejected invalid tombstone callId suffix', { callId });
    recordBillingMetric('settlement_invalid_call_id', 1, { callId });
    return;
  }
  const redis = getRedis();
  const settleStartedAt = Date.now();

  const settledKey = settledCallKey(callId);
  if (!fromFinalizer) {
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
  }

  const lockToken = fromFinalizer ? opts!.lockToken : crypto.randomUUID();
  const settleLockRedisKey = fromFinalizer ? opts!.settleLockRedisKey : settleLockKey(callId);
  let lockHeartbeat: ReturnType<typeof setInterval> | undefined;
  if (!fromFinalizer) {
    const lockResult = await redis.set(settleLockRedisKey, lockToken, 'EX', SETTLE_LOCK_TTL_SECONDS, 'NX');
    const lockAcquired = lockResult === 'OK';
    if (!lockAcquired) {
      logWarning('Settlement already in progress / completed — skipping', { callId });
      return;
    }
    lockHeartbeat = setInterval(() => {
      redis
        .set(settleLockRedisKey, lockToken, 'EX', SETTLE_LOCK_TTL_SECONDS, 'XX')
        .catch(() => {});
    }, SETTLE_LOCK_HEARTBEAT_MS);
  }

  logInfo('Settling call - reading from Redis', {
    callId,
    redisKeys: {
      session: callSessionKey(callId),
      introMicros: callUserIntroMicrosKey(callId),
      walletMicros: callUserWalletMicrosKey(callId),
      earnings: callCreatorEarningsKey(callId),
    },
  });

  if (!fromFinalizer) {
    await removeCallFromBilling(callId);
  }

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
    const mongoAlready = await CallHistory.findOne({ callId, ownerRole: 'user' })
      .select('settlementStatus settledAt coinsDeducted')
      .lean();
    if (
      mongoAlready &&
      (mongoAlready.settlementStatus === 'settled' ||
        mongoAlready.settledAt ||
        (mongoAlready.settlementStatus !== 'pending' && (mongoAlready.coinsDeducted ?? 0) > 0))
    ) {
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

  if (isIncrementalBillingPersistEnabled()) {
    try {
      await flushBillingPersist(
        callId,
        session as import('./billing.service').CallSession,
        'call_end'
      );
      const ledgerSum = await sumLedgerForCall(callId);
      if (ledgerSum.tickCount > 0) {
        const introDeductedMicros = Math.max(0, Number(session.totalIntroDeductedMicros) || 0);
        session.totalDeductedMicros = ledgerSum.userDebitMicros;
        session.totalEarnedMicros = ledgerSum.creatorCreditMicros;
        session.totalWalletDeductedMicros = Math.max(
          0,
          ledgerSum.userDebitMicros - introDeductedMicros
        );
        recordBillingMetric('settlement_ledger_authoritative', 1, { callId });
        logInfo('Settlement using ledger-authoritative totals', {
          callId,
          ledgerUserDebitMicros: ledgerSum.userDebitMicros,
          ledgerCreatorCreditMicros: ledgerSum.creatorCreditMicros,
          tickCount: ledgerSum.tickCount,
        });
      }
    } catch (ledgerErr) {
      logWarning('Settlement ledger flush/reconcile failed — falling back to Redis session totals', {
        callId,
        error: ledgerErr instanceof Error ? ledgerErr.message : String(ledgerErr),
      });
    }
  }

  const existingUserHistory = await CallHistory.findOne({
    callId,
    ownerUserId: session.userMongoId,
  })
    .select('settlementStatus settledAt coinsDeducted')
    .lean();
  if (
    existingUserHistory &&
    (existingUserHistory.settlementStatus === 'settled' ||
      existingUserHistory.settledAt ||
      (existingUserHistory.settlementStatus !== 'pending' &&
        (existingUserHistory.coinsDeducted ?? 0) > 0))
  ) {
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
  let durationSeconds = billedSeconds;

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

  const authoritativeTotals = await resolveAuthoritativeSettlementTotals(callId);
  const mergedSession = applyAuthoritativeTotalsToSession(session, authoritativeTotals);
  session.totalDeductedMicros = mergedSession.totalDeductedMicros;
  session.totalEarnedMicros = mergedSession.totalEarnedMicros;
  (session as { billingSequence?: number }).billingSequence = mergedSession.billingSequence;
  if (mergedSession.elapsedSeconds != null) {
    session.elapsedSeconds = mergedSession.elapsedSeconds;
  }

  durationSeconds = Math.max(0, Math.floor(Number(session.elapsedSeconds) || 0));
  walletDeductedMicros =
    session.totalWalletDeductedMicros ??
    Math.max(0, (session.totalDeductedMicros ?? 0) - introDeductedMicros);
  totalEarnedCreator = microsToCreatorCreditWholeCoins(session.totalEarnedMicros ?? 0);
  totalDeducted = microsToUserDebitWholeCoins(session.totalDeductedMicros ?? 0);
  const walletCoinsDeducted = microsToUserDebitWholeCoins(walletDeductedMicros);

  if (
    authoritativeTotals.source === 'none' &&
    (session.schemaVersion ?? 0) < BILLING_SESSION_SCHEMA_VERSION &&
    session.pricePerSecond
  ) {
    const legacyDeductMicros = Math.round(billedSeconds * session.pricePerSecond * COIN_MICROS);
    totalDeducted = microsToUserDebitWholeCoins(legacyDeductMicros);
    const legacyEarnMicros = Math.round((earnRaw * COIN_MICROS) / 10000);
    totalEarnedCreator = microsToCreatorCreditWholeCoins(legacyEarnMicros);
  }

  if (authoritativeTotals.source !== 'none' && authoritativeTotals.totalDeductedMicros > 0) {
    recordBillingMetric('settlement_authoritative_totals_applied', 1, {
      callId,
      source: authoritativeTotals.source,
    });
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
    walletDeductedMicros,
    authoritativeSource: authoritativeTotals.source,
    redisValues: {
      coinsRaw: finalCoinsRaw,
      earningsRaw: finalEarningsRaw,
      earningsMicros,
    },
  });

  const settlementSource = opts?.source ?? (fromFinalizer ? 'finalizer' : 'direct_settle');
  let lastTxnId: string | undefined;
  let txnPersistSucceeded = false;
  let updatedUserCoins = 0;
  let creatorUser: (mongoose.Document<unknown, object, IUser> & IUser) | null = null;
  let userForEmit: IUser | null = null;
  let settlementBdId: string | undefined;
  let settlementAgencyId: string | undefined;
  let creatorOwnerUserId: mongoose.Types.ObjectId | string | undefined;
  let creatorName = 'Creator';

  for (let attempt = 0; attempt < SETTLEMENT_TXN_MAX_ATTEMPTS; attempt++) {
    const txnId = `${callId}:${attempt}:${crypto.randomUUID()}`;
    lastTxnId = txnId;
    const dbSession = await mongoose.startSession();
    dbSession.startTransaction();

    let mongoTransactionCommitted = false;
    let writeStage: SettlementWriteStage = 'read_user';
    const settlementIntegritySnapshot: {
      userCoinsBefore?: number;
      userCoinsAfter?: number;
      userDebitDelta?: number;
      expectedUserCoinsAfter?: number;
      creatorCoinsBefore?: number;
      creatorCoinsAfter?: number;
      creatorCreditDelta?: number;
      expectedCreatorCoinsAfter?: number;
    } = {};

    logInfo('settlement_transaction_attempt', {
      txnId,
      callId,
      attempt,
      source: settlementSource,
    });

    try {
      logInfo('settlement_transaction_stage', { txnId, callId, attempt, writeStage });
      const user = await User.findById(session.userMongoId).session(dbSession);
      if (!user) {
        throw new Error(`User not found: ${session.userMongoId}`);
      }
      userForEmit = user;

      const targetWalletDebitWhole = Math.max(0, microsToUserDebitWholeCoins(walletDeductedMicros));
      const existingUserDebitTxn = await CoinTransaction.findOne({
        callId,
        userId: session.userMongoId,
        type: 'debit',
      }).session(dbSession);
      const alreadyDebited = Math.max(0, existingUserDebitTxn?.coins || 0);
      const userDebitDelta = Math.max(0, targetWalletDebitWhole - alreadyDebited);
      const userCoinsBefore = Number(user.coins) || 0;
      settlementIntegritySnapshot.userCoinsBefore = userCoinsBefore;
      settlementIntegritySnapshot.userDebitDelta = userDebitDelta;
      settlementIntegritySnapshot.expectedUserCoinsAfter = Math.max(0, userCoinsBefore - userDebitDelta);

      writeStage = 'debit_user_wallet';
      logInfo('settlement_transaction_stage', { txnId, callId, attempt, writeStage });
      let localUpdatedUserCoins = user.coins || 0;
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
        localUpdatedUserCoins = updatedUser.coins || 0;
      }
      updatedUserCoins = localUpdatedUserCoins;
      settlementIntegritySnapshot.userCoinsAfter = Number(updatedUserCoins) || 0;

      writeStage = 'upsert_user_debit_txn';
      logInfo('settlement_transaction_stage', { txnId, callId, attempt, writeStage });
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
        writeStage = 'consume_intro_promo';
        logInfo('settlement_transaction_stage', { txnId, callId, attempt, writeStage });
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

      creatorUser = null;
      let creatorCreditDeltaApplied = 0;
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
            creatorCreditDeltaApplied = creatorCreditDelta;
            settlementIntegritySnapshot.creatorCreditDelta = creatorCreditDelta;

            let creatorCoinsBefore = creatorUser.coins || 0;
            settlementIntegritySnapshot.creatorCoinsBefore = Number(creatorCoinsBefore) || 0;
            if (creatorCreditDelta > 0) {
              writeStage = 'credit_creator_wallet';
              logInfo('settlement_transaction_stage', { txnId, callId, attempt, writeStage });
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
            if (creatorUser) {
              settlementIntegritySnapshot.creatorCoinsAfter = Number(creatorUser.coins) || 0;
              settlementIntegritySnapshot.expectedCreatorCoinsAfter =
                Math.max(0, Number(settlementIntegritySnapshot.creatorCoinsBefore) || 0) +
                creatorCreditDeltaApplied;
            }

            if (totalEarnedCreator > 0) {
              logInfo('Settling call - Creator coins updated', {
                callId,
                txnId,
                creatorMongoId: session.creatorMongoId,
                creatorUserId: creator.userId,
                coinsBefore: creatorCoinsBefore,
                coinsAfter: creatorUser.coins,
                coinsEarned: totalEarnedCreator,
              });

              writeStage = 'upsert_creator_credit_txn';
              logInfo('settlement_transaction_stage', { txnId, callId, attempt, writeStage });
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
              writeStage = 'staff_revenue_split';
              logInfo('settlement_transaction_stage', { txnId, callId, attempt, writeStage });
              const agencyOid = creator.assignedAgencyId;
              if (agencyOid && totalEarnedCreator > 0) {
                const agencyUser = await User.findById(agencyOid)
                  .select('role bdId')
                  .session(dbSession)
                  .lean();
                if (agencyUser && isAgencyRole(agencyUser.role)) {
                  settlementAgencyId = agencyOid.toString();
                  const bdOid = agencyUser.bdId;
                  if (bdOid) {
                    settlementBdId = bdOid.toString();
                  }
                  void setCreatorStaffScope(session.creatorFirebaseUid, {
                    bdId: settlementBdId,
                    agencyId: settlementAgencyId,
                  });
                  const rates = await resolveStaffCommissionBps({
                    bdUserId: (bdOid ?? agencyOid) as mongoose.Types.ObjectId,
                    bdId: agencyOid,
                  });
                  const bdBpsSnap = rates.bdBps;
                  const agencyBpsSnap = rates.agencyBps;
                  const { bdCut, agencyCut } = computeStaffCutsFromHostEarnings(
                    totalEarnedCreator,
                    bdBpsSnap,
                    agencyBpsSnap,
                    bdOid != null
                  );

                  const bdKey = `staff_ledger_call_${callId}_bd_credit`;
                  const agKey = `staff_ledger_call_${callId}_agency_credit`;

                  if (bdCut > 0 && bdOid) {
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
                            agencyUserId: agencyOid,
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

                  if (agencyCut > 0) {
                    const existingAgLine = await StaffWalletLedger.findOne({ idempotencyKey: agKey })
                      .session(dbSession)
                      .select('_id')
                      .lean();
                    if (!existingAgLine) {
                      const agAfterDoc = await User.findByIdAndUpdate(
                        agencyOid,
                        { $inc: { staffCoinsBalance: agencyCut } },
                        { new: true, session: dbSession }
                      )
                        .select('staffCoinsBalance')
                        .lean();
                      await StaffWalletLedger.create(
                        [
                          {
                            staffUserId: agencyOid,
                            direction: 'credit',
                            amountCoins: agencyCut,
                            balanceAfter: agAfterDoc?.staffCoinsBalance,
                            sourceType: 'call_settlement',
                            hostUserId: creator.userId as mongoose.Types.ObjectId,
                            creatorMongoId: creator._id,
                            bdUserId: bdOid ?? agencyOid,
                            agencyUserId: agencyOid,
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
    creatorName = creatorDoc?.name || 'Creator';
    // CallHistory stores avatars as string URLs; resolve the medium avatar
    // variant from the canonical IImageAsset (post Phase E removal of
    // `creator.photo` / legacy `user.avatar` string fields).
    const userAvatar = userDoc?.avatar?.imageId
      ? buildAvatarUrls(userDoc.avatar.imageId).md
      : undefined;
    const creatorAvatar = creatorDoc?.avatar?.imageId
      ? buildAvatarUrls(creatorDoc.avatar.imageId).md
      : undefined;
    const creatorOwnerUserIdLocal = creatorDoc?.userId;
    creatorOwnerUserId = creatorOwnerUserIdLocal;
    const creatorFirebaseUid = creatorUserDoc?.firebaseUid || session.creatorFirebaseUid;

    const initiatedByRole = (session as any).initiatedByRole as string | undefined;
    const creatorInitiated = initiatedByRole === 'creator' || initiatedByRole === 'admin';
    const userDirection = creatorInitiated ? 'incoming' : 'outgoing';
    const creatorDirection = creatorInitiated ? 'outgoing' : 'incoming';

    writeStage = 'upsert_call_history';
    logInfo('settlement_transaction_stage', { txnId, callId, attempt, writeStage });
    const callLifecycle = await Call.findOne({ callId })
      .select('startedAt endedAt settlement.settledAt')
      .session(dbSession)
      .lean();
    const settledAt = new Date();
    const callStartedAt = callLifecycle?.startedAt ?? new Date(session.startTime);
    const callEndedAt = callLifecycle?.endedAt ?? settledAt;
    const callTimestampFields = {
      callStartedAt,
      callEndedAt,
      settledAt,
    };

    await CallHistory.findOneAndUpdate(
      { callId, ownerUserId: session.userMongoId },
      {
        callId,
        ownerUserId: session.userMongoId,
        otherUserId: creatorOwnerUserIdLocal || session.creatorMongoId,
        otherCreatorId: creatorDoc?._id,
        otherName: creatorName,
        otherAvatar: creatorAvatar,
        otherFirebaseUid: creatorFirebaseUid,
        ownerRole: 'user',
        direction: userDirection,
        durationSeconds,
        ...callTimestampFields,
        settlementStatus: 'settled',
        coinsDeducted: totalDeducted,
        walletCoinsDeducted,
        coinsEarned: 0,
      },
      { upsert: true, new: true, session: dbSession }
    );

    if (creatorOwnerUserIdLocal) {
      await CallHistory.findOneAndUpdate(
        { callId, ownerUserId: creatorOwnerUserIdLocal },
        {
          callId,
          ownerUserId: creatorOwnerUserIdLocal,
          otherUserId: session.userMongoId,
          otherName: userName,
          otherAvatar: userAvatar,
          otherFirebaseUid: session.userFirebaseUid,
          ownerRole: 'creator',
          direction: creatorDirection,
          durationSeconds,
          ...callTimestampFields,
          settlementStatus: 'settled',
          coinsDeducted: 0,
          coinsEarned: totalEarnedCreator,
        },
        { upsert: true, new: true, session: dbSession }
      );
    }

    const userIntegrityMismatch =
      settlementIntegritySnapshot.expectedUserCoinsAfter != null &&
      settlementIntegritySnapshot.userCoinsAfter != null &&
      settlementIntegritySnapshot.expectedUserCoinsAfter !== settlementIntegritySnapshot.userCoinsAfter;
    const creatorIntegrityMismatch =
      settlementIntegritySnapshot.creatorCreditDelta != null &&
      settlementIntegritySnapshot.expectedCreatorCoinsAfter != null &&
      settlementIntegritySnapshot.creatorCoinsAfter != null &&
      settlementIntegritySnapshot.expectedCreatorCoinsAfter !== settlementIntegritySnapshot.creatorCoinsAfter;
    if (userIntegrityMismatch || creatorIntegrityMismatch) {
      recordBillingMetric('settlement_integrity_violation_total', 1, {
        callId,
        userMismatch: String(userIntegrityMismatch),
        creatorMismatch: String(creatorIntegrityMismatch),
      });
      logWarning('settlement_integrity_violation_detected', {
        callId,
        userMongoId: session.userMongoId,
        creatorMongoId: session.creatorMongoId,
        ...settlementIntegritySnapshot,
      });
    }

    const txnStartedAt = Date.now();
    writeStage = 'commit';
    logInfo('settlement_transaction_stage', { txnId, callId, attempt, writeStage });
    await dbSession.commitTransaction();
    mongoTransactionCommitted = true;
    recordBillingMetric('settlement_transaction_committed', 1, {
      callId,
      attempt: String(attempt),
    });
    recordBillingMetric('settlement_transaction_ms', Date.now() - txnStartedAt, { callId });
    logInfo('Settlement transaction committed', { callId, txnId, attempt });
    txnPersistSucceeded = true;
    break;
  } catch (err) {
    const failureStage = classifyFailureStage(err, writeStage);
    const mongoErrorLabels = getMongoErrorLabels(err);
    const mongoErrorCode = getMongoErrorCode(err);
    const conflictingCollection = inferConflictingCollection(writeStage, err);

    if (failureStage === 'commit' && isUnknownCommitResult(err)) {
      const { isCallBillingAlreadySettled } = await import('./billing-session-finalization.service');
      if (await isCallBillingAlreadySettled(callId)) {
        recordBillingMetric('settlement_transaction_commit_ambiguous_resolved', 1, {
          callId,
          attempt: String(attempt),
        });
        logInfo('settlement_transaction_commit_ambiguous_resolved', {
          txnId,
          callId,
          attempt,
          source: settlementSource,
        });
        txnPersistSucceeded = true;
        const historyRow = await CallHistory.findOne({ callId, ownerRole: 'user' })
          .select('coinsDeducted durationSeconds')
          .lean();
        if (historyRow) {
          totalDeducted = historyRow.coinsDeducted ?? totalDeducted;
          if (historyRow.durationSeconds != null) {
            durationSeconds = historyRow.durationSeconds;
          }
        }
        const userRow = await User.findById(session.userMongoId).select('coins').lean();
        if (userRow) {
          updatedUserCoins = userRow.coins ?? 0;
        }
        break;
      }
    }

    try {
      await dbSession.abortTransaction();
    } catch (abortErr) {
      logError('Failed to abort transaction', abortErr, { callId, txnId });
    }

    logError('settlement_transaction_failed', err, {
      txnId,
      callId,
      attempt,
      source: settlementSource,
      failureStage,
      writeStage,
      mongoErrorCode,
      mongoErrorLabels,
      mongoErrorName: getMongoErrorName(err),
      conflictingCollection,
      conflictingKeys: { callId, userMongoId: session.userMongoId },
    });
    recordBillingMetric('settlement_transaction_failed', 1, {
      callId,
      attempt: String(attempt),
      failureStage,
      writeStage,
      mongoErrorCode: String(mongoErrorCode ?? ''),
    });

    if (!isTransientMongoTransactionError(err) || attempt === SETTLEMENT_TXN_MAX_ATTEMPTS - 1) {
      if (!mongoTransactionCommitted) {
        try {
          await redis.del(settledKey);
        } catch {
          /* allow settlement retry */
        }
      }
      throwSettlementTxnError(err, lastTxnId);
    }

    recordBillingMetric('settlement_transaction_retry', 1, {
      callId,
      attempt: String(attempt),
      failureStage,
      writeStage,
    });
    await sleepMs(settlementTxnBackoffMs(attempt));
  } finally {
    await dbSession.endSession();
  }
  }

  if (!txnPersistSucceeded) {
    throwSettlementTxnError(
      new Error(`Settlement transaction failed after ${SETTLEMENT_TXN_MAX_ATTEMPTS} attempts`),
      lastTxnId
    );
  }

  void enqueueSettlementDomainEvents({
    callId,
    totalEarnedCreator,
    durationSeconds,
  }).catch((err) =>
    logError('enqueueSettlementDomainEvents failed', err instanceof Error ? err : new Error(String(err)), {
      callId,
    })
  );

  if (!fromFinalizer) {
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
  }

  const persistResult: SettlePersistResult = {
    totalDeducted,
    walletCoinsDeducted,
    totalEarnedCreator,
    durationSeconds,
    userFirebaseUid: session.userFirebaseUid,
    creatorFirebaseUid: session.creatorFirebaseUid,
    userMongoId: session.userMongoId,
    billingSequence: Math.max(
      0,
      Number((session as { billingSequence?: number }).billingSequence) || 0
    ),
    finalUserCoins: updatedUserCoins,
    lastTxnId,
  };

  const userEmit = userForEmit;
  if (userEmit) {
    io.to(`user:${session.userFirebaseUid}`).emit('coins_updated', {
      userId: userEmit._id.toString(),
      coins: updatedUserCoins,
    });
  }

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

    if (!opts?.suppressSettledEmit) {
      emitBillingSettledFromSnapshot(
        io,
        session.userFirebaseUid,
        session.creatorFirebaseUid,
        {
          callId,
          billingSequence: Math.max(
            0,
            Number((session as { billingSequence?: number }).billingSequence) || 0
          ),
          lifecycleState: 'SETTLED',
          finalCoins: updatedUserCoins,
          totalDeducted,
          durationSeconds,
        },
        {
          callId,
          billingSequence: Math.max(
            0,
            Number((session as { billingSequence?: number }).billingSequence) || 0
          ),
          lifecycleState: 'SETTLED',
          totalEarned: totalEarnedCreator,
          durationSeconds,
        }
      );
    }

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

    emitStaffDomainEvent({
      type: 'billing:settled',
      scope: { bdId: settlementBdId, agencyId: settlementAgencyId },
      entityId: callId,
      meta: {
        userFirebaseUid: session.userFirebaseUid,
        creatorFirebaseUid: session.creatorFirebaseUid,
        durationSeconds,
        coinsDeducted: totalDeducted,
        creatorEarned: totalEarnedCreator,
      },
    });

    logInfo('Settlement complete', { callId });
    recordBillingMetric('settlement_total_ms', Date.now() - settleStartedAt, { callId });

    if (fromFinalizer) {
      if (lockHeartbeat) {
        clearInterval(lockHeartbeat);
      }
      return persistResult;
    }

  if (lockHeartbeat) {
    clearInterval(lockHeartbeat);
  }
  if (!fromFinalizer) {
    await redis.eval(RELEASE_IF_MATCH_LUA, 1, settleLockRedisKey, lockToken).catch(() => {});
  }
}

/** @deprecated Use finalizeCallSession — persistence-only alias for the finalizer. */
export const persistCallSettlement = settleCall;
