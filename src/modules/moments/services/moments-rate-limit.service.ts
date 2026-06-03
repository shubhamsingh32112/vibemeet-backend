import { getRedis, isRedisConfigured } from '../../../config/redis';
import { getMomentsConfig } from '../../../config/moments';

export type MomentsRateLimitKind = 'purchase' | 'follow' | 'upload' | 'storyView';

const PREFIX: Record<MomentsRateLimitKind, string> = {
  purchase: 'rate_limit:moment_purchase:',
  follow: 'rate_limit:follow:',
  upload: 'rate_limit:moment_upload:',
  storyView: 'rate_limit:story_view:',
};

function limitsFor(kind: MomentsRateLimitKind): { max: number; windowSec: number } {
  const cfg = getMomentsConfig();
  switch (kind) {
    case 'purchase':
      return { max: cfg.rateLimitPurchaseMax, windowSec: cfg.rateLimitPurchaseWindowSec };
    case 'follow':
      return { max: cfg.rateLimitFollowMax, windowSec: cfg.rateLimitFollowWindowSec };
    case 'upload':
      return { max: cfg.rateLimitUploadMax, windowSec: cfg.rateLimitUploadWindowSec };
    case 'storyView':
      return { max: cfg.rateLimitStoryViewMax, windowSec: cfg.rateLimitStoryViewWindowSec };
  }
}

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSec?: number;
}

export async function checkMomentsRateLimit(
  kind: MomentsRateLimitKind,
  userId: string,
): Promise<RateLimitResult> {
  if (!isRedisConfigured()) return { allowed: true };
  const { max, windowSec } = limitsFor(kind);
  const key = `${PREFIX[kind]}${userId}`;
  const redis = getRedis();
  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, windowSec);
  }
  if (count > max) {
    const ttl = await redis.ttl(key);
    return { allowed: false, retryAfterSec: ttl > 0 ? ttl : windowSec };
  }
  return { allowed: true };
}
