import { featureFlags } from '../../config/feature-flags';
import { isVipActive } from '../vip/vip-entitlement.service';
import { getOrCreateVipPlanConfig } from '../vip/models/vip-plan-config.model';
import type { RechargeBenefits } from './recharge-pricing.types';

export type RechargeBenefitsTestOverrides = {
  vipActive?: boolean;
  vipEnabled?: boolean;
  vipRechargeBonusEnabled?: boolean;
  rechargeDiscountBps?: number;
  bonusBps?: number;
};

function readBonusBps(overrideBps?: number): number {
  if (overrideBps !== undefined) return overrideBps;
  const raw = process.env.VIP_RECHARGE_BONUS_BPS;
  if (raw === undefined || raw === '') return 1000;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 1000;
}

function applyBpsDiscount(amount: number, discountBps: number): number {
  if (discountBps <= 0) return amount;
  const discounted = Math.floor((amount * (10000 - discountBps)) / 10000);
  return Math.max(1, discounted);
}

/**
 * Single source of truth for recharge pricing perks (VIP discount + bonus today;
 * Festival/Coupon/Referral can plug in here later).
 */
export async function resolveRechargeBenefits(
  userId: string,
  pack: { priceInr: number; coins: number },
  testOverrides?: RechargeBenefitsTestOverrides,
): Promise<RechargeBenefits> {
  const originalPriceInr = pack.priceInr;
  const baseCoins = pack.coins;

  let discountedPriceInr = originalPriceInr;
  let discountPercent = 0;
  let vipDiscountApplied = false;

  let bonusCoins = 0;
  let bonusPercent = 0;
  let bonusReason: RechargeBenefits['bonusReason'] = null;
  let vipBonusApplied = false;

  const vipEnabled = testOverrides?.vipEnabled ?? featureFlags.vipEnabled;
  const vipRechargeBonusEnabled =
    testOverrides?.vipRechargeBonusEnabled ?? featureFlags.vipRechargeBonusEnabled;
  const vipActive =
    testOverrides?.vipActive !== undefined
      ? testOverrides.vipActive
      : await isVipActive(userId);

  if (vipEnabled && vipActive) {
    const discountBps =
      testOverrides?.rechargeDiscountBps ??
      (await getOrCreateVipPlanConfig()).rechargeDiscountBps ??
      0;
    if (discountBps > 0) {
      discountedPriceInr = applyBpsDiscount(originalPriceInr, discountBps);
      discountPercent = Math.round(discountBps / 100);
      vipDiscountApplied = discountedPriceInr < originalPriceInr;
    }

    if (vipRechargeBonusEnabled) {
      const bonusBps = readBonusBps(testOverrides?.bonusBps);
      if (bonusBps > 0) {
        bonusCoins = Math.floor((baseCoins * bonusBps) / 10000);
        bonusPercent = Math.round(bonusBps / 100);
        if (bonusCoins > 0) {
          bonusReason = 'VIP';
          vipBonusApplied = true;
        }
      }
    }
  }

  return {
    discountedPriceInr,
    originalPriceInr,
    discountPercent,
    baseCoins,
    bonusCoins,
    totalCoins: baseCoins + bonusCoins,
    bonusPercent,
    bonusReason,
    benefitsApplied: vipDiscountApplied || vipBonusApplied,
    vipDiscountApplied,
    vipBonusApplied,
  };
}
