import mongoose, { Document, Schema } from 'mongoose';

export interface IUserRewardProgress extends Document {
  userId: mongoose.Types.ObjectId;
  /** taskKey -> ISO claim timestamps for once tasks */
  claimed: Map<string, Date> | Record<string, Date>;
  lifetime: {
    followedCreatorIds: string[];
  };
  daily: {
    dateKey: string;
    viewedMomentIds: string[];
    likedMomentIds: string[];
    watchClaimed: boolean;
    likeClaimed: boolean;
  };
  createdAt: Date;
  updatedAt: Date;
}

const schema = new Schema<IUserRewardProgress>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
      index: true,
    },
    claimed: {
      type: Map,
      of: Date,
      default: {},
    },
    lifetime: {
      followedCreatorIds: {
        type: [String],
        default: [],
      },
    },
    daily: {
      dateKey: { type: String, default: '' },
      viewedMomentIds: { type: [String], default: [] },
      likedMomentIds: { type: [String], default: [] },
      watchClaimed: { type: Boolean, default: false },
      likeClaimed: { type: Boolean, default: false },
    },
  },
  { timestamps: true }
);

export const UserRewardProgress = mongoose.model<IUserRewardProgress>(
  'UserRewardProgress',
  schema
);

export async function ensureUserRewardProgress(
  userId: mongoose.Types.ObjectId,
  session?: mongoose.ClientSession
): Promise<IUserRewardProgress> {
  const existing = await UserRewardProgress.findOne({ userId }).session(
    session ?? null
  );
  if (existing) return existing;
  try {
    const created = await UserRewardProgress.create(
      [
        {
          userId,
          claimed: {},
          lifetime: { followedCreatorIds: [] },
          daily: {
            dateKey: '',
            viewedMomentIds: [],
            likedMomentIds: [],
            watchClaimed: false,
            likeClaimed: false,
          },
        },
      ],
      session ? { session } : undefined
    );
    return created[0];
  } catch (err) {
    if (
      err &&
      typeof err === 'object' &&
      'code' in err &&
      (err as { code?: number }).code === 11000
    ) {
      const raced = await UserRewardProgress.findOne({ userId }).session(
        session ?? null
      );
      if (raced) return raced;
    }
    throw err;
  }
}

export function getClaimedAt(
  progress: IUserRewardProgress,
  taskKey: string
): Date | null {
  const claimed = progress.claimed as Map<string, Date> | Record<string, Date>;
  if (claimed instanceof Map) {
    return claimed.get(taskKey) ?? null;
  }
  const v = (claimed as Record<string, Date>)[taskKey];
  return v ? new Date(v) : null;
}
