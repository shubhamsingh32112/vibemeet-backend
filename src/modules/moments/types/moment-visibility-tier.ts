export const MOMENT_VISIBILITY_TIERS = ['PUBLIC', 'VIP'] as const;
export type MomentVisibilityTier = (typeof MOMENT_VISIBILITY_TIERS)[number];

export function isMomentVisibilityTier(value: unknown): value is MomentVisibilityTier {
  return typeof value === 'string' && (MOMENT_VISIBILITY_TIERS as readonly string[]).includes(value);
}
