import mongoose from 'mongoose';
import { CallHistory } from './call-history.model';
import { Call } from '../video/call.model';
import { User } from '../user/user.model';
import { Creator } from '../creator/creator.model';
import { buildAvatarUrls } from '../images/image-url';
import { isBillingOutboxProjectionEnabled } from './billing-phase-flags';
import { recordPendingRecentsAgeSeconds } from './billing-phase-metrics';
import { logError, logInfo } from '../../utils/logger';
import { getDurableCallSession } from './call-session.service';
import type { CallSession as RedisCallSession } from './billing.service';

async function resolvePartyDetails(params: {
  userMongoId: string;
  creatorMongoId: string;
  userFirebaseUid: string;
  creatorFirebaseUid: string;
}) {
  const [userDoc, creatorDoc, creatorUserDoc] = await Promise.all([
    User.findById(params.userMongoId).select('username phone email avatar firebaseUid').lean(),
    Creator.findById(params.creatorMongoId).select('name avatar userId').lean(),
    User.findOne({ firebaseUid: params.creatorFirebaseUid }).select('firebaseUid').lean(),
  ]);

  const userName = userDoc?.username || userDoc?.phone || userDoc?.email || 'User';
  const creatorName = creatorDoc?.name || 'Creator';
  const userAvatar = userDoc?.avatar?.imageId
    ? buildAvatarUrls(userDoc.avatar.imageId).md
    : undefined;
  const creatorAvatar = creatorDoc?.avatar?.imageId
    ? buildAvatarUrls(creatorDoc.avatar.imageId).md
    : undefined;

  return {
    userName,
    creatorName,
    userAvatar,
    creatorAvatar,
    creatorOwnerUserId: creatorDoc?.userId,
    creatorDocId: creatorDoc?._id,
    creatorFirebaseUid: creatorUserDoc?.firebaseUid || params.creatorFirebaseUid,
  };
}

/**
 * Phase A: upsert pending CallHistory rows when billing enters `ending`.
 * Phase D retires this when BILLING_OUTBOX_PROJECTION_ENABLED routes via projector.
 */
export async function upsertPendingCallHistoryOnEnding(params: {
  callId: string;
  redisSession?: RedisCallSession | null;
  durationSeconds?: number;
}): Promise<void> {
  if (isBillingOutboxProjectionEnabled()) {
    return;
  }

  const { callId } = params;
  try {
    const alreadySettled = await CallHistory.findOne({
      callId,
      settlementStatus: 'settled',
    })
      .select('_id')
      .lean();
    if (alreadySettled) {
      logInfo('pending_call_history_skip_already_settled', { callId });
      return;
    }

    const durable = await getDurableCallSession(callId);
    const callLifecycle = await Call.findOne({ callId })
      .select('startedAt endedAt callerUserId creatorUserId initiatedByRole')
      .lean();

    let userMongoId = durable?.callerId?.toString();
    let creatorMongoId = durable?.creatorId?.toString();
    let userFirebaseUid = durable?.callerFirebaseUid;
    let creatorFirebaseUid = durable?.creatorFirebaseUid;

    if (params.redisSession) {
      userMongoId = params.redisSession.userMongoId || userMongoId;
      creatorMongoId = params.redisSession.creatorMongoId || creatorMongoId;
      userFirebaseUid = params.redisSession.userFirebaseUid || userFirebaseUid;
      creatorFirebaseUid = params.redisSession.creatorFirebaseUid || creatorFirebaseUid;
    }

    if (!userMongoId || !creatorMongoId || !userFirebaseUid || !creatorFirebaseUid) {
      logInfo('pending_call_history_skip_missing_parties', { callId });
      return;
    }

    const durationSeconds =
      params.durationSeconds ??
      durable?.accumulatedDurationSec ??
      params.redisSession?.elapsedSeconds ??
      0;

    const details = await resolvePartyDetails({
      userMongoId,
      creatorMongoId,
      userFirebaseUid,
      creatorFirebaseUid,
    });

    const initiatedByRole = callLifecycle?.initiatedByRole;
    const creatorInitiated = initiatedByRole === 'creator' || initiatedByRole === 'admin';
    const userDirection = creatorInitiated ? 'incoming' : 'outgoing';
    const creatorDirection = creatorInitiated ? 'outgoing' : 'incoming';

    const callStartedAt = callLifecycle?.startedAt ?? durable?.startedAt ?? new Date();
    const callEndedAt = callLifecycle?.endedAt ?? durable?.endedAt ?? new Date();

    const baseFields = {
      durationSeconds: Math.max(0, durationSeconds),
      callStartedAt,
      callEndedAt,
      settlementStatus: 'pending' as const,
      coinsDeducted: 0,
      coinsEarned: 0,
    };

    const pendingOnlyFilter = { settlementStatus: { $ne: 'settled' as const } };

    await CallHistory.findOneAndUpdate(
      {
        callId,
        ownerUserId: new mongoose.Types.ObjectId(userMongoId),
        ...pendingOnlyFilter,
      },
      {
        callId,
        ownerUserId: new mongoose.Types.ObjectId(userMongoId),
        otherUserId: details.creatorOwnerUserId || new mongoose.Types.ObjectId(creatorMongoId),
        otherCreatorId: details.creatorDocId,
        otherName: details.creatorName,
        otherAvatar: details.creatorAvatar,
        otherFirebaseUid: details.creatorFirebaseUid,
        ownerRole: 'user',
        direction: userDirection,
        ...baseFields,
      },
      { upsert: true, new: true }
    );

    if (details.creatorOwnerUserId) {
      await CallHistory.findOneAndUpdate(
        {
          callId,
          ownerUserId: details.creatorOwnerUserId,
          ...pendingOnlyFilter,
        },
        {
          callId,
          ownerUserId: details.creatorOwnerUserId,
          otherUserId: new mongoose.Types.ObjectId(userMongoId),
          otherName: details.userName,
          otherAvatar: details.userAvatar,
          otherFirebaseUid: userFirebaseUid,
          ownerRole: 'creator',
          direction: creatorDirection,
          ...baseFields,
        },
        { upsert: true, new: true }
      );
    }

    recordPendingRecentsAgeSeconds(callId, 0);
    logInfo('pending_call_history_upserted', { callId, durationSeconds });
  } catch (err) {
    logError('pending_call_history_upsert_failed', err, { callId });
  }
}
