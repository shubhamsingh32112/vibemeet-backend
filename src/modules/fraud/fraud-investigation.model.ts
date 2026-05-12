import mongoose, { Document, Schema } from 'mongoose';

export type FraudInvestigationStatus = 'open' | 'resolved' | 'dismissed';

export interface IFraudInvestigation extends Document {
  title: string;
  status: FraudInvestigationStatus;
  signalIds: mongoose.Types.ObjectId[];
  notes: { at: Date; text: string; authorUserId?: mongoose.Types.ObjectId }[];
  subjectUserId?: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const fraudInvestigationSchema = new Schema<IFraudInvestigation>(
  {
    title: { type: String, required: true, trim: true, maxlength: 500 },
    status: {
      type: String,
      enum: ['open', 'resolved', 'dismissed'],
      default: 'open',
      index: true,
    },
    signalIds: [{ type: Schema.Types.ObjectId, ref: 'FraudSignal' }],
    notes: [
      {
        at: { type: Date, default: () => new Date() },
        text: { type: String, required: true, maxlength: 8000 },
        authorUserId: { type: Schema.Types.ObjectId, ref: 'User' },
      },
    ],
    subjectUserId: { type: Schema.Types.ObjectId, ref: 'User', sparse: true, index: true },
  },
  { timestamps: true }
);

export const FraudInvestigation = mongoose.model<IFraudInvestigation>(
  'FraudInvestigation',
  fraudInvestigationSchema
);
