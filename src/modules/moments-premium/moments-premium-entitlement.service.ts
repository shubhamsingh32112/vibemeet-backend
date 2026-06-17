import type { Types } from 'mongoose';
import { getRedis } from '../../config/redis';
import { isMomentsEnabled } from '../../config/moments';
import { MomentsPremiumMembership } from './models/moments-premium-membership.model';

const CACHE_PREFIX = 'moments_premium:active:';

export interface MomentsPremiumStatusDTO {
  active: boolean;
  expiresAt: string | null;
  daysRemaining: number;
  planId: string | null;
}

async function cacheActive(
  userId: string,
  active: boolean,
  expiresAt: Date | null,
): Promise<void> {
  const redis = getRedis();
  const key = `${CACHE_PREFIX}${userId}`;
  if (!active || !expiresAt) {
    await redis.del(key).catch(() => {});
    return;
  }
  const ttlSec = Math.max(60, Math.ceil((expiresAt.getTime() - Date.now()) / 1000));
  await redis.set(key, '1', 'EX', ttlSec).catch(() => {});
}

export async function invalidateMomentsPremiumCache(userId: string): Promise<void> {
  const redis = getRedis();
  await redis.del(`${CACHE_PREFIX}${userId}`).catch(() => {});
}

export async function isMomentsPremiumActive(
  userId: Types.ObjectId | string,
): Promise<boolean> {
  if (!isMomentsEnabled()) return false;

  const userIdStr = userId.toString();
  const redis = getRedis();
  const cached = await redis.get(`${CACHE_PREFIX}${userIdStr}`);
  if (cached === '1') return true;

  const membership = await MomentsPremiumMembership.findOne({ userId: userIdStr }).lean();
  if (!membership) {
    await cacheActive(userIdStr, false, null);
    return false;
  }

  const now = Date.now();
  const active =
    membership.status === 'active' && membership.expiresAt.getTime() > now;

  await cacheActive(userIdStr, active, active ? membership.expiresAt : null);
  return active;
}

export async function getMomentsPremiumStatus(
  userId: Types.ObjectId | string,
): Promise<MomentsPremiumStatusDTO> {
  if (!isMomentsEnabled()) {
    return {
      active: false,
      expiresAt: null,
      daysRemaining: 0,
      planId: null,
    };
  }

  const membership = await MomentsPremiumMembership.findOne({ userId }).lean();
  if (!membership) {
    return {
      active: false,
      expiresAt: null,
      daysRemaining: 0,
      planId: null,
    };
  }

  const now = Date.now();
  const active =
    membership.status === 'active' && membership.expiresAt.getTime() > now;
  const daysRemaining = active
    ? Math.max(0, Math.ceil((membership.expiresAt.getTime() - now) / (24 * 60 * 60 * 1000)))
    : 0;

  return {
    active,
    expiresAt: active ? membership.expiresAt.toISOString() : null,
    daysRemaining,
    planId: active ? membership.planId : null,
  };
}
