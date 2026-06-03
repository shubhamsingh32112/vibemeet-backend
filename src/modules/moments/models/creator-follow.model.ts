import mongoose, { Document, Schema } from 'mongoose';

export interface ICreatorFollow extends Document {
  _id: mongoose.Types.ObjectId;
  followerUserId: mongoose.Types.ObjectId;
  creatorId: mongoose.Types.ObjectId;
  createdAt: Date;
}

const creatorFollowSchema = new Schema<ICreatorFollow>(
  {
    followerUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    creatorId: { type: Schema.Types.ObjectId, ref: 'Creator', required: true },
    createdAt: { type: Date, default: () => new Date() },
  },
  { timestamps: false },
);

creatorFollowSchema.index({ followerUserId: 1, creatorId: 1 }, { unique: true });
creatorFollowSchema.index({ creatorId: 1, createdAt: -1 });

export const CreatorFollow = mongoose.model<ICreatorFollow>(
  'CreatorFollow',
  creatorFollowSchema,
);
