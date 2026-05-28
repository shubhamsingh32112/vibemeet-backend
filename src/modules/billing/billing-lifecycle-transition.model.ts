import mongoose, { Schema } from 'mongoose';
import type { BillingLifecycleState } from './billing-lifecycle.machine';

export interface IBillingLifecycleTransition extends mongoose.Document {
  transitionId: string;
  callId: string;
  previousState: BillingLifecycleState;
  nextState: BillingLifecycleState;
  reason: string;
  source: string;
  timestamp: Date;
}

const billingLifecycleTransitionSchema = new Schema<IBillingLifecycleTransition>(
  {
    transitionId: { type: String, required: true, unique: true, index: true },
    callId: { type: String, required: true, index: true },
    previousState: {
      type: String,
      enum: [
        'INIT',
        'STARTING',
        'ACTIVE',
        'ENDING',
        'SETTLING',
        'SETTLED',
        'FAILED',
        'RECOVERING',
        'FAILED_RECOVERY_SETTLEMENT',
      ],
      required: true,
    },
    nextState: {
      type: String,
      enum: [
        'INIT',
        'STARTING',
        'ACTIVE',
        'ENDING',
        'SETTLING',
        'SETTLED',
        'FAILED',
        'RECOVERING',
        'FAILED_RECOVERY_SETTLEMENT',
      ],
      required: true,
    },
    reason: { type: String, required: true },
    source: { type: String, required: true },
    timestamp: { type: Date, required: true, default: () => new Date() },
  },
  { collection: 'billing_lifecycle_transitions' }
);

export const BillingLifecycleTransition =
  mongoose.models.BillingLifecycleTransition ||
  mongoose.model<IBillingLifecycleTransition>(
    'BillingLifecycleTransition',
    billingLifecycleTransitionSchema
  );
