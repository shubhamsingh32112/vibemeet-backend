import { Queue, Worker } from 'bullmq';
import Redis from 'ioredis';
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
import { terminateCallJobId } from './billing-termination.job-id';

export { terminateCallJobId } from './billing-termination.job-id';

const QUEUE_NAME = 'billing-termination-retry';
const DEFAULT_ATTEMPTS = 6;
const DEFAULT_BASE_DELAY_MS = 2000;

interface TerminationRetryJobData {
  callId: string;
  userFirebaseUid: string;
  creatorFirebaseUid: string;
  reason: string;
}

let sharedConnection: Redis | null = null;
let terminationRetryQueue: Queue | null = null;
let terminationRetryWorker: Worker | null = null;

function isTerminationRetryEnabled(): boolean {
  return process.env.BILLING_TERMINATION_RETRY_ENABLED !== 'false';
}

function readRetryAttempts(): number {
  const raw = parseInt(process.env.BILLING_TERMINATION_RETRY_ATTEMPTS || '', 10);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_ATTEMPTS;
  return Math.min(20, Math.max(1, raw));
}

function readRetryBaseDelayMs(): number {
  const raw = parseInt(process.env.BILLING_TERMINATION_RETRY_BASE_DELAY_MS || '', 10);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_BASE_DELAY_MS;
  return Math.min(60_000, Math.max(250, raw));
}

function createRedisConnection(): Redis {
  const url = process.env.REDIS_URL || process.env.REDIS_PUBLIC_URL;
  if (url) {
    return new Redis(url, { maxRetriesPerRequest: null });
  }
  const host = process.env.REDISHOST;
  if (!host) {
    throw new Error('Termination retry queue requires REDIS_URL or REDISHOST');
  }
  const port = parseInt(process.env.REDISPORT || '6379', 10);
  const password = process.env.REDIS_PASSWORD || process.env.REDISPASSWORD;
  const username = process.env.REDISUSER;
  return new Redis({
    host,
    port,
    password,
    username,
    maxRetriesPerRequest: null,
  });
}

function getSharedConnection(): Redis {
  if (!sharedConnection) {
    sharedConnection = createRedisConnection();
  }
  return sharedConnection;
}

function getQueue(): Queue {
  if (!terminationRetryQueue) {
    terminationRetryQueue = new Queue(QUEUE_NAME, {
      connection: getSharedConnection().duplicate(),
    });
  }
  return terminationRetryQueue;
}

export async function enqueueTerminationRetryJob(data: TerminationRetryJobData): Promise<void> {
  if (!isBullmqBillingEnabled() || !isTerminationRetryEnabled()) {
    recordBillingMetric('force_terminate_retry_skipped', 1, { reason: 'disabled' });
    return;
  }

  const q = getQueue();
  const jobId = terminateCallJobId(data.callId);

  const existing = await q.getJob(jobId);
  if (existing) {
    try {
      await existing.remove();
      recordBillingMetric('force_terminate_retry_replaced', 1, { callId: data.callId });
    } catch {
      recordBillingMetric('force_terminate_retry_replace_race', 1, { callId: data.callId });
    }
  }

  let attempts = 0;
  const maxAttempts = 3;
  while (attempts < maxAttempts) {
    attempts += 1;
    try {
      await q.add('retry-mark-ended', data, {
        jobId,
        attempts: readRetryAttempts(),
        backoff: {
          type: 'exponential',
          delay: readRetryBaseDelayMs(),
        },
        removeOnComplete: 500,
        removeOnFail: 200,
      });
      recordBillingMetric('force_terminate_retry_enqueued', 1, { callId: data.callId });
      return;
    } catch (err) {
      if (attempts >= maxAttempts) {
        logError('Failed to enqueue termination retry after retries', err, { callId: data.callId });
        throw err;
      }
      await new Promise((r) => setTimeout(r, 50 * attempts));
    }
  }
}

export function startTerminationRetryWorker(): Worker | null {
  if (!isBullmqBillingEnabled() || !isTerminationRetryEnabled()) {
    return null;
  }
  if (terminationRetryWorker) {
    logWarning('Termination retry BullMQ worker already running', {});
    return terminationRetryWorker;
  }

  logInfo('Starting termination retry BullMQ worker', { queue: QUEUE_NAME });
  terminationRetryWorker = new Worker(
    QUEUE_NAME,
    async (job) => {
      const data = job.data as TerminationRetryJobData;
      const { callId, reason, userFirebaseUid, creatorFirebaseUid } = data;

      if (await hasCallEndedMarker(callId)) {
        recordBillingMetric('force_terminate_retry_skipped', 1, {
          callId,
          reason: 'already_marked_ended',
        });
        return 'already_ended';
      }

      const acquired = await tryAcquireMarkEndedLease(callId);
      if (!acquired) {
        recordBillingMetric('force_terminate_retry_skipped', 1, {
          callId,
          reason: 'lease_not_acquired',
        });
        return 'deduped';
      }

      const redis = getRedis();
      const stillActive = await isCallActive(redis, {
        callId,
        userFirebaseUid,
        creatorFirebaseUid,
        includeLegacySchedulerCheck: !isBullmqBillingEnabled(),
      });
      if (!stillActive) {
        await releaseMarkEndedLease(callId);
        recordBillingMetric('force_terminate_retry_skipped', 1, {
          callId,
          reason: 'inactive',
        });
        return 'inactive';
      }

      try {
        await markStreamCallEnded(callId, reason);
        await setCallEndedMarker(callId);
        await releaseMarkEndedLease(callId);
        recordBillingMetric('force_terminate_retry_success', 1, { callId, reason });
        return 'retry_success';
      } catch (err) {
        await releaseMarkEndedLease(callId);
        throw err;
      }
    },
    {
      connection: getSharedConnection().duplicate(),
      concurrency: 5,
    }
  );

  terminationRetryWorker.on('failed', (job, err) => {
    recordBillingMetric('force_terminate_retry_failed', 1, {
      callId: job?.data?.callId ? String(job.data.callId) : 'unknown',
    });
    logError('Termination retry job failed', err, {
      callId: job?.data?.callId,
      attemptsMade: job?.attemptsMade,
    });
  });

  return terminationRetryWorker;
}

export async function closeTerminationRetryQueue(): Promise<void> {
  await terminationRetryWorker?.close();
  await terminationRetryQueue?.close();
  if (sharedConnection) {
    await sharedConnection.quit();
  }
  terminationRetryWorker = null;
  terminationRetryQueue = null;
  sharedConnection = null;
}
