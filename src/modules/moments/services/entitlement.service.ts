import type { Types } from 'mongoose';
import { getRedis, isRedisConfigured } from '../../../config/redis';
import { MomentPurchase } from '../models/moment-purchase.model';
import { CreatorMoment } from '../models/creator-moment.model';

export async function hasMomentAccess(
  userId: Types.ObjectId | string | null | undefined,
  momentId: Types.ObjectId | string,
): Promise<boolean> {
  if (!userId) return false;
  const uid = typeof userId === 'string' ? userId : userId.toString();
  const mid = typeof momentId === 'string' ? momentId : momentId.toString();

  const purchase = await MomentPurchase.findOne({
    userId: uid,
    mediaId: mid,
  }).lean();
  if (purchase) return true;

  const moment = await CreatorMoment.findById(mid).lean();
  if (!moment) return false;
  if (moment.isDeleted) return false;
  if (moment.accessType === 'free') return true;
  return false;
}

export async function hasMomentAccessIncludingDeleted(
  userId: Types.ObjectId | string | null | undefined,
  momentId: Types.ObjectId | string,
): Promise<boolean> {
  if (!userId) return false;
  const purchase = await MomentPurchase.findOne({
    userId,
    mediaId: momentId,
  }).lean();
  if (purchase) return true;

  const moment = await CreatorMoment.findById(momentId).lean();
  if (!moment) return false;
  if (moment.isDeleted) {
    return false;
  }
  return moment.accessType === 'free';
}

export async function canViewDeletedMoment(
  userId: Types.ObjectId | string | null | undefined,
  momentId: Types.ObjectId | string,
): Promise<boolean> {
  if (!userId) return false;
  const moment = await CreatorMoment.findById(momentId).lean();
  if (!moment?.isDeleted) return true;
  if (moment.deletedAccessPolicy === 'fully_remove') return false;
  const purchase = await MomentPurchase.findOne({ userId, mediaId: momentId }).lean();
  return Boolean(purchase);
}

const PURCHASE_LOCK_PREFIX = 'lock:moment_purchase:';

export class PurchaseInProgressError extends Error {
  readonly code = 'PURCHASE_IN_PROGRESS';
  constructor() {
    super('Purchase already in progress');
  }
}

export async function withPurchaseLock<T>(
  userId: string,
  momentId: string,
  ttlSec: number,
  fn: () => Promise<T>,
): Promise<T> {
  if (!isRedisConfigured()) {
    return fn();
  }
  const key = `${PURCHASE_LOCK_PREFIX}${userId}:${momentId}`;
  const acquired = await getRedis().set(key, '1', 'EX', ttlSec, 'NX');
  if (acquired !== 'OK') {
    throw new PurchaseInProgressError();
  }
  try {
    return await fn();
  } finally {
    await getRedis().del(key);
  }
}
