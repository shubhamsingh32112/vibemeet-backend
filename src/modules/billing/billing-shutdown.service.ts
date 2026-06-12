import { getRedis, callSessionKey } from '../../config/redis';
import { getBillingInstanceId } from './billing-instance-id';
import {
  freezeDurableCallSessionsForShutdown,
  mirrorRedisSessionToDurableCallSession,
} from './call-session.service';
import { flushBillingPersistForCallId } from './billing-persist.service';
import { isDurableCallSessionEnabled, isIncrementalBillingPersistEnabled } from './billing-phase-flags';
import { logInfo } from '../../utils/logger';
import type { CallSession as RedisCallSession } from './billing.service';

let shuttingDown = false;

export function isShuttingDown(): boolean {
  return shuttingDown;
}

export function markShuttingDown(): void {
  shuttingDown = true;
  logInfo('billing_shutdown_admission_freeze_enabled', {
    instanceId: getBillingInstanceId(),
  });
}

export class ShutdownAdmissionRejectedError extends Error {
  constructor(public readonly operation: string) {
    super(`Operation rejected during shutdown: ${operation}`);
    this.name = 'ShutdownAdmissionRejectedError';
  }
}

export function assertNotShuttingDown(operation: string): void {
  if (shuttingDown) {
    throw new ShutdownAdmissionRejectedError(operation);
  }
}

export async function flushOwnedSessionsToMongoOnShutdown(): Promise<void> {
  if (!isDurableCallSessionEnabled()) return;

  const instanceId = getBillingInstanceId();
  const callIds = await freezeDurableCallSessionsForShutdown(instanceId);
  const redis = getRedis();

  for (const callId of callIds) {
    try {
      if (isIncrementalBillingPersistEnabled()) {
        await flushBillingPersistForCallId(callId, 'deployment_shutdown');
        continue;
      }
      const raw = await redis.get(callSessionKey(callId));
      if (!raw) continue;
      const session = JSON.parse(raw) as RedisCallSession;
      await mirrorRedisSessionToDurableCallSession(callId, session);
    } catch {
      // best-effort per call
    }
  }

  logInfo('billing_shutdown_flush_complete', {
    instanceId,
    sessionCount: callIds.length,
  });
}
