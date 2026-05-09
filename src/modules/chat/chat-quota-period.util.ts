import type { ClientSession } from 'mongoose';
import type { IChatMessageQuota } from './chat-message-quota.model';
import { getDailyPeriodBounds } from '../creator/creator-tasks.config';

/**
 * Aligns quota.freeMessagesSent with the current creator-task day (23:59 server-local boundary).
 * On first touch after deploy (missing freeQuotaPeriodStart) or when the period rolls,
 * resets freeMessagesSent to 0 so users get a fresh daily allowance per creator.
 */
export async function normalizeQuotaForCurrentPeriod(
  quota: IChatMessageQuota,
  opts?: { session?: ClientSession }
): Promise<void> {
  const { periodStart } = getDailyPeriodBounds();
  const prev = quota.freeQuotaPeriodStart
    ? new Date(quota.freeQuotaPeriodStart).getTime()
    : null;
  if (prev === null || prev !== periodStart.getTime()) {
    quota.freeMessagesSent = 0;
    quota.freeQuotaPeriodStart = periodStart;
    await quota.save(opts);
  }
}

/** For Mongo $match on aggregates (same instant as normalize). */
export function getCurrentChatQuotaPeriodStart(): Date {
  return getDailyPeriodBounds().periodStart;
}
