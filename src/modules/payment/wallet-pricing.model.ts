import mongoose, { Document, Schema } from 'mongoose';
import { CoinTransaction } from '../user/coin-transaction.model';

export type PricingTier = 'tier1' | 'tier2';

export interface IWalletCoinPack {
  coins: number;
  tier1PriceInr: number;
  tier2PriceInr: number;
  oldPriceInr?: number;
  badge?: string;
  isActive: boolean;
  sortOrder: number;
}

export interface IWalletPricingConfig extends Document {
  packages: IWalletCoinPack[];
  updatedByAdminId?: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const walletCoinPackSchema = new Schema<IWalletCoinPack>(
  {
    coins: { type: Number, required: true, min: 1 },
    tier1PriceInr: { type: Number, required: true, min: 1 },
    tier2PriceInr: { type: Number, required: true, min: 1 },
    oldPriceInr: { type: Number, min: 1 },
    badge: { type: String, trim: true, maxlength: 40 },
    isActive: { type: Boolean, default: true },
    sortOrder: { type: Number, default: 0 },
  },
  { _id: false }
);

const walletPricingConfigSchema = new Schema<IWalletPricingConfig>(
  {
    packages: {
      type: [walletCoinPackSchema],
      default: [],
    },
    updatedByAdminId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      sparse: true,
    },
  },
  { timestamps: true }
);

export const DEFAULT_WALLET_COIN_PACKAGES: IWalletCoinPack[] = [
  { coins: 250, tier1PriceInr: 75, tier2PriceInr: 149, oldPriceInr: 149, badge: 'Flat 50% off', isActive: true, sortOrder: 1 },
  { coins: 300, tier1PriceInr: 199, tier2PriceInr: 199, isActive: true, sortOrder: 2 },
  { coins: 350, tier1PriceInr: 299, tier2PriceInr: 299, isActive: true, sortOrder: 3 },
  { coins: 550, tier1PriceInr: 499, tier2PriceInr: 499, isActive: true, sortOrder: 4 },
  { coins: 850, tier1PriceInr: 799, tier2PriceInr: 799, isActive: true, sortOrder: 5 },
  { coins: 1400, tier1PriceInr: 999, tier2PriceInr: 999, isActive: true, sortOrder: 6 },
  { coins: 3500, tier1PriceInr: 2099, tier2PriceInr: 2099, isActive: true, sortOrder: 7 },
  { coins: 7500, tier1PriceInr: 3999, tier2PriceInr: 3999, isActive: true, sortOrder: 8 },
  { coins: 11500, tier1PriceInr: 7999, tier2PriceInr: 7999, isActive: true, sortOrder: 9 },
];

export const WalletPricingConfig = mongoose.model<IWalletPricingConfig>(
  'WalletPricingConfig',
  walletPricingConfigSchema
);

export async function getOrCreateWalletPricingConfig(): Promise<IWalletPricingConfig> {
  let config = await WalletPricingConfig.findOne().sort({ createdAt: 1 });
  if (!config) {
    config = new WalletPricingConfig({
      packages: DEFAULT_WALLET_COIN_PACKAGES,
    });
    await config.save();
  }
  return config;
}

export async function hasCompletedCoinPurchase(
  userId: mongoose.Types.ObjectId | string
): Promise<boolean> {
  const exists = await CoinTransaction.exists({
    userId,
    source: 'payment_gateway',
    status: 'completed',
    type: 'credit',
  });
  return Boolean(exists);
}

export function getEffectivePackPrice(
  pack: IWalletCoinPack,
  tier: PricingTier
): number {
  return tier === 'tier1' ? pack.tier1PriceInr : pack.tier2PriceInr;
}

