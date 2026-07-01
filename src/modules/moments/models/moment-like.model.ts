import mongoose, { Document, Schema } from 'mongoose';

export interface IMomentLike extends Document {
  _id: mongoose.Types.ObjectId;
  momentId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  createdAt: Date;
}

const momentLikeSchema = new Schema<IMomentLike>(
  {
    momentId: { type: Schema.Types.ObjectId, ref: 'CreatorMoment', required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    createdAt: { type: Date, default: () => new Date() },
  },
  { timestamps: false },
);

momentLikeSchema.index({ momentId: 1, userId: 1 }, { unique: true });
momentLikeSchema.index({ momentId: 1, createdAt: -1 });

export const MomentLike = mongoose.model<IMomentLike>('MomentLike', momentLikeSchema);
