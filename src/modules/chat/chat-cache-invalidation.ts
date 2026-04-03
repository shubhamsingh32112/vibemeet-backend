import { getRedis } from '../../config/redis';

const CHANNEL_OTHER_MEMBER_PREFIX = 'chat:channel:other:';

/**
 * Drop cached "other member" payloads for any viewer where the cached subject is `firebaseUid`.
 * Needed after profile / creator profile updates so chat header fallback stays fresh.
 */
export async function invalidateOtherMemberCacheForFirebaseUid(
  firebaseUid: string,
): Promise<void> {
  try {
    const redis = getRedis();
    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(
        cursor,
        'MATCH',
        `${CHANNEL_OTHER_MEMBER_PREFIX}*`,
        'COUNT',
        '200',
      );
      cursor = next;
      for (const key of keys) {
        const raw = await redis.get(key);
        if (!raw) continue;
        try {
          const data = JSON.parse(raw) as { firebaseUid?: string };
          if (data.firebaseUid === firebaseUid) {
            await redis.del(key);
          }
        } catch {
          /* ignore malformed cache */
        }
      }
    } while (cursor !== '0');
  } catch (e) {
    console.error('⚠️ [CHAT] Failed to invalidate other-member cache:', e);
  }
}
