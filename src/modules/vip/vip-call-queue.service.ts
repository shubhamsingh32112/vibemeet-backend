import type { Types } from 'mongoose';
import { getRedis } from '../../config/redis';
import { getIO } from '../../config/socket';
import { featureFlags } from '../../config/feature-flags';
import { logInfo } from '../../utils/logger';
import { CallQueueEntry } from './models/call-queue-entry.model';
import { VIP_QUEUE_TTL_SEC } from './vip.config';
import { isVipActive } from './vip-entitlement.service';

const QUEUE_KEY_PREFIX = 'call:queue:';

function queueKey(creatorFirebaseUid: string): string {
  return `${QUEUE_KEY_PREFIX}${creatorFirebaseUid}`;
}

function vipQueueScore(): number {
  return Date.now();
}

export async function enqueueVipCaller(input: {
  creatorFirebaseUid: string;
  callerFirebaseUid: string;
  callerUserId: Types.ObjectId | string;
  callId: string;
}): Promise<{ position: number; entryId: string } | null> {
  if (!featureFlags.vipPriorityQueueEnabled) return null;
  if (!(await isVipActive(input.callerUserId))) return null;

  const redis = getRedis();
  const key = queueKey(input.creatorFirebaseUid);
  const score = vipQueueScore();
  const expiresAt = new Date(Date.now() + VIP_QUEUE_TTL_SEC * 1000);

  const existing = await CallQueueEntry.findOne({
    creatorFirebaseUid: input.creatorFirebaseUid,
    callerFirebaseUid: input.callerFirebaseUid,
    status: 'waiting',
  });
  if (existing) {
    const position = await getQueuePosition(input.creatorFirebaseUid, input.callerFirebaseUid);
    return { position, entryId: existing._id.toString() };
  }

  const entry = await CallQueueEntry.create({
    creatorFirebaseUid: input.creatorFirebaseUid,
    callerFirebaseUid: input.callerFirebaseUid,
    callerUserId: input.callerUserId,
    priority: 'vip',
    enqueuedAt: new Date(),
    expiresAt,
    status: 'waiting',
    callId: input.callId,
  });

  await redis.zadd(key, score, input.callerFirebaseUid);
  await redis.expire(key, VIP_QUEUE_TTL_SEC);

  const position = await getQueuePosition(input.creatorFirebaseUid, input.callerFirebaseUid);

  const io = getIO();
  io.to(`user:${input.callerFirebaseUid}`).emit('vip:call:queued', {
    creatorFirebaseUid: input.creatorFirebaseUid,
    position,
    callId: input.callId,
    entryId: entry._id.toString(),
  });

  logInfo('vip_call_enqueued', {
    creatorFirebaseUid: input.creatorFirebaseUid,
    callerFirebaseUid: input.callerFirebaseUid,
    position,
    callId: input.callId,
  });

  return { position, entryId: entry._id.toString() };
}

export async function getQueuePosition(
  creatorFirebaseUid: string,
  callerFirebaseUid: string,
): Promise<number> {
  const redis = getRedis();
  const key = queueKey(creatorFirebaseUid);
  const rank = await redis.zrank(key, callerFirebaseUid);
  return rank === null ? 0 : rank + 1;
}

export async function leaveCallQueue(
  creatorFirebaseUid: string,
  callerFirebaseUid: string,
): Promise<void> {
  const redis = getRedis();
  await redis.zrem(queueKey(creatorFirebaseUid), callerFirebaseUid);
  await CallQueueEntry.updateMany(
    {
      creatorFirebaseUid,
      callerFirebaseUid,
      status: 'waiting',
    },
    { $set: { status: 'cancelled' } },
  );
}

export async function popNextQueuedCaller(
  creatorFirebaseUid: string,
): Promise<{ callerFirebaseUid: string; callerUserId: string; entryId: string } | null> {
  if (!featureFlags.vipPriorityQueueEnabled) return null;

  const redis = getRedis();
  const key = queueKey(creatorFirebaseUid);
  const results = await redis.zrange(key, 0, 0);
  if (!results.length) return null;

  const callerFirebaseUid = results[0];
  await redis.zrem(key, callerFirebaseUid);

  const entry = await CallQueueEntry.findOneAndUpdate(
    {
      creatorFirebaseUid,
      callerFirebaseUid,
      status: 'waiting',
      expiresAt: { $gt: new Date() },
    },
    { $set: { status: 'ringing' } },
    { new: true },
  );

  if (!entry) return null;

  const io = getIO();
  io.to(`user:${callerFirebaseUid}`).emit('vip:call:dequeued', {
    creatorFirebaseUid,
    entryId: entry._id.toString(),
  });

  return {
    callerFirebaseUid,
    callerUserId: entry.callerUserId.toString(),
    entryId: entry._id.toString(),
  };
}

export async function getCallerQueueStatus(
  callerFirebaseUid: string,
): Promise<Array<{
  creatorFirebaseUid: string;
  position: number;
  entryId: string;
  enqueuedAt: string;
}>> {
  const entries = await CallQueueEntry.find({
    callerFirebaseUid,
    status: 'waiting',
    expiresAt: { $gt: new Date() },
  })
    .sort({ enqueuedAt: 1 })
    .lean();

  const results = [];
  for (const entry of entries) {
    const position = await getQueuePosition(
      entry.creatorFirebaseUid,
      callerFirebaseUid,
    );
    results.push({
      creatorFirebaseUid: entry.creatorFirebaseUid,
      position,
      entryId: entry._id.toString(),
      enqueuedAt: entry.enqueuedAt.toISOString(),
    });
  }
  return results;
}

export async function expireStaleQueueEntries(): Promise<number> {
  const now = new Date();
  const stale = await CallQueueEntry.find({
    status: 'waiting',
    expiresAt: { $lte: now },
  }).lean();

  for (const entry of stale) {
    const redis = getRedis();
    await redis.zrem(queueKey(entry.creatorFirebaseUid), entry.callerFirebaseUid);
  }

  const result = await CallQueueEntry.updateMany(
    { status: 'waiting', expiresAt: { $lte: now } },
    { $set: { status: 'expired' } },
  );
  return result.modifiedCount;
}
