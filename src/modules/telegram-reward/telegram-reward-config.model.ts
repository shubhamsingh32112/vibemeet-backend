import mongoose, { Document, Schema } from 'mongoose';
import {
  getTelegramRewardDefaultCoins,
  getTelegramRewardDefaultEnabled,
  TELEGRAM_REWARD_COINS_MAX,
} from './telegram-reward.config';

export interface ITelegramRewardConfig extends Document {
  singletonKey: string;
  enabled: boolean;
  channelUrl: string;
  channelChatId: string;
  rewardCoins: number;
  updatedAt: Date;
  createdAt: Date;
}

const SINGLETON_KEY = 'global';

const schema = new Schema<ITelegramRewardConfig>(
  {
    singletonKey: {
      type: String,
      default: SINGLETON_KEY,
      unique: true,
      immutable: true,
    },
    enabled: { type: Boolean, default: false },
    channelUrl: { type: String, default: '', trim: true, maxlength: 500 },
    channelChatId: { type: String, default: '', trim: true, maxlength: 128 },
    rewardCoins: {
      type: Number,
      default: 100,
      min: 1,
      max: TELEGRAM_REWARD_COINS_MAX,
    },
  },
  { timestamps: true }
);

export const TelegramRewardConfig = mongoose.model<ITelegramRewardConfig>(
  'TelegramRewardConfig',
  schema
);

export type TelegramRewardConfigView = {
  enabled: boolean;
  channelUrl: string;
  channelChatId: string;
  rewardCoins: number;
  updatedAt: string | null;
};

export async function getOrCreateTelegramRewardConfig(): Promise<TelegramRewardConfigView> {
  let doc = await TelegramRewardConfig.findOne({ singletonKey: SINGLETON_KEY }).lean();
  if (!doc) {
    try {
      await TelegramRewardConfig.create({
        singletonKey: SINGLETON_KEY,
        enabled: getTelegramRewardDefaultEnabled(),
        channelUrl: '',
        channelChatId: '',
        rewardCoins: getTelegramRewardDefaultCoins(),
      });
    } catch {
      // Concurrent create — fall through to re-read.
    }
    doc = await TelegramRewardConfig.findOne({ singletonKey: SINGLETON_KEY }).lean();
  }

  return {
    enabled: Boolean(doc?.enabled),
    channelUrl: doc?.channelUrl ?? '',
    channelChatId: doc?.channelChatId ?? '',
    rewardCoins: doc?.rewardCoins ?? getTelegramRewardDefaultCoins(),
    updatedAt: doc?.updatedAt ? new Date(doc.updatedAt).toISOString() : null,
  };
}

export async function isTelegramRewardEnabled(): Promise<boolean> {
  const cfg = await getOrCreateTelegramRewardConfig();
  return cfg.enabled;
}
