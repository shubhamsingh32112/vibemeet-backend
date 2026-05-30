import { getRedis, creatorAvailOnlineSinceKey, creatorPresenceKey } from '../../config/redis';
import { getDailyPeriodBounds, getDailyPeriodBoundsForInstant } from '../creator/creator-tasks.config';
import { CreatorDailyOnline } from './creator-daily-online.model';
import { logError } from '../../utils/logger';

/**
 * Accumulate whole seconds of "online" (Redis availability = online) per task period,
 * splitting intervals that cross the 23:59 boundary.
 */
/**
 * Whole seconds of [fromMs, toMs) split by task-day periods (for tests and addOnlineDuration).
 */
export function allocateSecondsByPeriodStartMs(
  fromMs: number,
  toMs: number
): Map<number, number> {
  const out = new Map<number, number>();
  if (toMs <= fromMs) return out;
  let cursor = fromMs;
  while (cursor < toMs) {
    const { periodStart, periodEnd } = getDailyPeriodBoundsForInstant(new Date(cursor));
    const pEnd = periodEnd.getTime();
    const end = Math.min(toMs, pEnd);
    const seconds = Math.floor((end - cursor) / 1000);
    if (seconds > 0) {
      const k = periodStart.getTime();
      out.set(k, (out.get(k) ?? 0) + seconds);
    }
    cursor = end;
  }
  return out;
}

export async function addOnlineDuration(
  creatorFirebaseUid: string,
  fromMs: number,
  toMs: number
): Promise<void> {
  const byPeriod = allocateSecondsByPeriodStartMs(fromMs, toMs);
  for (const [periodStartMs, seconds] of byPeriod) {
    await CreatorDailyOnline.findOneAndUpdate(
      { creatorFirebaseUid, periodStart: new Date(periodStartMs) },
      { $inc: { onlineSeconds: seconds } },
      { upsert: true, new: true }
    );
  }
}

export async function recordCreatorAvailabilityBecameOnline(
  creatorFirebaseUid: string
): Promise<void> {
  try {
    const redis = getRedis();
    const k = creatorAvailOnlineSinceKey(creatorFirebaseUid);
    const existing = await redis.get(k);
    if (!existing) {
      await redis.set(k, String(Date.now()));
    }
  } catch (err) {
    logError('recordCreatorAvailabilityBecameOnline failed', err, { creatorFirebaseUid });
  }
}

export async function recordCreatorAvailabilityBecameBusy(
  creatorFirebaseUid: string
): Promise<void> {
  try {
    const redis = getRedis();
    const k = creatorAvailOnlineSinceKey(creatorFirebaseUid);
    const raw = await redis.get(k);
    await redis.del(k);
    if (raw) {
      const startMs = parseInt(raw, 10);
      if (!Number.isNaN(startMs)) {
        await addOnlineDuration(creatorFirebaseUid, startMs, Date.now());
      }
    }
  } catch (err) {
    logError('recordCreatorAvailabilityBecameBusy failed', err, { creatorFirebaseUid });
  }
}

/**
 * Stored seconds for current task period + live tail if Redis says online and session key is set.
 */
export async function getOnlineTodaySecondsLive(
  creatorFirebaseUid: string
): Promise<{ onlineTodaySeconds: number; onlineTodayResetsAt: string }> {
  const { periodStart, periodEnd, resetsAt } = getDailyPeriodBounds();
  const redis = getRedis();

  const doc = await CreatorDailyOnline.findOne({
    creatorFirebaseUid,
    periodStart,
  })
    .select('onlineSeconds')
    .lean();

  let seconds = doc?.onlineSeconds ?? 0;

  const sinceRaw = await redis.get(creatorAvailOnlineSinceKey(creatorFirebaseUid));
  const presenceRaw = await redis.get(creatorPresenceKey(creatorFirebaseUid));
  let avail: 'online' | 'on_call' | 'offline' = 'offline';
  if (presenceRaw) {
    try {
      const parsed = JSON.parse(presenceRaw) as { state?: string } | null;
      if (parsed?.state === 'online') {
        avail = 'online';
      }
    } catch {
      // No-op: malformed canonical payload should not break online-time stats.
    }
  }

  if (sinceRaw && avail === 'online') {
    const startMs = parseInt(sinceRaw, 10);
    if (!Number.isNaN(startMs)) {
      const now = Date.now();
      const pStartMs = periodStart.getTime();
      const pEndMs = periodEnd.getTime();
      const overlapStart = Math.max(startMs, pStartMs);
      const overlapEnd = Math.min(now, pEndMs);
      if (overlapEnd > overlapStart) {
        seconds += Math.floor((overlapEnd - overlapStart) / 1000);
      }
    }
  }

  return {
    onlineTodaySeconds: seconds,
    onlineTodayResetsAt: resetsAt.toISOString(),
  };
}
