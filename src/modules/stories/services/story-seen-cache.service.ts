import { getRedis, isRedisConfigured } from '../../../config/redis';

export async function markStorySeen(
  viewerUserId: string,
  creatorId: string,
  storyCreatedAt: Date,
): Promise<void> {
  if (!isRedisConfigured()) return;
  const key = `story_seen:${viewerUserId}:${creatorId}`;
  const existing = await getRedis().get(key);
  if (!existing || storyCreatedAt > new Date(existing)) {
    await getRedis().set(key, storyCreatedAt.toISOString(), 'EX', 48 * 3600);
  }
}

export async function isCreatorUnseen(
  viewerUserId: string,
  creatorId: string,
  latestStoryCreatedAt: Date,
): Promise<boolean> {
  if (!isRedisConfigured()) return true;
  const seen = await getRedis().get(`story_seen:${viewerUserId}:${creatorId}`);
  if (!seen) return true;
  return latestStoryCreatedAt > new Date(seen);
}
