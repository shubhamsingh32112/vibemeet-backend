import mongoose, { Schema } from 'mongoose';

/**
 * Optional durability: partial snapshot of in-flight call billing for recovery analysis.
 * Does not replace Redis as source of truth during the call.
 */
export interface ICallBillingCheckpoint extends mongoose.Document {
  callId: string;
  userMongoId: string;
  creatorMongoId: string;
  totalDeductedMicros: number;
  totalEarnedMicros: number;
  updatedAt: Date;
}

const callBillingCheckpointSchema = new Schema<ICallBillingCheckpoint>(
  {
    callId: { type: String, required: true, unique: true, index: true },
    userMongoId: { type: String, required: true },
    creatorMongoId: { type: String, required: true },
    totalDeductedMicros: { type: Number, required: true },
    totalEarnedMicros: { type: Number, required: true },
    updatedAt: { type: Date, required: true },
  },
  { collection: 'call_billing_checkpoints' }
);

export const CallBillingCheckpoint =
  mongoose.models.CallBillingCheckpoint ||
  mongoose.model<ICallBillingCheckpoint>('CallBillingCheckpoint', callBillingCheckpointSchema);
