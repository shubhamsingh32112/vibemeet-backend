/**
 * 🔥 FIX 5: Billing Reconciliation Job
 * 
 * Processes failed billing ticks from dead letter queue
 * Runs periodically to catch missed ticks and retry failed operations
 */

import { Server } from 'socket.io';
import { getRedis, DLQ_BILLING_PREFIX, RECONCILIATION_LAST_RUN_KEY, RECONCILIATION_INTERVAL_MS, ACTIVE_BILLING_CALLS_KEY, callSessionKey } from '../../config/redis';
import { billingService } from './billing.service';
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

  // Run immediately on start
  processDLQ(io).catch((err) => {
    logError('Error in initial reconciliation run', err);
  });

  // Then run every 5 minutes
  reconciliationInterval = setInterval(() => {
    processDLQ(io).catch((err) => {
      logError('Error in scheduled reconciliation run', err);
    });
  }, RECONCILIATION_INTERVAL_MS);
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
        const isInActiveBilling = await redis.zscore(ACTIVE_BILLING_CALLS_KEY, callId);
        
        if (!sessionExists && !isInActiveBilling) {
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
        
        // Call is still active, try to process the billing tick again
        const success = await billingService.processBillingTick(io, callId);
        
        if (success) {
          // Successfully retried, remove from DLQ
          await Promise.all([
            redis.del(dlqKey),
            redis.srem(dlqSetKey, dlqKey),
          ]);
          retried++;
          logInfo('Successfully retried billing tick from DLQ', { callId });
        } else {
          // Still failing, keep in DLQ (will retry next run)
          // But check if call ended during processing
          const sessionStillExists = await redis.get(callSessionKey(callId));
          const stillInActiveBilling = await redis.zscore(ACTIVE_BILLING_CALLS_KEY, callId);
          
          if (!sessionStillExists && !stillInActiveBilling) {
            // Call ended during processing, remove from DLQ
            await Promise.all([
              redis.del(dlqKey),
              redis.srem(dlqSetKey, dlqKey),
            ]);
            processed++;
            logInfo('Removed ended call from DLQ (ended during retry)', { callId });
            recordBillingMetric('dlq_ended_call_removed', 1, { callId });
          } else {
            // Still failing, keep in DLQ
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
