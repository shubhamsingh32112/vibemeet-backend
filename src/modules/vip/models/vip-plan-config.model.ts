import mongoose, { Document, Schema } from 'mongoose';
import { DEFAULT_VIP_PLANS, type DefaultVipPlanSeed } from '../vip.config';

export type VipPlanBadge = 'mostPopular' | 'bestValue' | null;

export interface IVipPlanConfig extends Document {
  planId: string;
  label: string;
  durationDays: number;
  priceInr: number;
  isActive: boolean;
  freeMomentsPerDay: number;
  rechargeDiscountBps: number;
  momentDiscountBps: number;
  badge: VipPlanBadge;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

const vipPlanConfigSchema = new Schema<IVipPlanConfig>(
  {
    planId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    label: {
      type: String,
      required: true,
      trim: true,
    },
    durationDays: {
      type: Number,
      required: true,
      min: 1,
    },
    priceInr: {
      type: Number,
      required: true,
      min: 1,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    freeMomentsPerDay: {
      type: Number,
      required: true,
      min: 0,
    },
    rechargeDiscountBps: {
      type: Number,
      required: true,
      min: 0,
      max: 10000,
    },
    momentDiscountBps: {
      type: Number,
      required: true,
      min: 0,
      max: 10000,
    },
    badge: {
      type: String,
      enum: ['mostPopular', 'bestValue', null],
      default: null,
    },
    sortOrder: {
      type: Number,
      default: 0,
    },
  },
  { timestamps: true },
);

export const VipPlanConfig = mongoose.model<IVipPlanConfig>(
  'VipPlanConfig',
  vipPlanConfigSchema,
);

async function ensurePlanSeed(seed: DefaultVipPlanSeed): Promise<IVipPlanConfig> {
  let config = await VipPlanConfig.findOne({ planId: seed.planId });
  if (!config) {
    config = await VipPlanConfig.create({ ...seed });
    return config;
  }

  config.label = seed.label;
  config.durationDays = seed.durationDays;
  config.priceInr = seed.priceInr;
  config.badge = seed.badge;
  config.sortOrder = seed.sortOrder;
  await config.save();
  return config;
}

/** Ensures default 6-month, yearly, and monthly plans exist. */
export async function getOrCreateVipPlans(): Promise<IVipPlanConfig[]> {
  const plans = await Promise.all(DEFAULT_VIP_PLANS.map((seed) => ensurePlanSeed(seed)));
  return plans.sort((a, b) => a.sortOrder - b.sortOrder);
}

export async function getVipPlanById(planId: string): Promise<IVipPlanConfig | null> {
  await getOrCreateVipPlans();
  return VipPlanConfig.findOne({ planId });
}

/** Backward-compatible helper — returns the default monthly plan. */
export async function getOrCreateVipPlanConfig(): Promise<IVipPlanConfig> {
  const plans = await getOrCreateVipPlans();
  return plans[0];
}

export async function listVipPlanConfigs(): Promise<IVipPlanConfig[]> {
  return getOrCreateVipPlans();
}
