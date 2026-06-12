import mongoose from 'mongoose';
import { CallHistory } from './call-history.model';
import { Call } from '../video/call.model';
import { User } from '../user/user.model';
import { Creator } from '../creator/creator.model';
import { buildAvatarUrls } from '../images/image-url';
import { logError, logInfo } from '../../utils/logger';
import { recordPendingRecentsAgeSeconds } from './billing-phase-metrics';

export type CallBillingProjectionEvent =
  | { type: 'call.billing.ending'; callId: string; payload: Record<string, unknown> }
  | { type: 'call.billing.settled'; callId: string; payload: Record<string, unknown> }
  | { type: 'call.billing.failed_settlement'; callId: string; payload: Record<string, unknown> };

async function resolveParties(callId: string, payload: Record<string, unknown>) {
  const userMongoId = String(payload.userMongoId || '');
  const creatorMongoId = String(payload.creatorMongoId || '');
  const userFirebaseUid = String(payload.userFirebaseUid || '');
  const creatorFirebaseUid = String(payload.creatorFirebaseUid || '');

  const [userDoc, creatorDoc] = await Promise.all([
    User.findById(userMongoId).select('username phone email avatar firebaseUid').lean(),
    Creator.findById(creatorMongoId).select('name avatar userId').lean(),
  ]);

  const userName = userDoc?.username || userDoc?.phone || userDoc?.email || 'User';
  const creatorName = creatorDoc?.name || 'Creator';
  const userAvatar = userDoc?.avatar?.imageId
    ? buildAvatarUrls(userDoc.avatar.imageId).md
    : undefined;
  const creatorAvatar = creatorDoc?.avatar?.imageId
    ? buildAvatarUrls(creatorDoc.avatar.imageId).md
    : undefined;

  const callLifecycle = await Call.findOne({ callId }).select('startedAt endedAt initiatedByRole').lean();
  const initiatedByRole = callLifecycle?.initiatedByRole;
  const creatorInitiated = initiatedByRole === 'creator' || initiatedByRole === 'admin';

  return {
    userMongoId,
    creatorMongoId,
    userFirebaseUid,
    creatorFirebaseUid,
    userName,
    creatorName,
    userAvatar,
    creatorAvatar,
    creatorOwnerUserId: creatorDoc?.userId?.toString(),
    creatorDocId: creatorDoc?._id,
    userDirection: creatorInitiated ? ('incoming' as const) : ('outgoing' as const),
    creatorDirection: creatorInitiated ? ('outgoing' as const) : ('incoming' as const),
    callStartedAt: callLifecycle?.startedAt ?? new Date(),
    callEndedAt: callLifecycle?.endedAt ?? new Date(),
  };
}

export async function projectCallHistoryFromBillingEvent(
  event: CallBillingProjectionEvent
): Promise<void> {
  try {
    const { callId, payload } = event;
    const parties = await resolveParties(callId, payload);
    const durationSeconds = Math.max(0, Number(payload.durationSeconds) || 0);

    if (event.type === 'call.billing.ending') {
      const base = {
        durationSeconds,
        callStartedAt: parties.callStartedAt,
        callEndedAt: parties.callEndedAt,
        settlementStatus: 'pending' as const,
        coinsDeducted: 0,
        coinsEarned: 0,
      };

      await CallHistory.findOneAndUpdate(
        { callId, ownerUserId: new mongoose.Types.ObjectId(parties.userMongoId) },
        {
          callId,
          ownerUserId: parties.userMongoId,
          otherUserId: parties.creatorOwnerUserId || parties.creatorMongoId,
          otherCreatorId: parties.creatorDocId,
          otherName: parties.creatorName,
          otherAvatar: parties.creatorAvatar,
          otherFirebaseUid: parties.creatorFirebaseUid,
          ownerRole: 'user',
          direction: parties.userDirection,
          ...base,
        },
        { upsert: true, new: true }
      );

      if (parties.creatorOwnerUserId) {
        await CallHistory.findOneAndUpdate(
          { callId, ownerUserId: parties.creatorOwnerUserId },
          {
            callId,
            ownerUserId: parties.creatorOwnerUserId,
            otherUserId: parties.userMongoId,
            otherName: parties.userName,
            otherAvatar: parties.userAvatar,
            otherFirebaseUid: parties.userFirebaseUid,
            ownerRole: 'creator',
            direction: parties.creatorDirection,
            ...base,
          },
          { upsert: true, new: true }
        );
      }

      recordPendingRecentsAgeSeconds(callId, 0);
      logInfo('call_history_projected_pending', { callId });
      return;
    }

    if (event.type === 'call.billing.settled') {
      const settledAt = new Date();
      const update = {
        settlementStatus: 'settled' as const,
        settledAt,
        durationSeconds,
        coinsDeducted: Math.max(0, Number(payload.coinsDeducted) || 0),
        coinsEarned: Math.max(0, Number(payload.coinsEarned) || 0),
      };

      await CallHistory.updateMany({ callId }, { $set: update });
      logInfo('call_history_projected_settled', { callId });
      return;
    }

    if (event.type === 'call.billing.failed_settlement') {
      await CallHistory.updateMany({ callId }, { $set: { settlementStatus: 'failed' } });
      logInfo('call_history_projected_failed', { callId });
    }
  } catch (err) {
    logError('call_history_projection_failed', err, { eventType: event.type, callId: event.callId });
  }
}

export async function enqueueCallBillingProjectionEvent(
  event: CallBillingProjectionEvent
): Promise<void> {
  const { persistDomainEvent } = await import('../events/domain-event.service');
  const { isBillingOutboxProjectionEnabled } = await import('./billing-phase-flags');

  const useAsyncOutbox =
    isBillingOutboxProjectionEnabled() && process.env.DOMAIN_EVENTS_ENABLED === 'true';

  if (useAsyncOutbox) {
    await persistDomainEvent({
      eventType: event.type,
      aggregateId: event.callId,
      idempotencyKey: `${event.type}_${event.callId}`,
      payload: {
        ...event.payload,
        callId: event.callId,
        projectionKind: event.type,
      },
    });
    return;
  }

  await projectCallHistoryFromBillingEvent(event);
}
