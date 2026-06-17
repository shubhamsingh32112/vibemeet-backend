import type { IMomentsPremiumPlanConfig } from './models/moments-premium-plan-config.model';

export interface MomentsPremiumPlanApiShape {
  planId: string;
  label: string;
  durationDays: number;
  priceInr: number;
  monthlyEquivalentInr: number;
  billedLabel: string | null;
  badge: string | null;
  isActive: boolean;
}

function monthlyEquivalent(priceInr: number, durationDays: number): number {
  if (durationDays <= 0) return priceInr;
  return Math.round((priceInr * 30) / durationDays);
}

function buildBilledLabel(plan: IMomentsPremiumPlanConfig): string | null {
  if (plan.durationDays <= 3) return null;
  if (plan.durationDays <= 31) {
    return `Billed ₹${plan.priceInr}/month`;
  }
  const monthly = monthlyEquivalent(plan.priceInr, plan.durationDays);
  return `Billed ₹${monthly}/month`;
}

export function buildMomentsPremiumPlanApiShape(
  plan: IMomentsPremiumPlanConfig,
  momentsEnabled = true,
): MomentsPremiumPlanApiShape {
  return {
    planId: plan.planId,
    label: plan.label,
    durationDays: plan.durationDays,
    priceInr: plan.priceInr,
    monthlyEquivalentInr: monthlyEquivalent(plan.priceInr, plan.durationDays),
    billedLabel: buildBilledLabel(plan),
    badge: plan.badge ?? null,
    isActive: plan.isActive && momentsEnabled,
  };
}
