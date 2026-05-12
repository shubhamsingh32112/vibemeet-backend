/**
 * Redis-backed anti-abuse counters for image uploads.
 *
 * Quotas are read from `getImageQuotaConfig()`:
 *   - avatar uploads:  IMAGE_QUOTA_AVATAR_PER_DAY (default 5/day)
 *   - gallery uploads: IMAGE_QUOTA_GALLERY_PER_HOUR (default 20/hour)
 *
 * Counters use bucketed Redis keys with a TTL matching the window so they
 * are automatically reaped. We check-then-bump in two RTTs (`get` + `incr`)
 * which is acceptable because over-counts during contention are far cheaper
 * than under-counts.
 */

import { getRedis, isRedisConfigured } from '../../config/redis';
import { getImageQuotaConfig } from '../../config/cloudflare';
import { logWarning } from '../../utils/logger';
import { bumpImageCounter } from './image-metrics';

export type QuotaScope = 'avatar' | 'gallery';

export class UploadQuotaExceededError extends Error {
  readonly code = 'UPLOAD_QUOTA_EXCEEDED';
  readonly retryAfterSeconds: number;
  readonly scope: QuotaScope;
  constructor(scope: QuotaScope, retryAfterSeconds: number) {
    super(`upload quota exceeded for ${scope}`);
    this.scope = scope;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

function dayBucket(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function hourBucket(now: Date): string {
  const iso = now.toISOString();
  return `${iso.slice(0, 13)}:00`;
}

function dailyKey(userId: string, date: Date): string {
  return `image:quota:avatar:${userId}:${dayBucket(date)}`;
}

function hourlyKey(userId: string, date: Date): string {
  return `image:quota:gallery:${userId}:${hourBucket(date)}`;
}

function secondsUntilNextDay(now: Date): number {
  const next = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
    0, 0, 0, 0,
  ));
  return Math.max(60, Math.floor((next.getTime() - now.getTime()) / 1000));
}

function secondsUntilNextHour(now: Date): number {
  const next = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    now.getUTCHours() + 1, 0, 0, 0,
  ));
  return Math.max(60, Math.floor((next.getTime() - now.getTime()) / 1000));
}

/**
 * Throws `UploadQuotaExceededError` when the user would exceed the limit.
 * Does NOT increment — call `recordUpload` once the upload is actually
 * committed.
 */
export async function assertCanUpload(userId: string, scope: QuotaScope): Promise<void> {
  if (!isRedisConfigured()) {
    // Fail open in non-Redis dev environments — bumpImageCounter so this is observable.
    bumpImageCounter('quota.bypass_no_redis', { scope });
    return;
  }
  const now = new Date();
  const quotas = getImageQuotaConfig();
  const redis = getRedis();
  try {
    if (scope === 'avatar') {
      const count = Number((await redis.get(dailyKey(userId, now))) || 0);
      if (count >= quotas.avatarPerDay) {
        bumpImageCounter('quota.rejected', { scope });
        throw new UploadQuotaExceededError(scope, secondsUntilNextDay(now));
      }
    } else {
      const count = Number((await redis.get(hourlyKey(userId, now))) || 0);
      if (count >= quotas.galleryPerHour) {
        bumpImageCounter('quota.rejected', { scope });
        throw new UploadQuotaExceededError(scope, secondsUntilNextHour(now));
      }
    }
  } catch (error) {
    if (error instanceof UploadQuotaExceededError) throw error;
    logWarning('upload-quota Redis read failed; failing open', {
      scope,
      userId,
      error: (error as Error).message,
    });
    bumpImageCounter('quota.bypass_redis_error', { scope });
  }
}

/** Increment the appropriate counter atomically with a TTL on first write. */
export async function recordUpload(userId: string, scope: QuotaScope): Promise<void> {
  if (!isRedisConfigured()) return;
  const now = new Date();
  const redis = getRedis();
  try {
    if (scope === 'avatar') {
      const key = dailyKey(userId, now);
      const count = await redis.incr(key);
      if (count === 1) await redis.expire(key, secondsUntilNextDay(now));
    } else {
      const key = hourlyKey(userId, now);
      const count = await redis.incr(key);
      if (count === 1) await redis.expire(key, secondsUntilNextHour(now));
    }
    bumpImageCounter('quota.recorded', { scope });
  } catch (error) {
    logWarning('upload-quota Redis write failed', {
      scope,
      userId,
      error: (error as Error).message,
    });
    bumpImageCounter('quota.write_failed', { scope });
  }
}
