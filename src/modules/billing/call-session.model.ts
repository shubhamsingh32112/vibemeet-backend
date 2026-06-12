import mongoose, { Schema } from 'mongoose';

export type DurableCallSessionState =
  | 'active'
  | 'reconnecting'
  | 'ending'
  | 'settling'
  | 'settled'
  | 'failed_settlement';

export type FinalizationReason =
  | 'normal_end'
  | 'disconnect_timeout'
  | 'deployment_shutdown'
  | 'watchdog_recovery'
  | 'insufficient_balance'
  | 'creator_disconnect'
  | 'force_terminated';

export interface IDurableCallSession {
  _id: string;
  callerId: mongoose.Types.ObjectId;
  creatorId: mongoose.Types.ObjectId;
  callerFirebaseUid: string;
  creatorFirebaseUid: string;
  state: DurableCallSessionState;
  startedAt: Date;
  endedAt?: Date;
  lastBillingAt: Date;
  accumulatedDurationSec: number;
  totalUserDebitedMicros: number;
  totalCreatorCreditedMicros: number;
  billingSequence: number;
  lastPersistedTickNumber: number;
  settlementVersion: number;
  finalized: boolean;
  finalizedAt?: Date;
  finalizationReason?: FinalizationReason;
  finalizationOwnerId?: string;
  finalizationStartedAt?: Date;
  serverStartedAt: Date;
  lastServerAccrualAt: Date;
  clientStartedAt?: Date;
  // Phase B ownership
  leaseOwnerId?: string;
  leaseExpiresAt?: Date;
  fencingToken: number;
  reconnectGeneration: number;
  recoveryAttempts: number;
  recoveredBy?: string;
  recoveredAt?: Date;
  pricePerMinute?: number;
  pricePerSecondMicros?: number;
  creatorShareAtCallTime?: number;
  createdAt: Date;
  updatedAt: Date;
}

const durableCallSessionSchema = new Schema<IDurableCallSession>(
  {
    _id: { type: String, required: true },
    callerId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    creatorId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    callerFirebaseUid: { type: String, required: true },
    creatorFirebaseUid: { type: String, required: true },
    state: {
      type: String,
      enum: ['active', 'reconnecting', 'ending', 'settling', 'settled', 'failed_settlement'],
      required: true,
      default: 'active',
      index: true,
    },
    startedAt: { type: Date, required: true },
    endedAt: { type: Date, sparse: true },
    lastBillingAt: { type: Date, required: true, index: true },
    accumulatedDurationSec: { type: Number, required: true, default: 0, min: 0 },
    totalUserDebitedMicros: { type: Number, required: true, default: 0, min: 0 },
    totalCreatorCreditedMicros: { type: Number, required: true, default: 0, min: 0 },
    billingSequence: { type: Number, required: true, default: 0, min: 0 },
    lastPersistedTickNumber: { type: Number, required: true, default: 0, min: 0 },
    settlementVersion: { type: Number, required: true, default: 0, min: 0 },
    finalized: { type: Boolean, required: true, default: false, index: true },
    finalizedAt: { type: Date, sparse: true },
    finalizationReason: {
      type: String,
      enum: [
        'normal_end',
        'disconnect_timeout',
        'deployment_shutdown',
        'watchdog_recovery',
        'insufficient_balance',
        'creator_disconnect',
        'force_terminated',
      ],
      sparse: true,
    },
    finalizationOwnerId: { type: String, sparse: true },
    finalizationStartedAt: { type: Date, sparse: true },
    serverStartedAt: { type: Date, required: true },
    lastServerAccrualAt: { type: Date, required: true },
    clientStartedAt: { type: Date, sparse: true },
    leaseOwnerId: { type: String, sparse: true, index: true },
    leaseExpiresAt: { type: Date, sparse: true },
    fencingToken: { type: Number, required: true, default: 1, min: 1 },
    reconnectGeneration: { type: Number, required: true, default: 0, min: 0 },
    recoveryAttempts: { type: Number, required: true, default: 0, min: 0 },
    recoveredBy: { type: String, sparse: true },
    recoveredAt: { type: Date, sparse: true },
    pricePerMinute: { type: Number, sparse: true },
    pricePerSecondMicros: { type: Number, sparse: true },
    creatorShareAtCallTime: { type: Number, sparse: true },
  },
  {
    collection: 'call_sessions',
    timestamps: true,
    _id: false,
  }
);

durableCallSessionSchema.index({ state: 1, lastBillingAt: 1 });
durableCallSessionSchema.index({ finalized: 1, state: 1 });
durableCallSessionSchema.index({ leaseOwnerId: 1, leaseExpiresAt: 1 });

export const DurableCallSession = mongoose.model<IDurableCallSession>(
  'DurableCallSession',
  durableCallSessionSchema
);
