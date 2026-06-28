export type RechargeBonusReason = 'VIP' | 'FESTIVAL' | 'COUPON' | 'REFERRAL';

export interface RechargeBenefits {
  discountedPriceInr: number;
  originalPriceInr: number;
  discountPercent: number;
  baseCoins: number;
  bonusCoins: number;
  totalCoins: number;
  bonusPercent: number;
  bonusReason: RechargeBonusReason | null;
  benefitsApplied: boolean;
  vipDiscountApplied: boolean;
  vipBonusApplied: boolean;
}
