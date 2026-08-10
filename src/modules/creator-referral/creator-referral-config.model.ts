import mongoose, { Document, Schema } from 'mongoose';
import {
  CREATOR_REFERRAL_COINS_MAX,
  getCreatorReferralDefaultAttachCoins,
  getCreatorReferralDefaultEnabled,
  getCreatorReferralDefaultPurchaseCoins,
  getCreatorReferralDefaultTelegramCoins,
} from './creator-referral.config';

export interface ICreatorReferralConfig extends Document {
  singletonKey: string;
  enabled: boolean;
  /** @deprecated Legacy single payout; ignored for new stages. */
  rewardCoins?: number;
  attachCoins: number;
  telegramCoins: number;
  purchaseCoins: number;
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
      min: 1,
      max: CREATOR_REFERRAL_COINS_MAX,
    },
    attachCoins: {
      type: Number,
      default: 200,
      min: 1,
      max: CREATOR_REFERRAL_COINS_MAX,
    },
    telegramCoins: {
      type: Number,
      default: 100,
      min: 1,
      max: CREATOR_REFERRAL_COINS_MAX,
    },
    purchaseCoins: {
      type: Number,
      default: 1000,
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
  attachCoins: number;
  telegramCoins: number;
  purchaseCoins: number;
  updatedAt: string | null;
};

function clampCoins(n: number, fallback: number): number {
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(Math.floor(n), CREATOR_REFERRAL_COINS_MAX);
}

function viewFromDoc(doc: {
  enabled?: boolean;
  attachCoins?: number;
  telegramCoins?: number;
  purchaseCoins?: number;
  updatedAt?: Date;
} | null): CreatorReferralConfigView {
  return {
    enabled: doc?.enabled !== false,
    attachCoins: clampCoins(
      doc?.attachCoins ?? getCreatorReferralDefaultAttachCoins(),
      getCreatorReferralDefaultAttachCoins()
    ),
    telegramCoins: clampCoins(
      doc?.telegramCoins ?? getCreatorReferralDefaultTelegramCoins(),
      getCreatorReferralDefaultTelegramCoins()
    ),
    purchaseCoins: clampCoins(
      doc?.purchaseCoins ?? getCreatorReferralDefaultPurchaseCoins(),
      getCreatorReferralDefaultPurchaseCoins()
    ),
    updatedAt: doc?.updatedAt ? new Date(doc.updatedAt).toISOString() : null,
  };
}

export async function getOrCreateCreatorReferralConfig(): Promise<CreatorReferralConfigView> {
  let doc = await CreatorReferralConfig.findOne({ singletonKey: SINGLETON_KEY }).lean();
  if (!doc) {
    try {
      await CreatorReferralConfig.create({
        singletonKey: SINGLETON_KEY,
        enabled: getCreatorReferralDefaultEnabled(),
        attachCoins: getCreatorReferralDefaultAttachCoins(),
        telegramCoins: getCreatorReferralDefaultTelegramCoins(),
        purchaseCoins: getCreatorReferralDefaultPurchaseCoins(),
      });
    } catch {
      // Concurrent create — fall through to re-read.
    }
    doc = await CreatorReferralConfig.findOne({ singletonKey: SINGLETON_KEY }).lean();
  } else {
    // Legacy singleton may only have rewardCoins. Stage amounts are a new product
    // surface (attach/telegram/purchase) — seed missing stages from env defaults,
    // not from rewardCoins (that was a single combined payout amount).
    const needsMigrate =
      doc.attachCoins == null || doc.telegramCoins == null || doc.purchaseCoins == null;
    if (needsMigrate) {
      await CreatorReferralConfig.updateOne(
        { singletonKey: SINGLETON_KEY },
        {
          $set: {
            attachCoins: doc.attachCoins ?? getCreatorReferralDefaultAttachCoins(),
            telegramCoins: doc.telegramCoins ?? getCreatorReferralDefaultTelegramCoins(),
            purchaseCoins: doc.purchaseCoins ?? getCreatorReferralDefaultPurchaseCoins(),
          },
        }
      );
      doc = await CreatorReferralConfig.findOne({ singletonKey: SINGLETON_KEY }).lean();
    }
  }

  return viewFromDoc(doc);
}

export async function updateCreatorReferralConfig(input: {
  enabled?: boolean;
  attachCoins?: number;
  telegramCoins?: number;
  purchaseCoins?: number;
}): Promise<CreatorReferralConfigView> {
  await getOrCreateCreatorReferralConfig();

  const $set: Record<string, unknown> = {};
  if (typeof input.enabled === 'boolean') {
    $set.enabled = input.enabled;
  }
  for (const key of ['attachCoins', 'telegramCoins', 'purchaseCoins'] as const) {
    const raw = input[key];
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      const coins = Math.floor(raw);
      if (coins >= 1 && coins <= CREATOR_REFERRAL_COINS_MAX) {
        $set[key] = coins;
      }
    }
  }

  if (Object.keys($set).length > 0) {
    await CreatorReferralConfig.updateOne({ singletonKey: SINGLETON_KEY }, { $set });
  }

  return getOrCreateCreatorReferralConfig();
}
