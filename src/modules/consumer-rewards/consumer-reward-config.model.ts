import mongoose, { Document, Schema } from 'mongoose';
import { isConsumerRewardsMasterEnabled } from './consumer-reward.config';
import { buildDefaultTaskConfig } from './task-registry';

export type TaskConfigSlice = {
  enabled: boolean;
  coins: number;
  minSeconds?: number;
  minPurchaseInr?: number;
  targetCount?: number;
};

export type ConsumerRewardTasksConfig = {
  upload_profile_photo: TaskConfigSlice;
  complete_profile: TaskConfigSlice;
  first_video_call: TaskConfigSlice;
  first_message: TaskConfigSlice;
  invite_friend: TaskConfigSlice;
  successful_referral: TaskConfigSlice;
  first_recharge: TaskConfigSlice;
  watch_free_moments: TaskConfigSlice;
  like_moments: TaskConfigSlice;
  follow_creators: TaskConfigSlice;
};

export type DailyBudgetMode = 'alert_only';

export interface IConsumerRewardConfig extends Document {
  singletonKey: string;
  enabled: boolean;
  tasks: ConsumerRewardTasksConfig;
  /** Soft daily issuance ceiling (coins). Default 500_000. */
  dailyRewardBudgetCoins: number;
  dailyBudgetMode: DailyBudgetMode;
  createdAt: Date;
  updatedAt: Date;
}

const taskSliceSchema = new Schema(
  {
    enabled: { type: Boolean, default: true },
    coins: { type: Number, default: 0, min: 0, max: 100000 },
    minSeconds: { type: Number, min: 0, max: 86400 },
    minPurchaseInr: { type: Number, min: 0, max: 10000000 },
    targetCount: { type: Number, min: 1, max: 100 },
  },
  { _id: false }
);

const SINGLETON_KEY = 'global';
const DEFAULT_DAILY_BUDGET = 500_000;

const schema = new Schema<IConsumerRewardConfig>(
  {
    singletonKey: {
      type: String,
      default: SINGLETON_KEY,
      unique: true,
      immutable: true,
    },
    enabled: { type: Boolean, default: true },
    tasks: {
      type: {
        upload_profile_photo: taskSliceSchema,
        complete_profile: taskSliceSchema,
        first_video_call: taskSliceSchema,
        first_message: taskSliceSchema,
        invite_friend: taskSliceSchema,
        successful_referral: taskSliceSchema,
        first_recharge: taskSliceSchema,
        watch_free_moments: taskSliceSchema,
        like_moments: taskSliceSchema,
        follow_creators: taskSliceSchema,
      },
      default: () => buildDefaultTaskConfig(),
    },
    dailyRewardBudgetCoins: {
      type: Number,
      default: DEFAULT_DAILY_BUDGET,
      min: 0,
      max: 100_000_000,
    },
    dailyBudgetMode: {
      type: String,
      enum: ['alert_only'],
      default: 'alert_only',
    },
  },
  { timestamps: true }
);

export const ConsumerRewardConfig = mongoose.model<IConsumerRewardConfig>(
  'ConsumerRewardConfig',
  schema
);

export type ConsumerRewardConfigView = {
  enabled: boolean;
  tasks: ConsumerRewardTasksConfig;
  dailyRewardBudgetCoins: number;
  dailyBudgetMode: DailyBudgetMode;
  updatedAt: string | null;
};

function mergeTasks(
  raw: Partial<ConsumerRewardTasksConfig> | undefined
): ConsumerRewardTasksConfig {
  const defaults = buildDefaultTaskConfig();
  if (!raw) return defaults;
  const keys = Object.keys(defaults) as (keyof ConsumerRewardTasksConfig)[];
  const out = { ...defaults };
  for (const k of keys) {
    const slice = raw[k];
    if (!slice || typeof slice !== 'object') continue;
    out[k] = {
      enabled: slice.enabled !== false,
      coins:
        Number.isFinite(Number(slice.coins)) && Number(slice.coins) >= 0
          ? Math.floor(Number(slice.coins))
          : defaults[k].coins,
      ...(defaults[k].minSeconds !== undefined
        ? {
            minSeconds:
              Number.isFinite(Number(slice.minSeconds)) && Number(slice.minSeconds) >= 0
                ? Math.floor(Number(slice.minSeconds))
                : defaults[k].minSeconds,
          }
        : {}),
      ...(defaults[k].minPurchaseInr !== undefined
        ? {
            minPurchaseInr:
              Number.isFinite(Number(slice.minPurchaseInr)) &&
              Number(slice.minPurchaseInr) >= 0
                ? Math.floor(Number(slice.minPurchaseInr))
                : defaults[k].minPurchaseInr,
          }
        : {}),
      ...(defaults[k].targetCount !== undefined
        ? {
            targetCount:
              Number.isFinite(Number(slice.targetCount)) && Number(slice.targetCount) >= 1
                ? Math.floor(Number(slice.targetCount))
                : defaults[k].targetCount,
          }
        : {}),
    };
  }
  return out;
}

let configCache: { at: number; value: ConsumerRewardConfigView } | null = null;
/** Plan: ~60s config cache at 10k DAU. */
const CONFIG_TTL_MS = 60_000;

export function invalidateConsumerRewardConfigCache(): void {
  configCache = null;
}

export async function getOrCreateConsumerRewardConfig(): Promise<ConsumerRewardConfigView> {
  if (configCache && Date.now() - configCache.at < CONFIG_TTL_MS) {
    return configCache.value;
  }

  let doc = await ConsumerRewardConfig.findOne({ singletonKey: SINGLETON_KEY }).lean();
  if (!doc) {
    try {
      await ConsumerRewardConfig.create({
        singletonKey: SINGLETON_KEY,
        enabled: isConsumerRewardsMasterEnabled(),
        tasks: buildDefaultTaskConfig(),
        dailyRewardBudgetCoins: DEFAULT_DAILY_BUDGET,
        dailyBudgetMode: 'alert_only',
      });
    } catch {
      // concurrent create
    }
    doc = await ConsumerRewardConfig.findOne({ singletonKey: SINGLETON_KEY }).lean();
  }

  const budgetRaw = Number((doc as { dailyRewardBudgetCoins?: number } | null)?.dailyRewardBudgetCoins);
  const dailyRewardBudgetCoins =
    Number.isFinite(budgetRaw) && budgetRaw >= 0
      ? Math.floor(budgetRaw)
      : DEFAULT_DAILY_BUDGET;

  const view: ConsumerRewardConfigView = {
    enabled: Boolean(doc?.enabled) && isConsumerRewardsMasterEnabled(),
    tasks: mergeTasks(doc?.tasks as Partial<ConsumerRewardTasksConfig> | undefined),
    dailyRewardBudgetCoins,
    dailyBudgetMode: 'alert_only',
    updatedAt: doc?.updatedAt ? new Date(doc.updatedAt).toISOString() : null,
  };
  configCache = { at: Date.now(), value: view };
  return view;
}

export async function isConsumerRewardsEnabled(): Promise<boolean> {
  if (!isConsumerRewardsMasterEnabled()) return false;
  const cfg = await getOrCreateConsumerRewardConfig();
  return cfg.enabled;
}
