/**
 * Shared BullMQ Redis connection for image-pipeline workers.
 * (blurhash queue, orphan-cleanup queue, future moderation queue.)
 *
 * Per the plan §16: workers MUST set lockDuration / concurrency /
 * removeOnComplete / removeOnFail explicitly. This module centralizes
 * the connection factory; queue tuning lives in the per-queue file.
 */

import Redis from 'ioredis';

let shared: Redis | null = null;

function createConnection(): Redis {
  const url = process.env.REDIS_URL || process.env.REDIS_PUBLIC_URL;
  if (url) {
    return new Redis(url, { maxRetriesPerRequest: null });
  }
  const host = process.env.REDISHOST;
  if (!host) {
    throw new Error('Image workers require REDIS_URL or REDISHOST');
  }
  return new Redis({
    host,
    port: parseInt(process.env.REDISPORT || '6379', 10),
    password: process.env.REDIS_PASSWORD || process.env.REDISPASSWORD,
    username: process.env.REDISUSER,
    maxRetriesPerRequest: null,
  });
}

export function getImageWorkerConnection(): Redis {
  if (!shared) {
    shared = createConnection();
  }
  return shared;
}

/** BullMQ requires distinct duplicates for queue/worker to avoid blocking ops. */
export function duplicateImageWorkerConnection(): Redis {
  return getImageWorkerConnection().duplicate();
}

export async function closeImageWorkerConnection(): Promise<void> {
  if (shared) {
    await shared.quit().catch(() => undefined);
    shared = null;
  }
}
