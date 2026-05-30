/**
 * Durable Stream mark_ended retries when BullMQ termination queue is disabled (ZSET / single-replica mode).
 * Processed from the billing reconciliation loop (same lock / cadence as DLQ).
 */

import { Server } from 'socket.io';
import { getRedis } from '../../config/redis';
import { isCallActive } from './billing-active-call.service';
import {
  hasCallEndedMarker,
  releaseMarkEndedLease,
  setCallEndedMarker,
  tryAcquireMarkEndedLease,
} from './billing-termination.state';
import { markStreamCallEnded } from './billing-termination.stream';
import { recordBillingMetric } from '../../utils/monitoring';
import { logError, logInfo, logWarning } from '../../utils/logger';
import { isBullmqBillingEnabled } from './billing-driver';

export const TERMINATION_REDIS_RETRY_ZSET = 'billing:termination:mark_ended:retry';

export interface TerminationRedisRetryPayload {
  callId: string;
  userFirebaseUid: string;
  creatorFirebaseUid: string;
  reason: string;
  attempt: number;
}

function readMaxAttempts(): number {
  const raw = parseInt(process.env.BILLING_TERMINATION_REDIS_MAX_ATTEMPTS || '12', 10);
  if (!Number.isFinite(raw) || raw <= 0) return 12;
  return Math.min(50, Math.max(1, raw));
}

function readBaseDelayMs(): number {
  const raw = parseInt(process.env.BILLING_TERMINATION_REDIS_BASE_DELAY_MS || '2000', 10);
  if (!Number.isFinite(raw) || raw <= 0) return 2000;
  return Math.min(120_000, Math.max(250, raw));
}

function readBatchSize(): number {
  const raw = parseInt(process.env.BILLING_TERMINATION_REDIS_BATCH_SIZE || '20', 10);
  if (!Number.isFinite(raw) || raw <= 0) return 20;
  return Math.min(100, Math.max(1, raw));
}

function payloadKey(callId: string): string {
  return `${TERMINATION_REDIS_RETRY_ZSET}:payload:${callId}`;
}

export async function enqueueTerminationRedisRetry(data: {
  callId: string;
  userFirebaseUid: string;
  creatorFirebaseUid: string;
  reason: string;
}): Promise<void> {
  if (isBullmqBillingEnabled()) {
    return;
  }
  const redis = getRedis();
  const payload: TerminationRedisRetryPayload = {
    ...data,
    attempt: 0,
  };
  const member = data.callId;
  const score = Date.now();
  await redis.setex(payloadKey(member), 86400, JSON.stringify(payload)).catch(() => {});
  await redis.zadd(TERMINATION_REDIS_RETRY_ZSET, score, member);
  recordBillingMetric('termination_redis_retry_enqueued', 1, { callId: data.callId });
}

export async function processTerminationRedisRetries(
  _io: Server,
  startedAt: number,
  runBudgetMs: number
): Promise<void> {
  if (isBullmqBillingEnabled()) {
    return;
  }
  const redis = getRedis();
  const now = Date.now();
  const batch = readBatchSize();
  const due = await redis.zrangebyscore(
    TERMINATION_REDIS_RETRY_ZSET,
    0,
    now,
    'LIMIT',
    0,
    batch
  );
  const callIds: string[] = Array.isArray(due) ? due : [];
  if (callIds.length === 0) return;

  const maxAttempts = readMaxAttempts();
  const baseDelay = readBaseDelayMs();

  for (const callId of callIds) {
    if (Date.now() - startedAt > runBudgetMs) {
      break;
    }
    const raw = await redis.get(payloadKey(callId));
    if (!raw) {
      await redis.zrem(TERMINATION_REDIS_RETRY_ZSET, callId).catch(() => {});
      continue;
    }
    let payload: TerminationRedisRetryPayload;
    try {
      payload = JSON.parse(raw) as TerminationRedisRetryPayload;
    } catch {
      await redis.del(payloadKey(callId)).catch(() => {});
      await redis.zrem(TERMINATION_REDIS_RETRY_ZSET, callId).catch(() => {});
      continue;
    }

    if (await hasCallEndedMarker(callId)) {
      await redis.del(payloadKey(callId)).catch(() => {});
      await redis.zrem(TERMINATION_REDIS_RETRY_ZSET, callId).catch(() => {});
      recordBillingMetric('termination_redis_retry_skipped', 1, { callId, reason: 'already_marked' });
      continue;
    }

    const acquired = await tryAcquireMarkEndedLease(callId);
    if (!acquired) {
      const next = Date.now() + baseDelay;
      await redis.zadd(TERMINATION_REDIS_RETRY_ZSET, next, callId);
      recordBillingMetric('termination_redis_retry_deferred', 1, { callId, reason: 'lease' });
      continue;
    }

    const stillActive = await isCallActive(redis, {
      callId,
      userFirebaseUid: payload.userFirebaseUid,
      creatorFirebaseUid: payload.creatorFirebaseUid,
    });
    if (!stillActive) {
      await releaseMarkEndedLease(callId);
      await redis.del(payloadKey(callId)).catch(() => {});
      await redis.zrem(TERMINATION_REDIS_RETRY_ZSET, callId).catch(() => {});
      recordBillingMetric('termination_redis_retry_skipped', 1, { callId, reason: 'inactive' });
      continue;
    }

    try {
      const streamResult = await markStreamCallEnded(callId, payload.reason);
      await setCallEndedMarker(callId);
      await releaseMarkEndedLease(callId);
      await redis.del(payloadKey(callId)).catch(() => {});
      await redis.zrem(TERMINATION_REDIS_RETRY_ZSET, callId).catch(() => {});
      recordBillingMetric('termination_redis_retry_success', 1, {
        callId,
        streamResult: streamResult.outcome,
      });
      if (streamResult.outcome === 'not_found') {
        recordBillingMetric('termination_redis_retry_not_found_idempotent', 1, { callId });
        logInfo('Termination redis retry: mark_ended idempotent not_found', { callId });
      } else {
        logInfo('Termination redis retry: mark_ended succeeded', { callId });
      }
    } catch (err) {
      await releaseMarkEndedLease(callId);
      payload.attempt += 1;
      if (payload.attempt >= maxAttempts) {
        await redis.del(payloadKey(callId)).catch(() => {});
        await redis.zrem(TERMINATION_REDIS_RETRY_ZSET, callId).catch(() => {});
        recordBillingMetric('termination_redis_retry_exhausted', 1, { callId });
        logError('Termination redis retry exhausted', err, { callId, attempts: payload.attempt });
        continue;
      }
      const delay = Math.min(120_000, baseDelay * Math.pow(2, Math.min(payload.attempt, 8)));
      const next = Date.now() + delay;
      await redis.setex(payloadKey(callId), 86400, JSON.stringify(payload)).catch(() => {});
      await redis.zadd(TERMINATION_REDIS_RETRY_ZSET, next, callId);
      recordBillingMetric('termination_redis_retry_scheduled', 1, { callId, attempt: String(payload.attempt) });
      logWarning('Termination redis retry: mark_ended failed, rescheduled', {
        callId,
        attempt: payload.attempt,
        nextInMs: delay,
      });
    }
  }
}
