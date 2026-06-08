import { getRedis } from '../../config/redis';
import { User } from '../user/user.model';
import { logWarning } from '../../utils/logger';

export const PRESENCE_BATCH_LOOKUP_MAX = Math.min(
  500,
  Math.max(1, parseInt(process.env.PRESENCE_BATCH_LOOKUP_MAX || '100', 10) || 100)
);

const PRESENCE_LOOKUP_RATE_LIMIT_MAX = Math.min(
  60,
  Math.max(5, parseInt(process.env.PRESENCE_LOOKUP_RATE_LIMIT_MAX || '20', 10) || 20)
);
const PRESENCE_LOOKUP_RATE_LIMIT_WINDOW_SECONDS = Math.min(
  300,
  Math.max(10, parseInt(process.env.PRESENCE_LOOKUP_RATE_LIMIT_WINDOW_SECONDS || '60', 10) || 60)
);
const PRESENCE_LOOKUP_RATE_PREFIX = 'rate_limit:presence_lookup:';

export function isPresenceLookupAuthEnforced(): boolean {
  return process.env.PRESENCE_LOOKUP_AUTH_ENFORCED !== 'false';
}

export async function assertCreatorOrAdminForPresenceLookup(
  firebaseUid: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!isPresenceLookupAuthEnforced()) {
    return { ok: true };
  }

  const caller = await User.findOne({ firebaseUid }).select('role').lean();
  const isCreator = caller?.role === 'creator' || caller?.role === 'admin';
  if (!isCreator) {
    return { ok: false, error: 'FORBIDDEN' };
  }
  return { ok: true };
}

export function capPresenceLookupBatch<T>(items: T[]): T[] {
  if (items.length <= PRESENCE_BATCH_LOOKUP_MAX) return items;
  logWarning('presence_lookup_batch_capped', {
    requested: items.length,
    cap: PRESENCE_BATCH_LOOKUP_MAX,
  });
  return items.slice(0, PRESENCE_BATCH_LOOKUP_MAX);
}

export async function checkPresenceLookupRateLimit(socketId: string): Promise<{
  allowed: boolean;
  remaining: number;
}> {
  const redis = getRedis();
  const key = `${PRESENCE_LOOKUP_RATE_PREFIX}${socketId}`;
  const windowSeconds = PRESENCE_LOOKUP_RATE_LIMIT_WINDOW_SECONDS;
  const limit = PRESENCE_LOOKUP_RATE_LIMIT_MAX;

  try {
    const count = await redis.incr(key);
    if (count === 1) {
      await redis.expire(key, windowSeconds);
    }
    if (count > limit) {
      return { allowed: false, remaining: 0 };
    }
    return { allowed: true, remaining: Math.max(0, limit - count) };
  } catch {
    return { allowed: true, remaining: limit };
  }
}
