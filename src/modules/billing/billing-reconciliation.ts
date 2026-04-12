/**
 * 🔥 FIX 5: Billing Reconciliation Job
 * 
 * Processes failed billing ticks from dead letter queue
 * Runs periodically to catch missed ticks and retry failed operations
 */

import { Server } from 'socket.io';
import { getRedis, DLQ_BILLING_PREFIX, RECONCILIATION_LAST_RUN_KEY, RECONCILIATION_INTERVAL_MS, ACTIVE_BILLING_CALLS_KEY, callSessionKey } from '../../config/redis';
import { billingService } from './billing.service';
import { settleCall } from './billing-settlement.service';
import { isBullmqBillingEnabled } from './billing.queue';
import { BILLING_PROCESS_INTERVAL_MS } from './billing.constants';
import { logInfo, logError, logWarning } from '../../utils/logger';
import { recordBillingMetric } from '../../utils/monitoring';

let reconciliationInterval: NodeJS.Timeout | null = null;

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
    processDLQ(io).catch((err) => {
      logError('Error in reconciliation run', err);
    });
    runStaleBillingWatchdog(io).catch((err) => {
      logError('Error in stale billing watchdog', err);
    });
  };

  run();

  reconciliationInterval = setInterval(run, RECONCILIATION_INTERVAL_MS);
}

/** ZSET-only: recover calls whose next-process score is far in the past (stuck scheduler). */
async function runStaleBillingWatchdog(io: Server): Promise<void> {
  if (isBullmqBillingEnabled()) {
    return;
  }
  const redis = getRedis();
  const STALE_AFTER_MS = 120_000;
  const now = Date.now();
  const maxScore = now - STALE_AFTER_MS;
  const stale = await redis.zrangebyscore(ACTIVE_BILLING_CALLS_KEY, 0, maxScore, 'LIMIT', 0, 40);
  const callIds: string[] = Array.isArray(stale) ? stale : [];
  if (callIds.length === 0) return;

  logWarning('Stale billing schedules detected', { count: callIds.length });

  for (const callId of callIds) {
    try {
      const r = await billingService.processBillingTick(io, callId);
      if (r === 'stop_needs_settlement') {
        await settleCall(io, callId).catch((e) => logError('Watchdog settleCall failed', e, { callId }));
      }
      recordBillingMetric('billing_stale_recovered', 1, { callId });
    } catch (e) {
      logError('Watchdog billing cycle failed', e, { callId });
    }
  }
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
async function processDLQ(io: Server): Promise<void> {
  const redis = getRedis();
  const startTime = Date.now();

  // 🔥 FIX (Critique #7): Process DLQ in bounded batches to avoid O(n) scans
  // even if the set grows very large over time.
  const MAX_DLQ_BATCH = 200;

  try {
    // Update last run timestamp
    await redis.set(RECONCILIATION_LAST_RUN_KEY, startTime.toString());

    // Get all DLQ keys (pattern match)
    // Note: Railway Redis supports KEYS but it's expensive, so we use a set for efficient retrieval
    const dlqSetKey = `${DLQ_BILLING_PREFIX}set`;

    // Get a bounded batch of DLQ items from the set
    const allItems = await redis.smembers(dlqSetKey);

    if (!allItems || allItems.length === 0) {
      logInfo('No items in DLQ to process', {});
      return;
    }

    const dlqItems = allItems.slice(0, MAX_DLQ_BATCH);

    logInfo('Processing DLQ items', {
      count: dlqItems.length,
      total: allItems.length,
      maxBatch: MAX_DLQ_BATCH,
    });

    let processed = 0;
    let retried = 0;
    let failed = 0;

    // Process each DLQ item
    for (const dlqKey of dlqItems) {
      try {
        // Get error details
        const errorDetailsRaw = await redis.get(dlqKey);
        if (!errorDetailsRaw) {
          // Item expired or already processed, remove from set
          await redis.srem(dlqSetKey, dlqKey);
          continue;
        }

        const errorDetails = JSON.parse(errorDetailsRaw);
        const { callId } = errorDetails;

        // 🔥 FIX: Check if call ended before retrying
        // If call session doesn't exist or call is not in active billing set,
        // the call has ended and we should remove it from DLQ
        const sessionExists = await redis.get(callSessionKey(callId));
        const isInActiveBilling = isBullmqBillingEnabled()
          ? null
          : await redis.zscore(ACTIVE_BILLING_CALLS_KEY, callId);

        if (!sessionExists && (isBullmqBillingEnabled() || !isInActiveBilling)) {
          // Call has ended, remove from DLQ
          await Promise.all([
            redis.del(dlqKey),
            redis.srem(dlqSetKey, dlqKey),
          ]);
          processed++;
          logInfo('Removed ended call from DLQ', { callId });
          recordBillingMetric('dlq_ended_call_removed', 1, { callId });
          continue;
        }
        
        const tickResult = await billingService.processBillingTick(io, callId);

        if (tickResult === 'tick_ok') {
          if (!isBullmqBillingEnabled()) {
            const sessionRaw = await redis.get(callSessionKey(callId));
            if (sessionRaw) {
              try {
                const sess = JSON.parse(sessionRaw as string) as { lastProcessedAt?: number };
                const lp = Number(sess.lastProcessedAt) || Date.now();
                await redis.zadd(
                  ACTIVE_BILLING_CALLS_KEY,
                  lp + BILLING_PROCESS_INTERVAL_MS,
                  callId
                );
              } catch {
                /* ignore */
              }
            }
          }
          await Promise.all([
            redis.del(dlqKey),
            redis.srem(dlqSetKey, dlqKey),
          ]);
          retried++;
          logInfo('Successfully retried billing tick from DLQ', { callId });
        } else if (tickResult === 'stop_needs_settlement') {
          await settleCall(io, callId).catch((e) =>
            logError('DLQ settleCall failed', e, { callId })
          );
          await Promise.all([
            redis.del(dlqKey),
            redis.srem(dlqSetKey, dlqKey),
          ]);
          processed++;
          logInfo('Settled call from DLQ after tick stop', { callId });
        } else {
          const sessionStillExists = await redis.get(callSessionKey(callId));
          const stillInActiveBilling = isBullmqBillingEnabled()
            ? null
            : await redis.zscore(ACTIVE_BILLING_CALLS_KEY, callId);

          if (!sessionStillExists && (isBullmqBillingEnabled() || !stillInActiveBilling)) {
            await Promise.all([
              redis.del(dlqKey),
              redis.srem(dlqSetKey, dlqKey),
            ]);
            processed++;
            logInfo('Removed ended call from DLQ (ended during retry)', { callId });
            recordBillingMetric('dlq_ended_call_removed', 1, { callId });
          } else {
            failed++;
            logWarning('Billing tick still failing after retry', { callId });
          }
        }

        processed++;
      } catch (itemError) {
        logError('Error processing DLQ item', itemError, { dlqKey });
        failed++;
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
