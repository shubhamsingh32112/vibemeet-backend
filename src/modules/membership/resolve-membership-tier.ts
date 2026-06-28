import { isVipActive } from '../vip/vip-entitlement.service';
import type { MembershipTier } from './membership-tier';

export async function resolveMembershipTier(
  userId: string,
): Promise<MembershipTier> {
  if (await isVipActive(userId)) return 'VIP';
  return 'NONE';
}
