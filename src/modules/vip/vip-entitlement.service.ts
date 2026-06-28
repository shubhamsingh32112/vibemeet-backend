import type { Types } from 'mongoose';
import { getRedis } from '../../config/redis';
import { featureFlags } from '../../config/feature-flags';
import { getCurrentChatQuotaPeriodStart } from '../chat/chat-quota-period.util';
import { VipMembership } from './models/vip-membership.model';
import { VipDailyMomentUsage } from './models/vip-daily-moment-usage.model';
import { getOrCreateVipPlanConfig } from './models/vip-plan-config.model';

const VIP_ACTIVE_CACHE_PREFIX = 'vip:active:';

export interface VipStatusDTO {
  active: boolean;
  expiresAt: string | null;
  daysRemaining: number;
  planId: string | null;
  freeMomentsRemainingToday: number;
  freeMomentsDailyLimit: number;
  rechargeDiscountPercent: number;
  momentDiscountPercent: number;
}

function applyBpsDiscount(amount: number, discountBps: number): number {
  if (discountBps <= 0) return amount;
  const discounted = Math.floor((amount * (10000 - discountBps)) / 10000);
  return Math.max(1, discounted);
}

async function getPlanPerks() {
  const plan = await getOrCreateVipPlanConfig();
  return {
    planId: plan.planId,
    freeMomentsPerDay: plan.freeMomentsPerDay,
    rechargeDiscountBps: plan.rechargeDiscountBps,
    momentDiscountBps: plan.momentDiscountBps,
  };
}

async function cacheVipActive(
  userId: string,
  active: boolean,
  expiresAt: Date | null,
): Promise<void> {
  const redis = getRedis();
  const key = `${VIP_ACTIVE_CACHE_PREFIX}${userId}`;
  if (!active || !expiresAt) {
    await redis.del(key).catch(() => {});
    return;
  }
  const ttlSec = Math.max(
    60,
    Math.ceil((expiresAt.getTime() - Date.now()) / 1000),
  );
  await redis.set(key, '1', 'EX', ttlSec).catch(() => {});
}

export async function invalidateVipCache(userId: string): Promise<void> {
  const redis = getRedis();
  await redis.del(`${VIP_ACTIVE_CACHE_PREFIX}${userId}`).catch(() => {});
}

export async function isVipActive(
  userId: Types.ObjectId | string,
): Promise<boolean> {
  if (!featureFlags.vipEnabled) return false;

  const userIdStr = userId.toString();
  const redis = getRedis();
  const cached = await redis.get(`${VIP_ACTIVE_CACHE_PREFIX}${userIdStr}`);
  if (cached === '1') return true;

  const membership = await VipMembership.findOne({ userId: userIdStr }).lean();
  if (!membership) {
    await cacheVipActive(userIdStr, false, null);
    return false;
  }

  const now = Date.now();
  const active =
    membership.status === 'active' &&
    membership.expiresAt.getTime() > now;

  if (!active && membership.status === 'active') {
    await VipMembership.updateOne(
      { _id: membership._id },
      { $set: { status: 'expired' } },
    );
    const { User } = await import('../user/user.model');
    await User.updateOne({ _id: userIdStr }, { $set: { vipExpiresAt: null } });
  }

  await cacheVipActive(
    userIdStr,
    active,
    active ? membership.expiresAt : null,
  );
  return active;
}

export async function getRemainingFreeMoments(
  userId: Types.ObjectId | string,
): Promise<number> {
  if (!(await isVipActive(userId))) return 0;

  const perks = await getPlanPerks();
  const usageDate = getCurrentChatQuotaPeriodStart();
  const usage = await VipDailyMomentUsage.findOne({
    userId,
    usageDate,
  }).lean();

  const redeemed = usage?.redeemedCount ?? 0;
  return Math.max(0, perks.freeMomentsPerDay - redeemed);
}

export async function incrementDailyMomentUsage(
  userId: Types.ObjectId | string,
): Promise<number> {
  const perks = await getPlanPerks();
  const usageDate = getCurrentChatQuotaPeriodStart();

  const usage = await VipDailyMomentUsage.findOneAndUpdate(
    { userId, usageDate },
    {
      $setOnInsert: { userId, usageDate, redeemedCount: 0 },
    },
    { upsert: true, new: true },
  );

  if (usage.redeemedCount >= perks.freeMomentsPerDay) {
    throw new Error('VIP_DAILY_MOMENT_QUOTA_EXHAUSTED');
  }

  usage.redeemedCount += 1;
  await usage.save();
  return Math.max(0, perks.freeMomentsPerDay - usage.redeemedCount);
}

export async function applyRechargeDiscount(priceInr: number): Promise<number> {
  const perks = await getPlanPerks();
  return applyBpsDiscount(priceInr, perks.rechargeDiscountBps);
}

export async function applyMomentDiscount(priceCoins: number): Promise<number> {
  const perks = await getPlanPerks();
  return applyBpsDiscount(priceCoins, perks.momentDiscountBps);
}

export async function applyRechargeDiscountForUser(
  userId: Types.ObjectId | string,
  priceInr: number,
): Promise<{ priceInr: number; vipDiscountApplied: boolean; originalPriceInr: number }> {
  const active = await isVipActive(userId);
  if (!active) {
    return { priceInr, vipDiscountApplied: false, originalPriceInr: priceInr };
  }
  const discounted = await applyRechargeDiscount(priceInr);
  return {
    priceInr: discounted,
    vipDiscountApplied: true,
    originalPriceInr: priceInr,
  };
}

export async function resolveMomentPriceForUser(
  userId: Types.ObjectId | string,
  basePriceCoins: number,
): Promise<{
  priceCoins: number;
  originalPriceCoins: number;
  vipFreeUnlockAvailable: boolean;
  discountApplied: boolean;
}> {
  const active = await isVipActive(userId);
  if (!active) {
    return {
      priceCoins: basePriceCoins,
      originalPriceCoins: basePriceCoins,
      vipFreeUnlockAvailable: false,
      discountApplied: false,
    };
  }

  const remaining = await getRemainingFreeMoments(userId);
  if (remaining > 0) {
    return {
      priceCoins: 0,
      originalPriceCoins: basePriceCoins,
      vipFreeUnlockAvailable: true,
      discountApplied: false,
    };
  }

  const discounted = await applyMomentDiscount(basePriceCoins);
  return {
    priceCoins: discounted,
    originalPriceCoins: basePriceCoins,
    vipFreeUnlockAvailable: false,
    discountApplied: discounted < basePriceCoins,
  };
}

export async function getVipStatus(
  userId: Types.ObjectId | string,
): Promise<VipStatusDTO> {
  const perks = await getPlanPerks();
  const membership = await VipMembership.findOne({ userId }).lean();
  const now = Date.now();

  let active = false;
  let expiresAt: Date | null = null;
  let planId: string | null = null;

  if (membership) {
    active =
      membership.status === 'active' &&
      membership.expiresAt.getTime() > now;
    expiresAt = membership.expiresAt;
    planId = membership.planId;

    if (!active && membership.status === 'active') {
      await VipMembership.updateOne(
        { _id: membership._id },
        { $set: { status: 'expired' } },
      );
      const { User } = await import('../user/user.model');
      await User.updateOne({ _id: userId }, { $set: { vipExpiresAt: null } });
    }
  }

  if (!featureFlags.vipEnabled) {
    active = false;
  }

  const freeMomentsRemainingToday = active
    ? await getRemainingFreeMoments(userId)
    : 0;

  const daysRemaining =
    active && expiresAt
      ? Math.max(0, Math.ceil((expiresAt.getTime() - now) / (24 * 60 * 60 * 1000)))
      : 0;

  return {
    active,
    expiresAt: expiresAt ? expiresAt.toISOString() : null,
    daysRemaining,
    planId,
    freeMomentsRemainingToday,
    freeMomentsDailyLimit: perks.freeMomentsPerDay,
    rechargeDiscountPercent: perks.rechargeDiscountBps / 100,
    momentDiscountPercent: perks.momentDiscountBps / 100,
  };
}
