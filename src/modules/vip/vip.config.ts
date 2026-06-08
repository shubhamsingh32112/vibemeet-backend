function readIntEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export const VIP_PLAN_ID = 'vip_monthly';
export const VIP_6MONTHS_PLAN_ID = 'vip_6months';
export const VIP_YEARLY_PLAN_ID = 'vip_yearly';

export type VipPlanBadge = 'mostPopular' | 'bestValue' | null;

export interface DefaultVipPlanSeed {
  planId: string;
  label: string;
  durationDays: number;
  priceInr: number;
  isActive: boolean;
  freeMomentsPerDay: number;
  rechargeDiscountBps: number;
  momentDiscountBps: number;
  badge: VipPlanBadge;
  sortOrder: number;
}

const sharedPerks = {
  freeMomentsPerDay: readIntEnv('VIP_FREE_MOMENTS_PER_DAY', 10),
  rechargeDiscountBps: readIntEnv('VIP_RECHARGE_DISCOUNT_BPS', 1000),
  momentDiscountBps: readIntEnv('VIP_MOMENT_DISCOUNT_BPS', 1000),
};

export const DEFAULT_VIP_6MONTHS_PLAN: DefaultVipPlanSeed = {
  planId: VIP_6MONTHS_PLAN_ID,
  label: '6 Months',
  durationDays: readIntEnv('VIP_6MONTHS_DURATION_DAYS', 180),
  priceInr: readIntEnv('VIP_6MONTHS_PRICE_INR', 2199),
  isActive: true,
  ...sharedPerks,
  badge: null,
  sortOrder: 0,
};

export const DEFAULT_VIP_YEARLY_PLAN: DefaultVipPlanSeed = {
  planId: VIP_YEARLY_PLAN_ID,
  label: '12 Months',
  durationDays: readIntEnv('VIP_YEARLY_DURATION_DAYS', 365),
  priceInr: readIntEnv('VIP_YEARLY_PRICE_INR', 3999),
  isActive: true,
  ...sharedPerks,
  badge: 'bestValue',
  sortOrder: 1,
};

export const DEFAULT_VIP_PLAN: DefaultVipPlanSeed = {
  planId: VIP_PLAN_ID,
  label: '1 Month',
  durationDays: readIntEnv('VIP_DURATION_DAYS', 30),
  priceInr: readIntEnv('VIP_PRICE_INR', 499),
  isActive: true,
  ...sharedPerks,
  badge: 'mostPopular',
  sortOrder: 2,
};

/** Display order: 6 months, 12 months, then 1 month at the bottom. */
export const DEFAULT_VIP_PLANS: DefaultVipPlanSeed[] = [
  DEFAULT_VIP_6MONTHS_PLAN,
  DEFAULT_VIP_YEARLY_PLAN,
  DEFAULT_VIP_PLAN,
];

export const VIP_CHECKOUT_SESSION_TTL_SECONDS = 15 * 60;
export const VIP_QUEUE_TTL_SEC = readIntEnv('VIP_CALL_QUEUE_TTL_SEC', 15 * 60);
export const VIP_SCHEDULE_MIN_LEAD_MINUTES = readIntEnv('VIP_SCHEDULE_MIN_LEAD_MINUTES', 30);
export const VIP_SCHEDULE_MAX_DAYS_AHEAD = readIntEnv('VIP_SCHEDULE_MAX_DAYS_AHEAD', 7);
