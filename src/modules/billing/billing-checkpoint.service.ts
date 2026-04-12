import { CallBillingCheckpoint } from './call-billing-checkpoint.model';
import { logError } from '../../utils/logger';

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
