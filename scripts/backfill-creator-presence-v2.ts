/**
 * One-off / periodic backfill: write canonical creator:presence:{uid} v2 keys from legacy availability.
 *
 * Usage (from backend/):
 *   npx ts-node scripts/backfill-creator-presence-v2.ts
 *   npx ts-node scripts/backfill-creator-presence-v2.ts --uids=uid1,uid2
 */
import { getRedis, creatorPresenceKey, availabilityKey } from '../src/config/redis';
import { logInfo, logError } from '../src/utils/logger';

const KEY_PREFIX = 'creator:availability:';
const PRESENCE_TTL_SECONDS = 120;

async function scanLegacyCreators(): Promise<string[]> {
  const redis = getRedis();
  const ids: string[] = [];
  let cursor = '0';
  do {
    const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', `${KEY_PREFIX}*`, 'COUNT', 200);
    cursor = nextCursor;
    if (!keys.length) continue;
    keys.forEach((key) => {
      ids.push(key.replace(KEY_PREFIX, ''));
    });
  } while (cursor !== '0');
  return Array.from(new Set(ids));
}

async function main(): Promise<void> {
  const argUids = process.argv
    .find((a) => a.startsWith('--uids='))
    ?.split('=')[1]
    ?.split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const uids = argUids?.length ? argUids : await scanLegacyCreators();
  logInfo('creator_presence_v2_backfill_start', { count: uids.length });

  let written = 0;
  let skipped = 0;
  const redis = getRedis();

  for (const uid of uids) {
    try {
      const existing = await redis.get(creatorPresenceKey(uid));
      if (existing) {
        skipped += 1;
        continue;
      }
      const legacy = await redis.get(availabilityKey(uid));
      const state = legacy === 'online' ? 'online' : 'busy';
      const record = {
        state,
        updatedAt: Date.now(),
        source: 'backfill-creator-presence-v2',
        version: 1,
      };
      await redis.setex(creatorPresenceKey(uid), PRESENCE_TTL_SECONDS, JSON.stringify(record));
      written += 1;
    } catch (err) {
      logError('creator_presence_v2_backfill_failed', err, { uid });
    }
  }

  logInfo('creator_presence_v2_backfill_done', { written, skipped, total: uids.length });
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    logError('creator_presence_v2_backfill_fatal', err);
    process.exit(1);
  });
