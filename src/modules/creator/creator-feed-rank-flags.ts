export function isCreatorFeedRedisRankEnabled(): boolean {
  return process.env.CREATOR_FEED_REDIS_RANK_ENABLED === 'true';
}

export function isCreatorFeedRankShadowEnabled(): boolean {
  return process.env.CREATOR_FEED_RANK_SHADOW === 'true';
}

export function shouldRebuildCreatorFeedRankOnStartup(): boolean {
  return process.env.CREATOR_FEED_RANK_REBUILD === 'true';
}

export function readCreatorFeedAvailabilityMaxCatalog(): number {
  const raw = parseInt(process.env.CREATOR_FEED_AVAILABILITY_MAX_CATALOG || '8000', 10);
  if (!Number.isFinite(raw) || raw <= 0) return 8000;
  return Math.min(20000, raw);
}
