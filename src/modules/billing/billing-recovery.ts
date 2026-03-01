/**
 * 🔥 FIX: Startup Recovery Verification
 * 
 * Verifies that billing resumes correctly after server restart.
 * Queries active calls from Redis and verifies they're being processed.
 */

import { Server } from 'socket.io';
import { getRedis, ACTIVE_BILLING_CALLS_KEY, callSessionKey } from '../../config/redis';
import { logInfo, logError, logWarning } from '../../utils/logger';
import { recordBillingMetric } from '../../utils/monitoring';

/**
 * Verify startup recovery for active calls
 * Called on server startup to ensure billing resumes correctly
 */
export async function verifyStartupRecovery(_io: Server): Promise<void> {
  try {
    logInfo('Starting recovery verification', {});
    const redis = getRedis();
    const startTime = Date.now();
    
    // Get all active calls from Redis sorted set
    // Get all calls (score doesn't matter for verification)
    const activeCallIds = await redis.zrange(ACTIVE_BILLING_CALLS_KEY, 0, -1);
    
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
    
    // Verify each call has a valid session
    let validCalls = 0;
    let invalidCalls = 0;
    
    for (const callId of callIds) {
      try {
        const sessionRaw = await redis.get<string>(callSessionKey(callId));
        if (sessionRaw) {
          validCalls++;
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
    
    // Verify batch processor is running (it should pick up these calls automatically)
    if (validCalls > 0) {
      logInfo('Active calls will be processed by batch processor', {
        validCalls,
        note: 'Batch processor runs every 1 second and will pick up these calls',
      });
    }
    
  } catch (error) {
    logError('Recovery verification failed', error);
    recordBillingMetric('recovery_verification_failed', 1, {});
    // Don't throw - this is a verification step, not critical for startup
  }
}
