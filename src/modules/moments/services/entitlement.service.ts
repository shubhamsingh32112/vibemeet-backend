import type { Types } from 'mongoose';
import { getRedis, isRedisConfigured } from '../../../config/redis';
import { isMomentsPremiumActive } from '../../moments-premium/moments-premium-entitlement.service';

export type MomentAccessReason = 'OWNER' | 'PREMIUM' | 'PREVIEW' | 'ADMIN' | 'DENIED';

export interface MomentAccessResult {
  allowed: boolean;
  reason: MomentAccessReason;
}

export interface MomentAccessContext {
  isCreatorOwner?: boolean;
  isPreviewMoment?: boolean;
  isStaffAdmin?: boolean;
}

export async function resolveMomentAccess(
  userId: Types.ObjectId | string | null | undefined,
  _momentId: Types.ObjectId | string,
  context: MomentAccessContext = {},
): Promise<MomentAccessResult> {
  if (context.isCreatorOwner) {
    return { allowed: true, reason: 'OWNER' };
  }
  if (context.isStaffAdmin) {
    return { allowed: true, reason: 'ADMIN' };
  }
  if (!userId) {
    return { allowed: false, reason: 'DENIED' };
  }
  const uid = typeof userId === 'string' ? userId : userId.toString();
  if (await isMomentsPremiumActive(uid)) {
    return { allowed: true, reason: 'PREMIUM' };
  }
  if (context.isPreviewMoment) {
    return { allowed: true, reason: 'PREVIEW' };
  }
  return { allowed: false, reason: 'DENIED' };
}

/** @deprecated Use resolveMomentAccess */
export async function hasMomentAccess(
  userId: Types.ObjectId | string | null | undefined,
  momentId: Types.ObjectId | string,
  context?: MomentAccessContext,
): Promise<boolean> {
  const result = await resolveMomentAccess(userId, momentId, context);
  return result.allowed;
}

export async function hasMomentAccessIncludingDeleted(
  userId: Types.ObjectId | string | null | undefined,
  _momentId: Types.ObjectId | string,
): Promise<boolean> {
  if (!userId) return false;
  return false;
}

export async function canViewDeletedMoment(
  userId: Types.ObjectId | string | null | undefined,
  momentId: Types.ObjectId | string,
): Promise<boolean> {
  if (!userId) return false;
  const { CreatorMoment } = await import('../models/creator-moment.model');
  const moment = await CreatorMoment.findById(momentId).lean();
  if (!moment?.isDeleted) return true;
  if (moment.deletedAccessPolicy === 'fully_remove') return false;
  return false;
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
