/**
 * 🔥 FIX 5: Billing Reconciliation Job
 * 
 * Processes failed billing ticks from dead letter queue
 * Runs periodically to catch missed ticks and retry failed operations
 */

import { Server } from 'socket.io';
import { withDistributedLock } from '../../utils/distributed-lock';
import { getBillingInstanceId } from './billing-instance-id';
import {
  getRedis,
  DLQ_BILLING_PREFIX,
  BILLING_DLQ_SSCAN_CURSOR_KEY,
  RECONCILIATION_LAST_RUN_KEY,
  RECONCILIATION_INTERVAL_MS,
  callSessionKey,
  BILLING_RECONCILIATION_LOCK_KEY,
  RECONCILIATION_LOCK_TTL_MS,
  CALL_SESSION_PREFIX,
  parseCallIdFromSessionRedisKey,
  BILLING_BALANCE_MISMATCH_REPAIR_QUEUE_KEY,
  billingBalanceMismatchRepairPayloadKey,
  settledCallKey,
} from '../../config/redis';
import { billingService } from './billing.service';
import {
  finalizeCallSession,
  processSettlementRetryQueue,
} from './billing-session-finalization.service';
import { CallHistory } from './call-history.model';
import { Call } from '../video/call.model';
import { BILLING_MAX_SETTLING_MS, BILLING_SETTLEMENT_PENDING_MAX_MS } from './billing.constants';
import {
  isBullmqBillingEnabled,
  scheduleNextBillingCycleAfterTickOk,
  needsBillingCycleReschedule,
  scheduleBillingJob,
} from './billing.queue';
import { processTerminationRedisRetries } from './billing-termination-redis-retry';
import { BILLING_PROCESS_INTERVAL_MS } from './billing.constants';
import { logInfo, logError, logWarning } from '../../utils/logger';
import { recordBillingMetric } from '../../utils/monitoring';
import { featureFlags } from '../../config/feature-flags';
import { User } from '../user/user.model';
import { CoinTransaction } from '../user/coin-transaction.model';
import mongoose from 'mongoose';
import { shouldFinalizeSessionNoHistory, shouldRescheduleBillingCycleForSession } from './billing-reconciliation.guards';

let reconciliationInterval: NodeJS.Timeout | null = null;

function readNumber(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = parseInt(raw || '', 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

const DLQ_BATCH_SIZE = readNumber(process.env.BILLING_RECON_DLQ_BATCH_SIZE, 200, 20, 1000);
const DLQ_PARALLELISM = readNumber(process.env.BILLING_RECON_DLQ_PARALLELISM, 8, 1, 50);
const DLQ_BATCH_PAUSE_MS = readNumber(process.env.BILLING_RECON_DLQ_BATCH_PAUSE_MS, 120, 0, 1000);
const DLQ_SCAN_COUNT = readNumber(process.env.BILLING_RECON_DLQ_SCAN_COUNT, 200, 20, 1000);
const DLQ_SCAN_MAX_MS = readNumber(process.env.BILLING_RECON_DLQ_SCAN_MAX_MS, 200, 50, 3000);
const RUN_BUDGET_MS = readNumber(process.env.BILLING_RECON_MAX_RUN_MS, 45_000, 10_000, 180_000);
const BULLMQ_STALE_BATCH_SIZE = readNumber(process.env.BILLING_BULLMQ_STALE_BATCH_SIZE, 40, 10, 200);
const BULLMQ_STALE_SCAN_COUNT = readNumber(process.env.BILLING_BULLMQ_STALE_SCAN_COUNT, 200, 50, 1000);
const BULLMQ_STALE_MAX_KEYS = readNumber(process.env.BILLING_BULLMQ_STALE_MAX_KEYS, 600, 100, 5000);
const BULLMQ_STALE_PARALLELISM = readNumber(process.env.BILLING_BULLMQ_STALE_PARALLELISM, 5, 1, 20);

function isBullmqStaleWatchdogEnabled(): boolean {
  return process.env.BILLING_BULLMQ_STALE_WATCHDOG_ENABLED !== 'false';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withBillingReconciliationLock(task: () => Promise<void>): Promise<void> {
  await withDistributedLock(
    {
      key: BILLING_RECONCILIATION_LOCK_KEY,
      ttlMs: RECONCILIATION_LOCK_TTL_MS,
      ownerId: getBillingInstanceId(),
      heartbeat: true,
      onSkipped: () => recordBillingMetric('reconciliation_skipped_lock_busy', 1, {}),
    },
    task
  );
}

async function processInParallel<T>(
  items: T[],
  parallelism: number,
  handler: (item: T) => Promise<void>
): Promise<void> {
  if (items.length === 0) return;
  for (let i = 0; i < items.length; i += parallelism) {
    const chunk = items.slice(i, i + parallelism);
    await Promise.allSettled(chunk.map((item) => handler(item)));
  }
}

async function getDlqBatch(
  redis: ReturnType<typeof getRedis>,
  dlqSetKey: string,
  maxItems: number
): Promise<string[]> {
  const items: string[] = [];
  let cursor = (await redis.get(BILLING_DLQ_SSCAN_CURSOR_KEY)) || '0';
  const startedAt = Date.now();

  do {
    const [nextCursor, members] = await redis.sscan(dlqSetKey, cursor, 'COUNT', DLQ_SCAN_COUNT);
    if (nextCursor === '0') {
      recordBillingMetric('dlq_sscan_cursor_full_pass', 1, {});
    }
    cursor = nextCursor;
    await redis.set(BILLING_DLQ_SSCAN_CURSOR_KEY, cursor).catch(() => {});
    for (const member of members) {
      items.push(member);
      if (items.length >= maxItems) {
        return items;
      }
    }
    if (Date.now() - startedAt > DLQ_SCAN_MAX_MS) {
      recordBillingMetric('dlq_scan_runtime_capped', 1, {
        maxMs: String(DLQ_SCAN_MAX_MS),
      });
      break;
    }
  } while (cursor !== '0');

  return items;
}

/**
 * Start the reconciliation job
 * Processes DLQ items every 5 minutes
 */
export function startReconciliationJob(io: Server): void {
  if (reconciliationInterval) {
    logWarning('Reconciliation job already running', {});
    return;
  }

  logInfo('Starting billing reconciliation job', {
    interval: RECONCILIATION_INTERVAL_MS,
  });

  const run = (): void => {
    withBillingReconciliationLock(async () => {
      const startedAt = Date.now();
      await processSettlementRetryQueue(io, 40);
      await runSettlementOrphanRepair(io, startedAt);
      await processBalanceMismatchRepairs(startedAt);
      await processDLQ(io, startedAt);
      await processTerminationRedisRetries(io, startedAt, RUN_BUDGET_MS);
      await runBullmqBillingWatchdog(startedAt);
      recordBillingMetric('reconciliation_run_ms', Date.now() - startedAt, {});
    }).catch((err) => {
      logError('Error in reconciliation run', err);
    });
  };

  run();

  reconciliationInterval = setInterval(run, RECONCILIATION_INTERVAL_MS);
}

async function processBalanceMismatchRepairs(startedAt: number): Promise<void> {
  const redis = getRedis();
  const now = Date.now();
  const maxItems = readNumber(process.env.BILLING_BALANCE_MISMATCH_REPAIR_BATCH_SIZE, 40, 1, 200);
  const userIds = await redis.zrangebyscore(
    BILLING_BALANCE_MISMATCH_REPAIR_QUEUE_KEY,
    0,
    now,
    'LIMIT',
    0,
    maxItems
  );
  if (userIds.length === 0) {
    return;
  }

  for (const userId of userIds) {
    if (Date.now() - startedAt > RUN_BUDGET_MS) {
      recordBillingMetric('balance_mismatch_repair_budget_capped', 1, {});
      break;
    }
    await redis.zrem(BILLING_BALANCE_MISMATCH_REPAIR_QUEUE_KEY, userId).catch(() => 0);
    const payloadKey = billingBalanceMismatchRepairPayloadKey(userId);
    const payloadRaw = await redis.get(payloadKey);
    await redis.del(payloadKey).catch(() => 0);

    try {
      const user = await User.findById(userId).select('_id coins').lean();
      if (!user) {
        recordBillingMetric('balance_mismatch_repair_skipped_total', 1, {
          reason: 'user_missing',
        });
        continue;
      }
      const agg = await CoinTransaction.aggregate([
        {
          $match: {
            userId: new mongoose.Types.ObjectId(String(userId)),
            status: 'completed',
          },
        },
        { $group: { _id: '$type', total: { $sum: '$coins' } } },
      ]);
      const credits = agg.find((a: any) => a._id === 'credit')?.total || 0;
      const debits = agg.find((a: any) => a._id === 'debit')?.total || 0;
      const expectedBalance = credits - debits;
      const actualBalance = Number(user.coins) || 0;
      const discrepancy = actualBalance - expectedBalance;
      if (Math.abs(discrepancy) <= 1) {
        recordBillingMetric('balance_mismatch_repair_skipped_total', 1, {
          reason: 'already_converged',
        });
        continue;
      }
      if (!featureFlags.billingBalanceMismatchAutoRepairEnabled) {
        recordBillingMetric('balance_mismatch_repair_skipped_total', 1, {
          reason: 'auto_repair_disabled',
        });
        continue;
      }
      await User.updateOne(
        { _id: user._id },
        {
          $set: {
            coins: expectedBalance,
          },
        }
      );
      recordBillingMetric('balance_mismatch_repair_applied_total', 1, {
        userId: String(userId),
      });
      logWarning('billing_balance_mismatch_repair_applied', {
        userId,
        actualBalance,
        expectedBalance,
        discrepancy,
        queuedPayloadPresent: Boolean(payloadRaw),
      });
    } catch (error) {
      logError('billing_balance_mismatch_repair_failed', error, { userId });
      recordBillingMetric('balance_mismatch_repair_failed_total', 1, {
        userId: String(userId),
      });
    }
  }
}

/**
 * BullMQ: re-enqueue lost delayed jobs (no ZSET mirror). Bounded SCAN of session keys.
 */
async function runBullmqBillingWatchdog(startedAt: number): Promise<void> {
  if (!isBullmqBillingEnabled() || !isBullmqStaleWatchdogEnabled()) {
    return;
  }
  const redis = getRedis();
  const seen = new Set<string>();
  let cursor = '0';

  do {
    if (Date.now() - startedAt > RUN_BUDGET_MS) {
      logWarning('Stopping BullMQ stale watchdog scan early due to runtime budget', {
        elapsedMs: Date.now() - startedAt,
        budgetMs: RUN_BUDGET_MS,
      });
      break;
    }
    const scanResult = await redis.scan(
      cursor,
      'MATCH',
      `${CALL_SESSION_PREFIX}*`,
      'COUNT',
      BULLMQ_STALE_SCAN_COUNT
    );
    cursor = scanResult[0];
    const keys = scanResult[1] || [];
    for (const key of keys) {
      const callId = parseCallIdFromSessionRedisKey(key);
      if (callId) seen.add(callId);
      if (seen.size >= BULLMQ_STALE_MAX_KEYS) break;
    }
  } while (cursor !== '0' && seen.size < BULLMQ_STALE_MAX_KEYS);

  const allIds = Array.from(seen);
  recordBillingMetric('billing_bullmq_watchdog_scanned', allIds.length, {});
  const callIds = allIds.slice(0, BULLMQ_STALE_BATCH_SIZE);
  if (callIds.length === 0) return;

  let rescheduled = 0;
  await processInParallel(callIds, BULLMQ_STALE_PARALLELISM, async (callId) => {
    if (Date.now() - startedAt > RUN_BUDGET_MS) {
      return;
    }
    try {
      const sessionRaw = await redis.get(callSessionKey(callId));
      if (!sessionRaw) return;
      let session: { lifecycleState?: string } | null = null;
      try {
        session = JSON.parse(sessionRaw) as { lifecycleState?: string };
      } catch {
        return;
      }
      const settledTombstonePresent = (await redis.get(settledCallKey(callId))) != null;
      if (!shouldRescheduleBillingCycleForSession(session, settledTombstonePresent)) {
        recordBillingMetric('billing_bullmq_watchdog_terminal_skipped', 1, {
          callId,
          lifecycleState: session?.lifecycleState ?? 'unknown',
        });
        return;
      }
      const needs = await needsBillingCycleReschedule(callId);
      if (!needs) return;
      await scheduleBillingJob(callId, BILLING_PROCESS_INTERVAL_MS);
      rescheduled++;
      recordBillingMetric('billing_bullmq_stale_rescheduled', 1, { callId });
    } catch (e) {
      logError('BullMQ stale watchdog reschedule failed', e, { callId });
    }
  });
  if (rescheduled > 0) {
    logWarning('BullMQ stale watchdog rescheduled missing cycle jobs', {
      rescheduled,
      batchSize: callIds.length,
    });
  }
}

/** Repair calls with deductions but no CallHistory, stale settling, or long-pending settlement. */
async function runSettlementOrphanRepair(io: Server, startedAt: number): Promise<void> {
  const redis = getRedis();
  const now = Date.now();

  const staleSettling = await Call.find({
    'settlement.status': 'settling',
    'settlement.updatedAt': { $lt: new Date(now - BILLING_MAX_SETTLING_MS) },
  })
    .select('callId')
    .limit(30)
    .lean();

  for (const row of staleSettling) {
    if (Date.now() - startedAt > RUN_BUDGET_MS) break;
    const callId = row.callId;
    recordBillingMetric('billing_orphaned_sessions_total', 1, { callId, type: 'stale_settling' });
    logInfo('billing_reconciliation_repair', { callId, orphanType: 'stale_settling' });
    await finalizeCallSession(io, {
      callId,
      reason: 'reconciliation',
      source: 'reconciliation_worker',
    }).catch((e) => logError('Stale settling repair failed', e, { callId }));
  }

  const pendingTooLong = await Call.find({
    'settlement.status': 'pending',
    updatedAt: { $lt: new Date(now - BILLING_SETTLEMENT_PENDING_MAX_MS) },
  })
    .select('callId')
    .limit(20)
    .lean();

  for (const row of pendingTooLong) {
    if (Date.now() - startedAt > RUN_BUDGET_MS) break;
    const callId = row.callId;
    recordBillingMetric('billing_orphaned_sessions_total', 1, { callId, type: 'pending_timeout' });
    await finalizeCallSession(io, {
      callId,
      reason: 'timeout',
      source: 'reconciliation_worker',
    }).catch((e) => logError('Pending settlement repair failed', e, { callId }));
  }

  let cursor = '0';
  let scanned = 0;
  const maxScan = 80;
  do {
    if (Date.now() - startedAt > RUN_BUDGET_MS || scanned >= maxScan) break;
    const [next, keys] = await redis.scan(
      cursor,
      'MATCH',
      `${CALL_SESSION_PREFIX}*`,
      'COUNT',
      40
    );
    cursor = next;
    for (const key of keys) {
      if (Date.now() - startedAt > RUN_BUDGET_MS) break;
      const callId = parseCallIdFromSessionRedisKey(key);
      if (!callId) continue;
      scanned++;
      const hasHistory = await CallHistory.findOne({ callId, ownerRole: 'user' }).lean();
      if (hasHistory) continue;
      const sessionRaw = await redis.get(callSessionKey(callId));
      if (!sessionRaw) continue;
      try {
        const sess = JSON.parse(sessionRaw) as {
          totalDeductedMicros?: number;
          lifecycleState?: string;
          lastProcessedAt?: number;
          lastEmitAtMs?: number;
        };
        const minAgeMs = readNumber(
          process.env.BILLING_RECON_SESSION_NO_HISTORY_MIN_AGE_MS,
          10 * 60_000,
          60_000,
          24 * 60 * 60_000
        );
        const decision = shouldFinalizeSessionNoHistory(sess, Date.now(), minAgeMs);
        if (!decision.shouldFinalize) {
          // keep metric cardinality bounded; emit only reasons we explicitly handle
          recordBillingMetric('billing_reconciliation_skips_total', 1, {
            callId,
            reason: String(decision.skipReason || 'skip'),
          });
          continue;
        }
      } catch {
        continue;
      }
      recordBillingMetric('billing_reconciliation_repairs_total', 1, { callId, type: 'session_no_history' });
      logInfo('billing_reconciliation_repair', { callId, orphanType: 'session_no_history' });
      await finalizeCallSession(io, {
        callId,
        reason: 'reconciliation',
        source: 'reconciliation_worker',
      }).catch((e) => logError('Orphan session repair failed', e, { callId }));
    }
  } while (cursor !== '0');
}

/**
 * Stop the reconciliation job
 */
export function stopReconciliationJob(): void {
  if (reconciliationInterval) {
    clearInterval(reconciliationInterval);
    reconciliationInterval = null;
    logInfo('Stopped billing reconciliation job', {});
  }
}

/**
 * Process dead letter queue items
 */
async function processDLQ(io: Server, startedAt: number): Promise<void> {
  const redis = getRedis();
  const startTime = Date.now();

  // 🔥 FIX (Critique #7): Process DLQ in bounded batches to avoid O(n) scans
  // even if the set grows very large over time.
  try {
    // Update last run timestamp
    await redis.set(RECONCILIATION_LAST_RUN_KEY, startTime.toString());

    // Get all DLQ keys (pattern match)
    // Note: Railway Redis supports KEYS but it's expensive, so we use a set for efficient retrieval
    const dlqSetKey = `${DLQ_BILLING_PREFIX}set`;

    const dlqFetchStartedAt = Date.now();
    const dlqItems = await getDlqBatch(redis, dlqSetKey, DLQ_BATCH_SIZE);
    const dlqFetchMs = Date.now() - dlqFetchStartedAt;
    recordBillingMetric('dlq_batch_fetch_ms', dlqFetchMs, {});
    recordBillingMetric('dlq_batch_fetched_items', dlqItems.length, {});

    if (!dlqItems || dlqItems.length === 0) {
      logInfo('No items in DLQ to process', {});
      return;
    }

    logInfo('Processing DLQ items', {
      count: dlqItems.length,
      scanCountHint: DLQ_SCAN_COUNT,
      maxBatch: DLQ_BATCH_SIZE,
      fetchMs: dlqFetchMs,
    });

    let processed = 0;
    let retried = 0;
    let failed = 0;

    for (let i = 0; i < dlqItems.length; i += DLQ_PARALLELISM) {
      if (Date.now() - startedAt > RUN_BUDGET_MS) {
        logWarning('Stopping DLQ reconciliation early due to runtime budget', {
          elapsedMs: Date.now() - startedAt,
          budgetMs: RUN_BUDGET_MS,
        });
        break;
      }

      const batch = dlqItems.slice(i, i + DLQ_PARALLELISM);
      await Promise.allSettled(
        batch.map(async (dlqKey) => {
      try {
        // Get error details
        const errorDetailsRaw = await redis.get(dlqKey);
        if (!errorDetailsRaw) {
          // Item expired or already processed, remove from set
          await redis.srem(dlqSetKey, dlqKey);
          processed++;
          return;
        }

        const errorDetails = JSON.parse(errorDetailsRaw);
        const { callId } = errorDetails;

        // 🔥 FIX: Check if call ended before retrying
        // If call session doesn't exist or call is not in active billing set,
        // the call has ended and we should remove it from DLQ
        const sessionExists = await redis.get(callSessionKey(callId));
        if (!sessionExists) {
          // Call has ended, remove from DLQ
          await Promise.all([
            redis.del(dlqKey),
            redis.srem(dlqSetKey, dlqKey),
          ]);
          processed++;
          logInfo('Removed ended call from DLQ', { callId });
          recordBillingMetric('dlq_ended_call_removed', 1, { callId });
          return;
        }
        
        const tickResult = await billingService.processBillingTick(io, callId);

        if (tickResult === 'tick_ok' || tickResult === 'tick_deferred') {
          if (isBullmqBillingEnabled()) {
            const sessionStillThere = await redis.get(callSessionKey(callId));
            if (sessionStillThere) {
              let session: { lifecycleState?: string } | null = null;
              try {
                session = JSON.parse(sessionStillThere) as { lifecycleState?: string };
              } catch {
                session = null;
              }
              const settledTombstonePresent =
                (await redis.get(settledCallKey(callId))) != null;
              if (shouldRescheduleBillingCycleForSession(session, settledTombstonePresent)) {
                if (tickResult === 'tick_ok') {
                  await scheduleNextBillingCycleAfterTickOk(callId, 0).catch((e) =>
                    logError('DLQ: schedule next BullMQ cycle failed', e, { callId })
                  );
                } else {
                  const { scheduleBillingJob } = await import('./billing.queue');
                  const { getBillingCycleLockDeferMs } = await import('./billing.constants');
                  await scheduleBillingJob(callId, getBillingCycleLockDeferMs()).catch((e) =>
                    logError('DLQ: schedule deferred BullMQ cycle failed', e, { callId })
                  );
                }
              }
            }
          } else {
            const sessionRaw = await redis.get(callSessionKey(callId));
            if (sessionRaw) {
              let session: { lifecycleState?: string } | null = null;
              try {
                session = JSON.parse(sessionRaw) as { lifecycleState?: string };
              } catch {
                session = null;
              }
              const settledTombstonePresent =
                (await redis.get(settledCallKey(callId))) != null;
              if (shouldRescheduleBillingCycleForSession(session, settledTombstonePresent)) {
                await scheduleBillingJob(callId, BILLING_PROCESS_INTERVAL_MS).catch((e) =>
                  logError('DLQ: schedule billing cycle failed', e, { callId })
                );
              }
            }
          }
          await Promise.all([
            redis.del(dlqKey),
            redis.srem(dlqSetKey, dlqKey),
          ]);
          retried++;
          processed++;
          logInfo('Successfully retried billing tick from DLQ', { callId });
        } else if (tickResult === 'stop_needs_settlement') {
          await finalizeCallSession(io, {
            callId,
            reason: 'reconciliation',
            source: 'reconciliation_worker',
          }).catch((e) => logError('DLQ finalizeCallSession failed', e, { callId }));
          await Promise.all([
            redis.del(dlqKey),
            redis.srem(dlqSetKey, dlqKey),
          ]);
          processed++;
          logInfo('Settled call from DLQ after tick stop', { callId });
        } else {
          const sessionStillExists = await redis.get(callSessionKey(callId));
          if (!sessionStillExists) {
            await Promise.all([
              redis.del(dlqKey),
              redis.srem(dlqSetKey, dlqKey),
            ]);
            processed++;
            logInfo('Removed ended call from DLQ (ended during retry)', { callId });
            recordBillingMetric('dlq_ended_call_removed', 1, { callId });
          } else {
            failed++;
            processed++;
            logWarning('Billing tick still failing after retry', { callId });
          }
        }
      } catch (itemError) {
        logError('Error processing DLQ item', itemError, { dlqKey });
        failed++;
      }
        })
      );
      if (DLQ_BATCH_PAUSE_MS > 0 && i + DLQ_PARALLELISM < dlqItems.length) {
        await sleep(DLQ_BATCH_PAUSE_MS);
      }
    }

    const duration = Date.now() - startTime;
    logInfo('Reconciliation job completed', {
      processed,
      retried,
      failed,
      duration,
    });

    recordBillingMetric('reconciliation_run', 1, {
      processed: processed.toString(),
      retried: retried.toString(),
      failed: failed.toString(),
    });
    recordBillingMetric('reconciliation_items_processed', processed, {
      retried: String(retried),
      failed: String(failed),
    });
  } catch (error) {
    logError('Error in reconciliation job', error);
    recordBillingMetric('reconciliation_error', 1, {});
  }
}

/**
 * Add item to DLQ set for efficient retrieval
 */
export async function addToDLQSet(dlqKey: string): Promise<void> {
  try {
    const redis = getRedis();
    const dlqSetKey = `${DLQ_BILLING_PREFIX}set`;
    await redis.sadd(dlqSetKey, dlqKey);
  } catch (error) {
    logError('Failed to add to DLQ set', error, { dlqKey });
  }
}
