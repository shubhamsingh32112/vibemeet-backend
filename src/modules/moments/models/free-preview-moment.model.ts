import mongoose, { Document, Schema } from 'mongoose';

export interface IFreePreviewMoment extends Document {
  _id: mongoose.Types.ObjectId;
  momentId: mongoose.Types.ObjectId;
  order: number;
  enabled: boolean;
  startsAt?: Date | null;
  endsAt?: Date | null;
  createdBy: mongoose.Types.ObjectId;
  updatedBy: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const freePreviewMomentSchema = new Schema<IFreePreviewMoment>(
  {
    momentId: {
      type: Schema.Types.ObjectId,
      ref: 'CreatorMoment',
      required: true,
      unique: true,
      index: true,
    },
    order: { type: Number, required: true, index: true },
    enabled: { type: Boolean, default: true, index: true },
    startsAt: { type: Date, default: null },
    endsAt: { type: Date, default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
);

freePreviewMomentSchema.index({ enabled: 1, startsAt: 1, endsAt: 1 });

export const FreePreviewMoment = mongoose.model<IFreePreviewMoment>(
  'FreePreviewMoment',
  freePreviewMomentSchema,
);
