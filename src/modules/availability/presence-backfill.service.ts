import { availabilityKey, creatorPresenceKey, getRedis } from '../../config/redis';
import { logError, logInfo } from '../../utils/logger';
import type { CreatorPresenceRecord } from './presence.service';

const LEGACY_AVAILABILITY_PREFIX = 'creator:availability:';
const DEFAULT_PRESENCE_TTL_SECONDS = 120;

export type CreatorPresenceBackfillOptions = {
  uids?: string[];
  source?: string;
  ttlSeconds?: number;
  skipIfCanonicalExists?: boolean;
  logProgress?: boolean;
  progressEvery?: number;
};

export type CreatorPresenceBackfillResult = {
  total: number;
  written: number;
  skippedExisting: number;
  skippedMissingLegacy: number;
  failed: number;
};

async function scanLegacyCreatorIds(): Promise<string[]> {
  const redis = getRedis();
  const ids: string[] = [];
  let cursor = '0';
  do {
    const [nextCursor, keys] = await redis.scan(
      cursor,
      'MATCH',
      `${LEGACY_AVAILABILITY_PREFIX}*`,
      'COUNT',
      200
    );
    cursor = nextCursor;
    if (keys.length > 0) {
      keys.forEach((key) => ids.push(key.replace(LEGACY_AVAILABILITY_PREFIX, '')));
    }
  } while (cursor !== '0');
  return Array.from(new Set(ids));
}

export async function backfillCreatorPresenceV2(
  options: CreatorPresenceBackfillOptions = {}
): Promise<CreatorPresenceBackfillResult> {
  const redis = getRedis();
  const uids = options.uids && options.uids.length > 0 ? Array.from(new Set(options.uids)) : await scanLegacyCreatorIds();
  const ttlSeconds = options.ttlSeconds ?? DEFAULT_PRESENCE_TTL_SECONDS;
  const source = options.source ?? 'backfill-creator-presence-v2';
  const skipIfCanonicalExists = options.skipIfCanonicalExists ?? true;
  const logProgress = options.logProgress ?? false;
  const progressEvery = Math.max(1, options.progressEvery ?? 100);

  let written = 0;
  let skippedExisting = 0;
  let skippedMissingLegacy = 0;
  let failed = 0;
  let processed = 0;

  if (logProgress) {
    logInfo('creator_presence_v2_backfill_progress_start', {
      source,
      total: uids.length,
      ttlSeconds,
      skipIfCanonicalExists,
      progressEvery,
    });
  }

  for (const uid of uids) {
    try {
      if (skipIfCanonicalExists) {
        const existing = await redis.get(creatorPresenceKey(uid));
        if (existing) {
          skippedExisting += 1;
          continue;
        }
      }

      const legacyState = await redis.get(availabilityKey(uid));
      if (!legacyState) {
        skippedMissingLegacy += 1;
        continue;
      }

      const record: CreatorPresenceRecord = {
        state: legacyState === 'online' ? 'online' : 'busy',
        updatedAt: Date.now(),
        source,
        version: 1,
      };
      await redis.setex(creatorPresenceKey(uid), ttlSeconds, JSON.stringify(record));
      written += 1;
    } catch (err) {
      failed += 1;
      logError('creator_presence_v2_backfill_item_failed', err, { uid, source });
    }
    processed += 1;
    if (logProgress) {
      const shouldLog =
        processed <= 5 ||
        processed % progressEvery === 0 ||
        processed === uids.length;
      if (shouldLog) {
        logInfo('creator_presence_v2_backfill_progress', {
          source,
          processed,
          total: uids.length,
          written,
          skippedExisting,
          skippedMissingLegacy,
          failed,
        });
      }
    }
  }

  const result = {
    total: uids.length,
    written,
    skippedExisting,
    skippedMissingLegacy,
    failed,
  };
  if (logProgress) {
    logInfo('creator_presence_v2_backfill_progress_done', {
      source,
      ...result,
    });
  }
  return result;
}
