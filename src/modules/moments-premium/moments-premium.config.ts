function readIntEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export const MOMENTS_PREMIUM_3D_PLAN_ID = 'moments_3d';
export const MOMENTS_PREMIUM_1M_PLAN_ID = 'moments_1m';
export const MOMENTS_PREMIUM_3M_PLAN_ID = 'moments_3m';
export const MOMENTS_PREMIUM_DEFAULT_PLAN_ID = MOMENTS_PREMIUM_1M_PLAN_ID;

export type MomentsPremiumPlanBadge = 'bestForTrying' | 'mostPopular' | 'bestValue' | null;

export interface DefaultMomentsPremiumPlanSeed {
  planId: string;
  label: string;
  durationDays: number;
  priceInr: number;
  isActive: boolean;
  badge: MomentsPremiumPlanBadge;
  sortOrder: number;
}

export const DEFAULT_MOMENTS_PREMIUM_3D_PLAN: DefaultMomentsPremiumPlanSeed = {
  planId: MOMENTS_PREMIUM_3D_PLAN_ID,
  label: '3 Days Trial',
  durationDays: readIntEnv('MOMENTS_PREMIUM_3D_DURATION_DAYS', 3),
  priceInr: readIntEnv('MOMENTS_PREMIUM_3D_PRICE_INR', 29),
  isActive: true,
  badge: 'bestForTrying',
  sortOrder: 0,
};

export const DEFAULT_MOMENTS_PREMIUM_1M_PLAN: DefaultMomentsPremiumPlanSeed = {
  planId: MOMENTS_PREMIUM_1M_PLAN_ID,
  label: '1 Month',
  durationDays: readIntEnv('MOMENTS_PREMIUM_1M_DURATION_DAYS', 30),
  priceInr: readIntEnv('MOMENTS_PREMIUM_1M_PRICE_INR', 99),
  isActive: true,
  badge: 'mostPopular',
  sortOrder: 1,
};

export const DEFAULT_MOMENTS_PREMIUM_3M_PLAN: DefaultMomentsPremiumPlanSeed = {
  planId: MOMENTS_PREMIUM_3M_PLAN_ID,
  label: '3 Months',
  durationDays: readIntEnv('MOMENTS_PREMIUM_3M_DURATION_DAYS', 90),
  priceInr: readIntEnv('MOMENTS_PREMIUM_3M_PRICE_INR', 199),
  isActive: true,
  badge: 'bestValue',
  sortOrder: 2,
};

export const DEFAULT_MOMENTS_PREMIUM_PLANS: DefaultMomentsPremiumPlanSeed[] = [
  DEFAULT_MOMENTS_PREMIUM_3D_PLAN,
  DEFAULT_MOMENTS_PREMIUM_1M_PLAN,
  DEFAULT_MOMENTS_PREMIUM_3M_PLAN,
];

export const MOMENTS_PREMIUM_CHECKOUT_SESSION_TTL_SECONDS = 15 * 60;
