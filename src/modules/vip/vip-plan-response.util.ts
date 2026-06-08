import type { IVipPlanConfig } from './models/vip-plan-config.model';

export interface VipPlanApiShape {
  planId: string;
  label: string;
  durationDays: number;
  priceInr: number;
  monthlyEquivalentInr: number;
  savingsLabel: string | null;
  badge: string | null;
  isActive: boolean;
}

export interface VipPlansPerksShape {
  freeMomentsPerDay: number;
  rechargeDiscountPercent: number;
  momentDiscountPercent: number;
}

function monthlyEquivalent(priceInr: number, durationDays: number): number {
  if (durationDays <= 0) return priceInr;
  return Math.round((priceInr * 30) / durationDays);
}

function computeSavingsLabel(
  plan: IVipPlanConfig,
  monthlyPlan: IVipPlanConfig | undefined,
): string | null {
  if (!monthlyPlan || plan.planId === monthlyPlan.planId) return null;

  const periodMonths = Math.max(1, Math.round(plan.durationDays / 30));
  const monthlyCostIfBilledMonthly = monthlyPlan.priceInr * periodMonths;
  const savings = monthlyCostIfBilledMonthly - plan.priceInr;
  if (savings <= 0) return null;

  if (plan.durationDays >= 360) {
    return `Save ₹${savings.toLocaleString('en-IN')} / year`;
  }
  if (plan.durationDays >= 180) {
    return `Save ₹${savings.toLocaleString('en-IN')} / 6 months`;
  }
  return `Save ₹${savings.toLocaleString('en-IN')}`;
}

export function buildVipPlanApiShape(
  plan: IVipPlanConfig,
  monthlyPlan?: IVipPlanConfig,
  vipEnabled = true,
): VipPlanApiShape {
  return {
    planId: plan.planId,
    label: plan.label,
    durationDays: plan.durationDays,
    priceInr: plan.priceInr,
    monthlyEquivalentInr: monthlyEquivalent(plan.priceInr, plan.durationDays),
    savingsLabel: computeSavingsLabel(plan, monthlyPlan),
    badge: plan.badge ?? null,
    isActive: plan.isActive && vipEnabled,
  };
}

export function buildSharedPerks(plans: IVipPlanConfig[]): VipPlansPerksShape {
  const base = plans[0];
  return {
    freeMomentsPerDay: base?.freeMomentsPerDay ?? 10,
    rechargeDiscountPercent: (base?.rechargeDiscountBps ?? 1000) / 100,
    momentDiscountPercent: (base?.momentDiscountBps ?? 1000) / 100,
  };
}

export function buildLegacyPlanPayload(
  plan: IVipPlanConfig,
  perks: VipPlansPerksShape,
  vipEnabled: boolean,
) {
  return {
    planId: plan.planId,
    durationDays: plan.durationDays,
    priceInr: plan.priceInr,
    isActive: plan.isActive && vipEnabled,
    perks: [
      `${perks.freeMomentsPerDay} free paid moments per day`,
      'Unlimited free messages',
      `${perks.rechargeDiscountPercent}% off coin recharges`,
      `${perks.momentDiscountPercent}% off moments after daily free quota`,
      'VIP badge',
      'Priority calling when creators are busy',
      'Schedule calls with creators',
    ],
    freeMomentsPerDay: perks.freeMomentsPerDay,
    rechargeDiscountPercent: perks.rechargeDiscountPercent,
    momentDiscountPercent: perks.momentDiscountPercent,
  };
}
