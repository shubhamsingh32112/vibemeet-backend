/**
 * 🔥 FIX: Startup Recovery Verification
 * 
 * Verifies that billing resumes correctly after server restart.
 * Queries active calls from Redis and verifies they're being processed.
 */

import { Server } from 'socket.io';
import { getRedis, ACTIVE_BILLING_CALLS_KEY, callSessionKey, CALL_SESSION_PREFIX } from '../../config/redis';
import {
  isBullmqBillingEnabled,
  needsBillingCycleReschedule,
  scheduleBillingJob,
} from './billing.queue';
import { BILLING_PROCESS_INTERVAL_MS } from './billing.constants';
import { logInfo, logError, logWarning } from '../../utils/logger';
import { recordBillingMetric } from '../../utils/monitoring';

function readStartupEnsureMax(): number {
  const raw = parseInt(process.env.BILLING_STARTUP_ENSURE_CYCLE_MAX || '200', 10);
  if (!Number.isFinite(raw) || raw <= 0) return 200;
  return Math.min(2000, Math.max(1, raw));
}

/**
 * Best-effort immediate schedule recovery for one active call.
 * Used when call start succeeded but scheduler registration failed.
 */
export async function recoverBillingScheduleForCall(
  callId: string,
  source: 'start_registration_failed' | 'reconciliation' | 'manual' = 'manual'
): Promise<boolean> {
  try {
    const redis = getRedis();
    const sessionRaw = await redis.get(callSessionKey(callId));
    if (!sessionRaw) {
      logWarning('Billing schedule recovery skipped: session missing', { callId, source });
      return false;
    }

    if (isBullmqBillingEnabled()) {
      const shouldReschedule = await needsBillingCycleReschedule(callId);
      if (shouldReschedule) {
        await scheduleBillingJob(callId, BILLING_PROCESS_INTERVAL_MS);
        logInfo('Recovered BullMQ billing schedule for call', { callId, source });
      } else {
        logInfo('BullMQ billing schedule already healthy during recovery', { callId, source });
      }
    } else {
      let nextBillingTime = Date.now() + BILLING_PROCESS_INTERVAL_MS;
      try {
        const parsed = JSON.parse(sessionRaw) as { lastProcessedAt?: number };
        const lastProcessedAt = Number(parsed.lastProcessedAt) || Date.now();
        nextBillingTime = lastProcessedAt + BILLING_PROCESS_INTERVAL_MS;
      } catch {
        // Keep fallback nextBillingTime.
      }
      await redis.zadd(ACTIVE_BILLING_CALLS_KEY, nextBillingTime, callId);
      logInfo('Recovered ZSET billing schedule for call', {
        callId,
        source,
        nextBillingTime,
      });
    }

    recordBillingMetric('billing_schedule_recovery_success', 1, { callId, source });
    return true;
  } catch (error) {
    logError('Billing schedule recovery failed', error, { callId, source });
    recordBillingMetric('billing_schedule_recovery_failed', 1, { callId, source });
    return false;
  }
}

/**
 * Verify startup recovery for active calls
 * Called on server startup to ensure billing resumes correctly
 */
export async function verifyStartupRecovery(_io: Server): Promise<void> {
  try {
    logInfo('Starting recovery verification', {});
    const redis = getRedis();
    const startTime = Date.now();
    
    let activeCallIds: string[] = [];
    if (isBullmqBillingEnabled()) {
      const seen = new Set<string>();
      let cursor = '0';
      do {
        const scanResult = await redis.scan(cursor, 'MATCH', `${CALL_SESSION_PREFIX}*`, 'COUNT', '200');
        cursor = scanResult[0];
        const keys = scanResult[1] || [];
        for (const key of keys) {
          const callId = key.replace(CALL_SESSION_PREFIX, '');
          if (callId) seen.add(callId);
        }
      } while (cursor !== '0' && seen.size < 2000);
      activeCallIds = Array.from(seen);
    } else {
      // Get all active calls from Redis sorted set
      // Get all calls (score doesn't matter for verification)
      activeCallIds = await redis.zrange(ACTIVE_BILLING_CALLS_KEY, 0, -1);
    }
    
    // Handle both string array and object array responses
    const callIds: string[] = Array.isArray(activeCallIds)
      ? activeCallIds.map((item: any) => 
          typeof item === 'string' ? item : (item?.member || item?.value || String(item))
        )
      : [];
    
    if (callIds.length === 0) {
      logInfo('No active calls found on startup', {});
      recordBillingMetric('recovery_verified', 1, { activeCalls: '0' });
      return;
    }
    
    logInfo('Found active calls on startup', { count: callIds.length });
    
    // Verify each call has a valid session; under BullMQ ensure delayed cycle jobs exist (bounded).
    let validCalls = 0;
    let invalidCalls = 0;
    let bullmqCyclesEnsured = 0;
    const ensureMax = readStartupEnsureMax();

    for (const callId of callIds) {
      try {
        const sessionRaw = await redis.get(callSessionKey(callId));
        if (sessionRaw) {
          validCalls++;
          if (
            isBullmqBillingEnabled() &&
            bullmqCyclesEnsured < ensureMax &&
            (await needsBillingCycleReschedule(callId))
          ) {
            await scheduleBillingJob(callId, BILLING_PROCESS_INTERVAL_MS).catch((err) =>
              logError('Startup: ensure billing cycle job failed', err, { callId })
            );
            bullmqCyclesEnsured++;
            recordBillingMetric('recovery_bullmq_cycle_ensured', 1, { callId });
          }
        } else {
          invalidCalls++;
          logWarning('Active call has no session - will be cleaned up by batch processor', { callId });
        }
      } catch (err) {
        logError('Error verifying call session', err, { callId });
        invalidCalls++;
      }
    }
    
    const duration = Date.now() - startTime;
    
    logInfo('Recovery verification completed', {
      totalCalls: callIds.length,
      validCalls,
      invalidCalls,
      bullmqCyclesEnsured,
      duration,
    });
    
    recordBillingMetric('recovery_verified', 1, {
      totalCalls: callIds.length.toString(),
      validCalls: validCalls.toString(),
      invalidCalls: invalidCalls.toString(),
    });
    
    // Alert if there are many invalid calls (potential issue)
    if (invalidCalls > 0 && invalidCalls > callIds.length * 0.1) {
      logWarning('High number of invalid calls detected on startup', {
        invalidCalls,
        totalCalls: callIds.length,
        percentage: ((invalidCalls / callIds.length) * 100).toFixed(2) + '%',
      });
      recordBillingMetric('recovery_invalid_calls_high', 1, {
        invalidCalls: invalidCalls.toString(),
        totalCalls: callIds.length.toString(),
      });
    }
    
    if (validCalls > 0) {
      logInfo(
        isBullmqBillingEnabled()
          ? 'Active calls: BullMQ cycle jobs ensured where missing (bounded)'
          : 'Active calls will be processed by batch processor',
        { validCalls, note: isBullmqBillingEnabled() ? 'billing-cycle queue' : '1s ZSET batch' }
      );
    }
    
  } catch (error) {
    logError('Recovery verification failed', error);
    recordBillingMetric('recovery_verification_failed', 1, {});
    // Don't throw - this is a verification step, not critical for startup
  }
}
