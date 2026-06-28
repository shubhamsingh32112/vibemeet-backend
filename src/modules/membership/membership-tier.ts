export const MEMBERSHIP_TIERS = ['NONE', 'VIP'] as const;
export type MembershipTier = (typeof MEMBERSHIP_TIERS)[number];

export function isMembershipTier(value: unknown): value is MembershipTier {
  return typeof value === 'string' && (MEMBERSHIP_TIERS as readonly string[]).includes(value);
}
