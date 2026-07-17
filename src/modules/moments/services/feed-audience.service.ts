import { isMomentsFreeAccessMode } from '../../../config/moments';
import type { FeedOrderingResult } from './moments-feed.service';

/**
 * Audience routing (not entitlement): premium subscribers receive chronological feed only.
 * Feed ordering always returns editorial preview + chronological sections. Audiences
 * without a preview rail still receive those moments as chronological feed entries.
 */
export function applyAudienceToFeedOrdering(
  ordering: FeedOrderingResult,
  isPremium: boolean,
): FeedOrderingResult {
  if (!isPremium && !isMomentsFreeAccessMode()) return ordering;
  return {
    ...ordering,
    moments: ordering.moments.map((m) =>
      m.section === 'preview' ? { ...m, section: 'feed' as const } : m,
    ),
    sections: { previewEndIndex: 0 },
  };
}
