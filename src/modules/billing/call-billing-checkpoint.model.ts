import mongoose, { Schema } from 'mongoose';

/**
 * Optional durability: partial snapshot of in-flight call billing for recovery analysis.
 * Does not replace Redis as source of truth during the call.
 */
export interface ICallBillingCheckpoint extends mongoose.Document {
  callId: string;
  userMongoId: string;
  creatorMongoId: string;
  userFirebaseUid: string;
  creatorFirebaseUid: string;
  startTimeMs: number;
  lastProcessedAtMs: number;
  remainingUserBalanceMicros: number;
  pricePerSecondMicros: number;
  creatorEarningsPerSecondMicros: number;
  totalDeductedMicros: number;
  totalEarnedMicros: number;
  billingSequence: number;
  lifecycleState:
    | 'INIT'
    | 'STARTING'
    | 'ACTIVE'
    | 'ENDING'
    | 'SETTLING'
    | 'SETTLED'
    | 'FAILED'
    | 'RECOVERING';
  schemaVersion: number;
  version: number;
  status: 'active' | 'settling' | 'settled';
  updatedAt: Date;
}

const callBillingCheckpointSchema = new Schema<ICallBillingCheckpoint>(
  {
    callId: { type: String, required: true, unique: true, index: true },
    userMongoId: { type: String, required: true },
    creatorMongoId: { type: String, required: true },
    userFirebaseUid: { type: String, required: false },
    creatorFirebaseUid: { type: String, required: false },
    startTimeMs: { type: Number, required: false },
    lastProcessedAtMs: { type: Number, required: false },
    remainingUserBalanceMicros: { type: Number, required: false },
    pricePerSecondMicros: { type: Number, required: false },
    creatorEarningsPerSecondMicros: { type: Number, required: false },
    totalDeductedMicros: { type: Number, required: true },
    totalEarnedMicros: { type: Number, required: true },
    billingSequence: { type: Number, required: true, default: 0 },
    lifecycleState: {
      type: String,
      enum: ['INIT', 'STARTING', 'ACTIVE', 'ENDING', 'SETTLING', 'SETTLED', 'FAILED', 'RECOVERING'],
      required: true,
      default: 'INIT',
      index: true,
    },
    schemaVersion: { type: Number, required: true, default: 3 },
    version: { type: Number, required: true, default: 1 },
    status: {
      type: String,
      enum: ['active', 'settling', 'settled'],
      default: 'active',
      index: true,
    },
    updatedAt: { type: Date, required: true },
  },
  { collection: 'call_billing_checkpoints' }
);

export const CallBillingCheckpoint =
  mongoose.models.CallBillingCheckpoint ||
  mongoose.model<ICallBillingCheckpoint>('CallBillingCheckpoint', callBillingCheckpointSchema);
