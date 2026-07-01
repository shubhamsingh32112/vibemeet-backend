import mongoose, { Document, Schema } from 'mongoose';

export interface IMomentComment extends Document {
  _id: mongoose.Types.ObjectId;
  momentId: mongoose.Types.ObjectId;
  authorUserId: mongoose.Types.ObjectId;
  text: string;
  parentCommentId?: mongoose.Types.ObjectId | null;
  likesCount: number;
  isVipHighlighted: boolean;
  isDeleted: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const momentCommentSchema = new Schema<IMomentComment>(
  {
    momentId: { type: Schema.Types.ObjectId, ref: 'CreatorMoment', required: true },
    authorUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    text: { type: String, required: true, maxlength: 500, trim: true },
    parentCommentId: { type: Schema.Types.ObjectId, ref: 'MomentComment', default: null },
    likesCount: { type: Number, default: 0, min: 0 },
    isVipHighlighted: { type: Boolean, default: false, index: true },
    isDeleted: { type: Boolean, default: false, index: true },
  },
  { timestamps: true },
);

momentCommentSchema.index({ momentId: 1, createdAt: -1 });
momentCommentSchema.index({ parentCommentId: 1, createdAt: 1 });

export const MomentComment = mongoose.model<IMomentComment>(
  'MomentComment',
  momentCommentSchema,
);
