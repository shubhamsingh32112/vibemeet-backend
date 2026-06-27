import mongoose, { Document, Schema } from 'mongoose';
import type { MomentAccessReason } from '../services/entitlement.service';

export interface IMomentView extends Document {
  _id: mongoose.Types.ObjectId;
  momentId: mongoose.Types.ObjectId;
  viewerUserId: mongoose.Types.ObjectId;
  viewedAt: Date;
  accessReason?: MomentAccessReason;
}

const momentViewSchema = new Schema<IMomentView>(
  {
    momentId: { type: Schema.Types.ObjectId, ref: 'CreatorMoment', required: true },
    viewerUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    viewedAt: { type: Date, default: () => new Date() },
    accessReason: {
      type: String,
      enum: ['OWNER', 'CREATOR', 'PREMIUM', 'PREVIEW', 'ADMIN', 'DENIED'],
      default: undefined,
    },
  },
  { timestamps: false },
);

momentViewSchema.index({ momentId: 1, viewerUserId: 1 }, { unique: true });
momentViewSchema.index({ momentId: 1, viewedAt: -1 });

export const MomentView = mongoose.model<IMomentView>('MomentView', momentViewSchema);
