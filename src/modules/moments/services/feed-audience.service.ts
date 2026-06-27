import { isMomentsFreeAccessMode } from '../../../config/moments';
import type { FeedOrderingResult } from './moments-feed.service';

/**
 * Audience routing (not entitlement): premium subscribers receive chronological feed only.
 * Feed ordering always returns editorial preview + chronological sections; this strips
 * the preview section before presentation for premium users.
 */
export function applyAudienceToFeedOrdering(
  ordering: FeedOrderingResult,
  isPremium: boolean,
): FeedOrderingResult {
  if (!isPremium && !isMomentsFreeAccessMode()) return ordering;
  return {
    ...ordering,
    moments: ordering.moments.filter((m) => m.section !== 'preview'),
    sections: { previewEndIndex: 0 },
  };
}
