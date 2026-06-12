import mongoose, { Document, Schema } from 'mongoose';

export type BillingLedgerFlushReason =
  | 'periodic'
  | 'call_end'
  | 'disconnect'
  | 'reconnect'
  | 'deployment_shutdown'
  | 'insufficient_balance'
  | 'creator_disconnect';

export interface IBillingLedger extends Document {
  callId: string;
  tickNumber: number;
  accrualStartAt: Date;
  accrualEndAt: Date;
  billedDurationMs: number;
  userDebitMicros: number;
  creatorCreditMicros: number;
  billingSequenceStart: number;
  billingSequenceEnd: number;
  sourceInstanceId: string;
  reconnectGeneration: number;
  fencingToken: number;
  flushReason: BillingLedgerFlushReason;
  idempotencyKey: string;
  clientTimestamp?: Date;
  createdAt: Date;
}

const billingLedgerSchema = new Schema<IBillingLedger>(
  {
    callId: { type: String, required: true, index: true },
    tickNumber: { type: Number, required: true, min: 0 },
    accrualStartAt: { type: Date, required: true },
    accrualEndAt: { type: Date, required: true },
    billedDurationMs: { type: Number, required: true, min: 0 },
    userDebitMicros: { type: Number, required: true, min: 0 },
    creatorCreditMicros: { type: Number, required: true, min: 0 },
    billingSequenceStart: { type: Number, required: true, min: 0 },
    billingSequenceEnd: { type: Number, required: true, min: 0 },
    sourceInstanceId: { type: String, required: true },
    reconnectGeneration: { type: Number, required: true, default: 0 },
    fencingToken: { type: Number, required: true, default: 1 },
    flushReason: {
      type: String,
      enum: [
        'periodic',
        'call_end',
        'disconnect',
        'reconnect',
        'deployment_shutdown',
        'insufficient_balance',
        'creator_disconnect',
      ],
      required: true,
    },
    idempotencyKey: { type: String, required: true, unique: true },
    clientTimestamp: { type: Date, sparse: true },
  },
  {
    collection: 'billing_ledger',
    timestamps: { createdAt: true, updatedAt: false },
  }
);

billingLedgerSchema.index({ callId: 1, tickNumber: 1 }, { unique: true });

export const BillingLedger = mongoose.model<IBillingLedger>('BillingLedger', billingLedgerSchema);

export async function sumLedgerForCall(callId: string): Promise<{
  userDebitMicros: number;
  creatorCreditMicros: number;
  tickCount: number;
  lastAccrualEndAt?: Date;
}> {
  const rows = await BillingLedger.find({ callId })
    .select('userDebitMicros creatorCreditMicros accrualEndAt')
    .sort({ tickNumber: 1 })
    .lean();

  let userDebitMicros = 0;
  let creatorCreditMicros = 0;
  let lastAccrualEndAt: Date | undefined;

  for (const row of rows) {
    userDebitMicros += row.userDebitMicros || 0;
    creatorCreditMicros += row.creatorCreditMicros || 0;
    lastAccrualEndAt = row.accrualEndAt;
  }

  return {
    userDebitMicros,
    creatorCreditMicros,
    tickCount: rows.length,
    lastAccrualEndAt,
  };
}
