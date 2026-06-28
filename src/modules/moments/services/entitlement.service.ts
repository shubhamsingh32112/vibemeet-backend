import type { Types } from 'mongoose';
import { getRedis, isRedisConfigured } from '../../../config/redis';
import { isMomentsPremiumActive } from '../../moments-premium/moments-premium-entitlement.service';
import { isVipActive } from '../../vip/vip-entitlement.service';
import type { MomentVisibilityTier } from '../types/moment-visibility-tier';

export type MomentAccessReason =
  | 'OWNER'
  | 'CREATOR'
  | 'VIP'
  | 'PREMIUM'
  | 'PREVIEW'
  | 'ADMIN'
  | 'VIP_ONLY'
  | 'DENIED';

export interface MomentAccessResult {
  allowed: boolean;
  reason: MomentAccessReason;
}

export interface MomentAccessContext {
  isCreatorOwner?: boolean;
  isPreviewMoment?: boolean;
  isStaffAdmin?: boolean;
  isCreatorRole?: boolean;
  visibilityTier?: MomentVisibilityTier;
  /** @internal unit tests only — bypasses isVipActive lookup */
  __testVipActive?: boolean;
  /** @internal unit tests only — bypasses isMomentsPremiumActive lookup */
  __testPremiumActive?: boolean;
}

export function isCreatorOrAdminRole(role: string | undefined | null): boolean {
  return role === 'creator' || role === 'admin';
}

/**
 * Moment access precedence (resolveMomentAccess):
 *
 * Owner
 *   ↓
 * Admin
 *   ↓
 * Creator
 *   ↓
 * VIP-tier content (visibilityTier === VIP)
 *   ↓ isVipActive? → ALLOW (reason: VIP) : DENY (reason: VIP_ONLY)
 * PUBLIC-tier content (visibilityTier === PUBLIC)
 *   ↓ isVipActive? → ALLOW (reason: VIP)
 *   ↓ isMomentsPremiumActive? → ALLOW (reason: PREMIUM)
 *   ↓ isPreviewMoment? → ALLOW (reason: PREVIEW)
 *   ↓ DENY (reason: DENIED)
 */
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
  if (context.isCreatorRole) {
    return { allowed: true, reason: 'CREATOR' };
  }
  if (!userId) {
    return { allowed: false, reason: 'DENIED' };
  }

  const uid = typeof userId === 'string' ? userId : userId.toString();
  const visibilityTier = context.visibilityTier ?? 'PUBLIC';
  const vipActive =
    context.__testVipActive !== undefined
      ? context.__testVipActive
      : await isVipActive(uid);
  const premiumActive =
    context.__testPremiumActive !== undefined
      ? context.__testPremiumActive
      : await isMomentsPremiumActive(uid);

  if (visibilityTier === 'VIP') {
    if (vipActive) {
      return { allowed: true, reason: 'VIP' };
    }
    return { allowed: false, reason: 'VIP_ONLY' };
  }

  if (vipActive) {
    return { allowed: true, reason: 'VIP' };
  }
  if (premiumActive) {
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
