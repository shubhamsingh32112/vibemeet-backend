import type { Types } from 'mongoose';
import { Creator } from '../creator/creator.model';
import { User } from '../user/user.model';
import { featureFlags } from '../../config/feature-flags';
import {
  VIP_SCHEDULE_MAX_DAYS_AHEAD,
  VIP_SCHEDULE_MIN_LEAD_MINUTES,
} from './vip.config';
import { ScheduledCall } from './models/scheduled-call.model';
import { isVipActive } from './vip-entitlement.service';

export class VipSchedulingError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
  }
}

function assertSchedulingEnabled(): void {
  if (!featureFlags.vipSchedulingEnabled) {
    throw new VipSchedulingError('Call scheduling is not enabled', 'SCHEDULING_DISABLED');
  }
}

export async function scheduleVipCall(input: {
  callerUserId: Types.ObjectId | string;
  creatorId: string;
  scheduledAt: Date;
  durationMinutes?: number;
  notes?: string;
}) {
  assertSchedulingEnabled();
  if (!(await isVipActive(input.callerUserId))) {
    throw new VipSchedulingError('VIP membership required', 'VIP_REQUIRED');
  }

  const creator = await Creator.findById(input.creatorId);
  if (!creator) {
    throw new VipSchedulingError('Creator not found', 'CREATOR_NOT_FOUND');
  }

  const creatorUser = await User.findById(creator.userId);
  if (!creatorUser?.firebaseUid) {
    throw new VipSchedulingError('Creator user not found', 'CREATOR_USER_NOT_FOUND');
  }

  const now = Date.now();
  const minAt = now + VIP_SCHEDULE_MIN_LEAD_MINUTES * 60 * 1000;
  const maxAt = now + VIP_SCHEDULE_MAX_DAYS_AHEAD * 24 * 60 * 60 * 1000;
  const scheduledMs = input.scheduledAt.getTime();

  if (scheduledMs < minAt) {
    throw new VipSchedulingError(
      `Schedule at least ${VIP_SCHEDULE_MIN_LEAD_MINUTES} minutes ahead`,
      'SCHEDULE_TOO_SOON',
    );
  }
  if (scheduledMs > maxAt) {
    throw new VipSchedulingError(
      `Cannot schedule more than ${VIP_SCHEDULE_MAX_DAYS_AHEAD} days ahead`,
      'SCHEDULE_TOO_FAR',
    );
  }

  const call = await ScheduledCall.create({
    callerUserId: input.callerUserId,
    creatorId: creator._id,
    creatorFirebaseUid: creatorUser.firebaseUid,
    scheduledAt: input.scheduledAt,
    durationMinutes: input.durationMinutes ?? 15,
    notes: input.notes?.trim().slice(0, 500),
    status: 'pending_creator',
  });

  return call;
}

export async function listCallerScheduledCalls(callerUserId: Types.ObjectId | string) {
  return ScheduledCall.find({ callerUserId })
    .sort({ scheduledAt: -1 })
    .limit(50)
    .lean();
}

export async function listCreatorIncomingScheduledCalls(
  creatorId: Types.ObjectId | string,
) {
  return ScheduledCall.find({
    creatorId,
    status: { $in: ['pending_creator', 'confirmed'] },
    scheduledAt: { $gte: new Date() },
  })
    .sort({ scheduledAt: 1 })
    .limit(50)
    .lean();
}

export async function confirmScheduledCall(
  callId: string,
  creatorId: Types.ObjectId | string,
) {
  const call = await ScheduledCall.findOne({ _id: callId, creatorId });
  if (!call) {
    throw new VipSchedulingError('Scheduled call not found', 'NOT_FOUND');
  }
  if (call.status !== 'pending_creator') {
    throw new VipSchedulingError('Call cannot be confirmed', 'INVALID_STATUS');
  }
  call.status = 'confirmed';
  call.confirmedAt = new Date();
  await call.save();
  return call;
}

export async function cancelScheduledCall(
  callId: string,
  actor: { userId: Types.ObjectId | string; isCreator: boolean },
) {
  const call = await ScheduledCall.findById(callId);
  if (!call) {
    throw new VipSchedulingError('Scheduled call not found', 'NOT_FOUND');
  }

  const isCaller = call.callerUserId.toString() === actor.userId.toString();
  const isCreator =
    actor.isCreator && call.creatorId.toString() === actor.userId.toString();
  if (!isCaller && !isCreator) {
    throw new VipSchedulingError('Not authorized', 'FORBIDDEN');
  }

  if (['cancelled', 'completed', 'missed'].includes(call.status)) {
    throw new VipSchedulingError('Call already closed', 'INVALID_STATUS');
  }

  call.status = 'cancelled';
  call.cancelledAt = new Date();
  call.cancelledBy = isCreator ? 'creator' : 'caller';
  await call.save();
  return call;
}

export async function getDueScheduledCalls(withinMinutes = 0) {
  const now = new Date();
  const windowEnd = new Date(now.getTime() + withinMinutes * 60 * 1000);
  return ScheduledCall.find({
    status: 'confirmed',
    scheduledAt: { $lte: windowEnd, $gte: new Date(now.getTime() - 5 * 60 * 1000) },
    reminderSentAt: null,
  }).lean();
}
