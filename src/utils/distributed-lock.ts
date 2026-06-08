import { randomUUID } from 'crypto';
import { getRedis } from '../config/redis';
import { logInfo, logWarning } from './logger';

const RELEASE_LOCK_LUA = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0
`;

export type DistributedLockOptions = {
  key: string;
  ttlMs: number;
  ownerId: string;
  heartbeat?: boolean;
  onSkipped?: () => void;
};

export type DistributedLockHandle = {
  key: string;
  token: string;
  ownerId: string;
  release: () => Promise<void>;
};

function logLockEvent(
  event: 'lock.acquired' | 'lock.released' | 'lock.expired' | 'lock.skipped' | 'lock.heartbeat_failed',
  key: string,
  ownerId: string,
  extra?: Record<string, unknown>
): void {
  const payload = { event, lockKey: key, instanceId: ownerId, ...extra };
  if (event === 'lock.heartbeat_failed' || event === 'lock.expired') {
    logWarning('distributed_lock', payload);
  } else {
    logInfo('distributed_lock', payload);
  }
}

export async function releaseDistributedLock(key: string, token: string, ownerId: string): Promise<void> {
  const redis = getRedis();
  try {
    const released = await redis.eval(RELEASE_LOCK_LUA, 1, key, token);
    if (released === 1) {
      logLockEvent('lock.released', key, ownerId);
    }
  } catch {
    logLockEvent('lock.expired', key, ownerId, { reason: 'release_eval_failed' });
  }
}

export async function acquireDistributedLock(
  options: DistributedLockOptions
): Promise<DistributedLockHandle | null> {
  const redis = getRedis();
  const token = randomUUID();
  const lockResult = await redis.set(options.key, token, 'PX', options.ttlMs, 'NX');
  if (lockResult !== 'OK') {
    logLockEvent('lock.skipped', options.key, options.ownerId);
    options.onSkipped?.();
    return null;
  }

  logLockEvent('lock.acquired', options.key, options.ownerId, { ttlMs: options.ttlMs });

  let heartbeatTimer: NodeJS.Timeout | null = null;
  if (options.heartbeat) {
    const heartbeatIntervalMs = Math.max(1000, Math.floor(options.ttlMs / 3));
    heartbeatTimer = setInterval(() => {
      redis
        .set(options.key, token, 'PX', options.ttlMs, 'XX')
        .then((result) => {
          if (result !== 'OK') {
            logLockEvent('lock.heartbeat_failed', options.key, options.ownerId);
          }
        })
        .catch(() => {
          logLockEvent('lock.heartbeat_failed', options.key, options.ownerId, {
            reason: 'redis_error',
          });
        });
    }, heartbeatIntervalMs);
  }

  return {
    key: options.key,
    token,
    ownerId: options.ownerId,
    release: async () => {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      await releaseDistributedLock(options.key, token, options.ownerId);
    },
  };
}

/**
 * Runs task only when this replica acquires the cluster lock.
 * @returns true if lock acquired and task ran (or threw), false if skipped.
 */
export async function withDistributedLock(
  options: DistributedLockOptions,
  task: () => Promise<void>
): Promise<boolean> {
  const handle = await acquireDistributedLock(options);
  if (!handle) return false;

  try {
    await task();
    return true;
  } finally {
    await handle.release();
  }
}
