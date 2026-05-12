import mongoose, { Document, Schema } from 'mongoose';

export interface IPlatformRevenueConfig extends Document {
  /** Basis points: 500 = 5% of host-earned coins credited to BD wallet on settlement. */
  bdBps: number;
  /** Basis points: 1500 = 15% of host-earned coins credited to agency wallet (same gross basis). */
  agencyBps: number;
  singletonKey: string;
  updatedAt: Date;
}

const SINGLETON_KEY = 'global';

const schema = new Schema<IPlatformRevenueConfig>(
  {
    singletonKey: {
      type: String,
      default: SINGLETON_KEY,
      unique: true,
      immutable: true,
    },
    bdBps: { type: Number, required: true, default: 500, min: 0, max: 10000 },
    agencyBps: { type: Number, required: true, default: 1500, min: 0, max: 10000 },
  },
  { timestamps: true }
);

export const PlatformRevenueConfig = mongoose.model<IPlatformRevenueConfig>(
  'PlatformRevenueConfig',
  schema
);

export async function getOrCreatePlatformRevenueConfig(): Promise<{
  bdBps: number;
  agencyBps: number;
}> {
  let doc = await PlatformRevenueConfig.findOne({ singletonKey: SINGLETON_KEY }).lean();
  if (!doc) {
    await PlatformRevenueConfig.create({
      singletonKey: SINGLETON_KEY,
      bdBps: 500,
      agencyBps: 1500,
    });
    doc = await PlatformRevenueConfig.findOne({ singletonKey: SINGLETON_KEY }).lean();
  }
  return {
    bdBps: doc?.bdBps ?? 500,
    agencyBps: doc?.agencyBps ?? 1500,
  };
}
