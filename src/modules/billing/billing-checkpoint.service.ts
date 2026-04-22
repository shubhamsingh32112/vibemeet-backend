import { CallBillingCheckpoint } from './call-billing-checkpoint.model';
import { logError } from '../../utils/logger';
import { BILLING_SESSION_SCHEMA_VERSION } from './billing.constants';

export interface BillingCheckpointSnapshotInput {
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
  status?: 'active' | 'settling' | 'settled';
}

export async function upsertBillingCheckpoint(data: {
  callId: string;
  userMongoId: string;
  creatorMongoId: string;
  totalDeductedMicros: number;
  totalEarnedMicros: number;
}): Promise<void> {
  try {
    await CallBillingCheckpoint.findOneAndUpdate(
      { callId: data.callId },
      {
        $set: {
          userMongoId: data.userMongoId,
          creatorMongoId: data.creatorMongoId,
          totalDeductedMicros: data.totalDeductedMicros,
          totalEarnedMicros: data.totalEarnedMicros,
          updatedAt: new Date(),
        },
      },
      { upsert: true }
    );
  } catch (err) {
    logError('Billing checkpoint upsert failed', err, { callId: data.callId });
  }
}

export async function upsertBillingCheckpointSnapshot(
  data: BillingCheckpointSnapshotInput
): Promise<void> {
  try {
    await CallBillingCheckpoint.findOneAndUpdate(
      { callId: data.callId },
      {
        $set: {
          userMongoId: data.userMongoId,
          creatorMongoId: data.creatorMongoId,
          userFirebaseUid: data.userFirebaseUid,
          creatorFirebaseUid: data.creatorFirebaseUid,
          startTimeMs: data.startTimeMs,
          lastProcessedAtMs: data.lastProcessedAtMs,
          remainingUserBalanceMicros: data.remainingUserBalanceMicros,
          pricePerSecondMicros: data.pricePerSecondMicros,
          creatorEarningsPerSecondMicros: data.creatorEarningsPerSecondMicros,
          totalDeductedMicros: data.totalDeductedMicros,
          totalEarnedMicros: data.totalEarnedMicros,
          schemaVersion: BILLING_SESSION_SCHEMA_VERSION,
          status: data.status || 'active',
          updatedAt: new Date(),
        },
        $inc: { version: 1 },
      },
      { upsert: true }
    );
  } catch (err) {
    logError('Billing checkpoint snapshot upsert failed', err, { callId: data.callId });
  }
}

export async function advanceBillingCheckpointCursor(
  data: BillingCheckpointSnapshotInput & { expectedVersion?: number }
): Promise<boolean> {
  try {
    const filter: Record<string, unknown> = { callId: data.callId };
    if (typeof data.expectedVersion === 'number') {
      filter.version = data.expectedVersion;
    }
    const result = await CallBillingCheckpoint.findOneAndUpdate(
      filter,
      {
        $set: {
          userMongoId: data.userMongoId,
          creatorMongoId: data.creatorMongoId,
          userFirebaseUid: data.userFirebaseUid,
          creatorFirebaseUid: data.creatorFirebaseUid,
          startTimeMs: data.startTimeMs,
          lastProcessedAtMs: data.lastProcessedAtMs,
          remainingUserBalanceMicros: data.remainingUserBalanceMicros,
          pricePerSecondMicros: data.pricePerSecondMicros,
          creatorEarningsPerSecondMicros: data.creatorEarningsPerSecondMicros,
          totalDeductedMicros: data.totalDeductedMicros,
          totalEarnedMicros: data.totalEarnedMicros,
          schemaVersion: BILLING_SESSION_SCHEMA_VERSION,
          status: data.status || 'active',
          updatedAt: new Date(),
        },
        $inc: { version: 1 },
        $setOnInsert: {
          version: 1,
        },
      },
      { upsert: true, new: true }
    ).lean();
    return Boolean(result);
  } catch (err) {
    logError('Billing checkpoint cursor advance failed', err, { callId: data.callId });
    return false;
  }
}

export async function getBillingCheckpoint(callId: string) {
  try {
    return await CallBillingCheckpoint.findOne({ callId }).lean();
  } catch (err) {
    logError('Billing checkpoint read failed', err, { callId });
    return null;
  }
}
