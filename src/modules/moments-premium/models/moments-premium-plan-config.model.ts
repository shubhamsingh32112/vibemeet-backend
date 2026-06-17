import mongoose, { Document, Schema } from 'mongoose';
import {
  DEFAULT_MOMENTS_PREMIUM_PLANS,
  type DefaultMomentsPremiumPlanSeed,
  type MomentsPremiumPlanBadge,
} from '../moments-premium.config';

export interface IMomentsPremiumPlanConfig extends Document {
  planId: string;
  label: string;
  durationDays: number;
  priceInr: number;
  isActive: boolean;
  badge: MomentsPremiumPlanBadge;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

const momentsPremiumPlanConfigSchema = new Schema<IMomentsPremiumPlanConfig>(
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
    badge: {
      type: String,
      enum: ['bestForTrying', 'mostPopular', 'bestValue', null],
      default: null,
    },
    sortOrder: {
      type: Number,
      default: 0,
    },
  },
  { timestamps: true },
);

export const MomentsPremiumPlanConfig = mongoose.model<IMomentsPremiumPlanConfig>(
  'MomentsPremiumPlanConfig',
  momentsPremiumPlanConfigSchema,
);

async function ensurePlanSeed(
  seed: DefaultMomentsPremiumPlanSeed,
): Promise<IMomentsPremiumPlanConfig> {
  let config = await MomentsPremiumPlanConfig.findOne({ planId: seed.planId });
  if (!config) {
    config = await MomentsPremiumPlanConfig.create({ ...seed });
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

export async function getOrCreateMomentsPremiumPlans(): Promise<IMomentsPremiumPlanConfig[]> {
  const plans = await Promise.all(
    DEFAULT_MOMENTS_PREMIUM_PLANS.map((seed) => ensurePlanSeed(seed)),
  );
  return plans.sort((a, b) => a.sortOrder - b.sortOrder);
}

export async function getMomentsPremiumPlanById(
  planId: string,
): Promise<IMomentsPremiumPlanConfig | null> {
  await getOrCreateMomentsPremiumPlans();
  return MomentsPremiumPlanConfig.findOne({ planId });
}
