/**
 * Optional BullMQ driver for video-call billing (horizontal scaling without ZSET batch lock).
 * Enable with BILLING_DRIVER=bullmq
 */

import { Queue, Worker } from 'bullmq';
import Redis from 'ioredis';
import { BILLING_PROCESS_INTERVAL_MS } from './billing.constants';
import { getIO } from '../../config/socket';
import { billingService } from './billing.service';
import { logError, logInfo, logWarning } from '../../utils/logger';
import { recordBillingMetric } from '../../utils/monitoring';
import { getRedis, callSessionKey } from '../../config/redis';

const QUEUE_NAME = 'billing-cycle';

let sharedConnection: Redis | null = null;
let billingQueue: Queue | null = null;
let billingWorker: Worker | null = null;

export function isBullmqBillingEnabled(): boolean {
  return process.env.BILLING_DRIVER === 'bullmq';
}

function createRedisConnection(): Redis {
  const url = process.env.REDIS_URL || process.env.REDIS_PUBLIC_URL;
  if (url) {
    return new Redis(url, { maxRetriesPerRequest: null });
  }
  const host = process.env.REDISHOST;
  if (!host) {
    throw new Error('BILLING_DRIVER=bullmq requires REDIS_URL or REDISHOST');
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
  if (!billingQueue) {
    billingQueue = new Queue(QUEUE_NAME, {
      connection: getSharedConnection().duplicate(),
    });
  }
  return billingQueue;
}

/**
 * Schedule the next billing cycle for a call (chain of delayed jobs).
 */
export async function scheduleBillingJob(
  callId: string,
  delayMs: number = BILLING_PROCESS_INTERVAL_MS
): Promise<void> {
  const q = getQueue();
  await q.add(
    'cycle',
    { callId },
    {
      delay: delayMs,
      removeOnComplete: 500,
      removeOnFail: 200,
    }
  );
}

export function startBillingBullWorker(): Worker {
  if (billingWorker) {
    logWarning('Billing BullMQ worker already running', {});
    return billingWorker;
  }

  logInfo('Starting BullMQ billing worker', { queue: QUEUE_NAME });

  billingWorker = new Worker(
    QUEUE_NAME,
    async (job) => {
      const { callId } = job.data as { callId: string };
      const io = getIO();
      let result: Awaited<ReturnType<typeof billingService.processBillingTick>>;
      try {
        result = await billingService.processBillingTick(io, callId);
      } catch (err) {
        logError('BullMQ billing job threw', err, { callId });
        try {
          const redis = getRedis();
          const exists = await redis.exists(callSessionKey(callId));
          if (exists === 1) {
            await scheduleBillingJob(callId, BILLING_PROCESS_INTERVAL_MS * 2);
          }
        } catch (rescheduleErr) {
          logError('BullMQ reschedule after throw failed', rescheduleErr, { callId });
        }
        recordBillingMetric('bullmq_tick_rescheduled', 1, { callId });
        return 'retry_scheduled';
      }

      if (result === 'tick_ok') {
        await scheduleBillingJob(callId, BILLING_PROCESS_INTERVAL_MS).catch((e) =>
          logError('BullMQ schedule next failed', e, { callId })
        );
      } else if (result === 'stop_needs_settlement') {
        const { settleCall } = await import('./billing-settlement.service');
        await settleCall(io, callId).catch((e) => logError('settleCall failed', e, { callId }));
      }
      return result;
    },
    {
      connection: getSharedConnection().duplicate(),
      concurrency: Number(process.env.BILLING_BULLMQ_CONCURRENCY || 50),
    }
  );

  billingWorker.on('failed', (job, err) => {
    logError('BullMQ billing job failed', err, { jobId: job?.id, callId: job?.data?.callId });
  });

  return billingWorker;
}

export async function closeBillingBullMq(): Promise<void> {
  await billingWorker?.close();
  await billingQueue?.close();
  if (sharedConnection) {
    await sharedConnection.quit();
  }
  billingWorker = null;
  billingQueue = null;
  sharedConnection = null;
}
