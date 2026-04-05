import mongoose, { Document, Schema } from 'mongoose';

export type CreatorApplicationStatus = 'pending' | 'accepted' | 'rejected';

export interface ICreatorApplication extends Document {
  _id: mongoose.Types.ObjectId;
  applicantUserId: mongoose.Types.ObjectId;
  agentUserId: mongoose.Types.ObjectId;
  referralCodeUsed: string;
  status: CreatorApplicationStatus;
  createdAt: Date;
  resolvedAt?: Date;
  rejectionReason?: string;
  updatedAt: Date;
}

const creatorApplicationSchema = new Schema<ICreatorApplication>(
  {
    applicantUserId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    agentUserId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    referralCodeUsed: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
    },
    status: {
      type: String,
      enum: ['pending', 'accepted', 'rejected'],
      default: 'pending',
      index: true,
    },
    resolvedAt: {
      type: Date,
    },
    rejectionReason: {
      type: String,
      trim: true,
      maxlength: 2000,
    },
  },
  { timestamps: true }
);

creatorApplicationSchema.index({ agentUserId: 1, status: 1, createdAt: -1 });
creatorApplicationSchema.index({ applicantUserId: 1, status: 1 });

export const CreatorApplication = mongoose.model<ICreatorApplication>(
  'CreatorApplication',
  creatorApplicationSchema
);
