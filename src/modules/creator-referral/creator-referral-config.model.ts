import mongoose, { Document, Schema } from 'mongoose';
import {
  CREATOR_REFERRAL_COINS_MAX,
  getCreatorReferralDefaultCoins,
  getCreatorReferralDefaultEnabled,
} from './creator-referral.config';

export interface ICreatorReferralConfig extends Document {
  singletonKey: string;
  enabled: boolean;
  rewardCoins: number;
  updatedAt: Date;
  createdAt: Date;
}

const SINGLETON_KEY = 'global';

const schema = new Schema<ICreatorReferralConfig>(
  {
    singletonKey: {
      type: String,
      default: SINGLETON_KEY,
      unique: true,
      immutable: true,
    },
    enabled: { type: Boolean, default: true },
    rewardCoins: {
      type: Number,
      default: 500,
      min: 1,
      max: CREATOR_REFERRAL_COINS_MAX,
    },
  },
  { timestamps: true }
);

export const CreatorReferralConfig = mongoose.model<ICreatorReferralConfig>(
  'CreatorReferralConfig',
  schema
);

export type CreatorReferralConfigView = {
  enabled: boolean;
  rewardCoins: number;
  updatedAt: string | null;
};

export async function getOrCreateCreatorReferralConfig(): Promise<CreatorReferralConfigView> {
  let doc = await CreatorReferralConfig.findOne({ singletonKey: SINGLETON_KEY }).lean();
  if (!doc) {
    try {
      await CreatorReferralConfig.create({
        singletonKey: SINGLETON_KEY,
        enabled: getCreatorReferralDefaultEnabled(),
        rewardCoins: getCreatorReferralDefaultCoins(),
      });
    } catch {
      // Concurrent create — fall through to re-read.
    }
    doc = await CreatorReferralConfig.findOne({ singletonKey: SINGLETON_KEY }).lean();
  }

  return {
    enabled: doc?.enabled !== false,
    rewardCoins: doc?.rewardCoins ?? getCreatorReferralDefaultCoins(),
    updatedAt: doc?.updatedAt ? new Date(doc.updatedAt).toISOString() : null,
  };
}

export async function updateCreatorReferralConfig(input: {
  enabled?: boolean;
  rewardCoins?: number;
}): Promise<CreatorReferralConfigView> {
  await getOrCreateCreatorReferralConfig();

  const $set: Record<string, unknown> = {};
  if (typeof input.enabled === 'boolean') {
    $set.enabled = input.enabled;
  }
  if (typeof input.rewardCoins === 'number' && Number.isFinite(input.rewardCoins)) {
    const coins = Math.floor(input.rewardCoins);
    if (coins >= 1 && coins <= CREATOR_REFERRAL_COINS_MAX) {
      $set.rewardCoins = coins;
    }
  }

  if (Object.keys($set).length > 0) {
    await CreatorReferralConfig.updateOne({ singletonKey: SINGLETON_KEY }, { $set });
  }

  return getOrCreateCreatorReferralConfig();
}
