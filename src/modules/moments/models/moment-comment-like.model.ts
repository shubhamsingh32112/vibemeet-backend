import mongoose, { Document, Schema } from 'mongoose';

export interface IMomentCommentLike extends Document {
  _id: mongoose.Types.ObjectId;
  commentId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  createdAt: Date;
}

const momentCommentLikeSchema = new Schema<IMomentCommentLike>(
  {
    commentId: { type: Schema.Types.ObjectId, ref: 'MomentComment', required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    createdAt: { type: Date, default: () => new Date() },
  },
  { timestamps: false },
);

momentCommentLikeSchema.index({ commentId: 1, userId: 1 }, { unique: true });

export const MomentCommentLike = mongoose.model<IMomentCommentLike>(
  'MomentCommentLike',
  momentCommentLikeSchema,
);
