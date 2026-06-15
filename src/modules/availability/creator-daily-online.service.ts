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

export async function getBatchOnlineTodaySecondsLive(
  creatorFirebaseUids: string[]
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  const unique = [...new Set(creatorFirebaseUids.filter((uid) => uid.length > 0))];
  if (unique.length === 0) return result;

  const { periodStart, periodEnd } = getDailyPeriodBounds();
  const docs = await CreatorDailyOnline.find({
    creatorFirebaseUid: { $in: unique },
    periodStart,
  })
    .select('creatorFirebaseUid onlineSeconds')
    .lean();

  for (const doc of docs) {
    result.set(doc.creatorFirebaseUid, doc.onlineSeconds ?? 0);
  }
  for (const uid of unique) {
    if (!result.has(uid)) result.set(uid, 0);
  }

  const redis = getRedis();
  const sinceKeys = unique.map(creatorAvailOnlineSinceKey);
  const presenceKeys = unique.map(creatorPresenceKey);
  const [sinceRaws, presenceRaws] = await Promise.all([
    redis.mget(...sinceKeys),
    redis.mget(...presenceKeys),
  ]);

  const now = Date.now();
  const pStartMs = periodStart.getTime();
  const pEndMs = periodEnd.getTime();

  for (let i = 0; i < unique.length; i++) {
    const uid = unique[i];
    let seconds = result.get(uid) ?? 0;
    const sinceRaw = sinceRaws[i];
    const presenceRaw = presenceRaws[i];

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
        const overlapStart = Math.max(startMs, pStartMs);
        const overlapEnd = Math.min(now, pEndMs);
        if (overlapEnd > overlapStart) {
          seconds += Math.floor((overlapEnd - overlapStart) / 1000);
        }
      }
    }

    result.set(uid, seconds);
  }

  return result;
}

/**
 * Stored seconds for current task period + live tail if Redis says online and session key is set.
 */
export async function getOnlineTodaySecondsLive(
  creatorFirebaseUid: string
): Promise<{ onlineTodaySeconds: number; onlineTodayResetsAt: string }> {
  const { resetsAt } = getDailyPeriodBounds();
  const map = await getBatchOnlineTodaySecondsLive([creatorFirebaseUid]);
  return {
    onlineTodaySeconds: map.get(creatorFirebaseUid) ?? 0,
    onlineTodayResetsAt: resetsAt.toISOString(),
  };
}
