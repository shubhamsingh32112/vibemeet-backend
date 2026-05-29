/**
 * Creator Availability Service
 * 
 * BACKEND-AUTHORITATIVE availability system using Railway Redis.
 * 
 * 🔥 AUTOMATIC STATUS: Status is automatically managed by socket connection
 * - When creator opens app → socket connects → automatically online
 * - When creator closes app → socket disconnects → automatically offline
 * - No manual toggle - status is automatic based on app lifecycle
 * 
 * Status semantics:
 * - 'online' = creator is available for calls
 * - 'busy' = creator is on a call, offline, or unavailable
 * 
 * Rule: Missing/unknown creators are ALWAYS 'busy'
 * 
 * Redis key design:
 *   creator:availability:{creatorId} → "online" | "busy"
 * 
 * 🔥 SCALABILITY OPTIMIZATION (1000 users/day, 200 creators):
 * - TTL: 120 seconds (auto-expire safety)
 * - Heartbeat: 60 seconds (refreshes TTL while connected)
 * - Batch operations: Uses MGET for efficient batch queries
 * - Socket.IO broadcasting: Instant updates to all connected clients
 * - Prevents ghost online users
 * - Handles crashes cleanly
 * - Forces creators to re-announce presence
 */

import {
  getRedis,
  isRedisConfigured,
  creatorPresenceKey,
  availabilityKey,
  CREATOR_PRESENCE_KEY_PREFIX,
} from '../../config/redis';
import { featureFlags } from '../../config/feature-flags';
import { logError, logInfo, logWarning } from '../../utils/logger';

export type CreatorAvailability = 'online' | 'busy';

function parsePresenceState(raw: string | null): CreatorAvailability | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { state?: string } | null;
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed.state === 'online' ? 'online' : 'busy';
  } catch {
    return null;
  }
}

/**
 * Set a creator's availability status
 * @param creatorId - The creator's Firebase UID
 * @param status - 'online' or 'busy'
 */
export async function setAvailability(
  creatorId: string,
  status: CreatorAvailability
): Promise<void> {
  void creatorId;
  void status;
  throw new Error(
    'setAvailability is disabled. Presence writes must go through transitionCreatorPresence in presence.service.ts'
  );
}

/**
 * Get a creator's availability status
 * @param creatorId - The creator's Firebase UID
 * @returns 'online' or 'busy' (defaults to 'busy' if unknown)
 */
export async function getAvailability(creatorId: string): Promise<CreatorAvailability> {
  if (!isRedisConfigured()) {
    return 'busy'; // Unknown = Busy (always safe)
  }

  try {
    const redis = getRedis();
    const v2 = await redis.get(creatorPresenceKey(creatorId));
    const canonical = parsePresenceState(v2);
    if (canonical) {
      return canonical;
    }
    if (!featureFlags.creatorPresenceLegacyFallbackReadEnabled) {
      return 'busy';
    }
    const legacy = await redis.get(availabilityKey(creatorId));
    return (legacy === 'online' ? 'online' : 'busy') as CreatorAvailability;
  } catch (err) {
    logError('creator_availability_get_failed', err, { creatorId, failSafe: 'busy' });
    return 'busy'; // Error = Busy (fail safe)
  }
}

/**
 * Refresh a creator's TTL (keep-alive)
 * Call this periodically to prevent auto-expire
 * @param creatorId - The creator's Firebase UID
 */
export async function refreshAvailability(creatorId: string): Promise<void> {
  void creatorId;
  throw new Error(
    'refreshAvailability is disabled. Presence writes must go through transitionCreatorPresence in presence.service.ts'
  );
}

/**
 * Remove a creator's availability (explicit cleanup)
 * @param creatorId - The creator's Firebase UID
 */
export async function removeAvailability(creatorId: string): Promise<void> {
  void creatorId;
  throw new Error(
    'removeAvailability is disabled. Presence writes must go through transitionCreatorPresence in presence.service.ts'
  );
}

/**
 * Get all online creators
 * 🔥 SCALABILITY FIX: Uses SCAN instead of KEYS to avoid blocking Redis
 * Note: Use sparingly (e.g., on initial page load or admin dashboard)
 */
export async function getAllOnlineCreators(): Promise<string[]> {
  if (!isRedisConfigured()) {
    return [];
  }

  try {
    const redis = getRedis();
    const onlineCreators: string[] = [];
    let cursor = '0';
    
    // 🔥 SCALABILITY: Use SCAN instead of KEYS (non-blocking, cursor-based)
    // This prevents blocking Redis during key enumeration
    do {
      const [nextCursor, keys] = await redis.scan(
        cursor,
        'MATCH',
        `${CREATOR_PRESENCE_KEY_PREFIX}*`,
        'COUNT',
        100 // Process 100 keys at a time
      );
      
      cursor = nextCursor;
      
      if (keys.length > 0) {
        // Batch get values using MGET (efficient)
        const values = await redis.mget(...keys);
        keys.forEach((key, index) => {
          const availability = parsePresenceState(values[index]);
          if (availability === 'online') {
            const creatorId = key.replace(CREATOR_PRESENCE_KEY_PREFIX, '');
            onlineCreators.push(creatorId);
          }
        });
      }
    } while (cursor !== '0');
    
    return onlineCreators;
  } catch (err) {
    logError('creator_availability_get_all_online_failed', err, { alert: true });
    return [];
  }
}

/**
 * Get availability for multiple creators (batch)
 * @param creatorIds - Array of Firebase UIDs
 * @returns Object mapping creatorId -> status
 */
export async function getBatchAvailability(
  creatorIds: string[]
): Promise<Record<string, CreatorAvailability>> {
  if (!isRedisConfigured() || creatorIds.length === 0) {
    // Return all as busy
    const result: Record<string, CreatorAvailability> = {};
    creatorIds.forEach(id => { result[id] = 'busy'; });
    return result;
  }

  try {
    const redis = getRedis();
    const result: Record<string, CreatorAvailability> = {};

    // Canonical read path is v2 presence payload.
    const v2Keys = creatorIds.map((id) => creatorPresenceKey(id));
    const v2Vals = await redis.mget(...v2Keys);
    const missingCanonicalIds: string[] = [];

    creatorIds.forEach((id, index) => {
      const parsed = parsePresenceState(v2Vals[index]);
      if (parsed) {
        result[id] = parsed;
      } else {
        missingCanonicalIds.push(id);
      }
    });

    if (missingCanonicalIds.length > 0) {
      const batchSize = creatorIds.length;
      const missingRate = batchSize > 0 ? missingCanonicalIds.length / batchSize : 0;
      logInfo('creator_availability_batch_canonical_missing', {
        count: missingCanonicalIds.length,
        batchSize,
        missingRate,
        sampleIds: missingCanonicalIds.slice(0, 5),
      });
      if (batchSize >= 5 && missingRate > 0.05) {
        logWarning('creator_availability_batch_canonical_missing_high', {
          count: missingCanonicalIds.length,
          batchSize,
          missingRate,
          threshold: 0.05,
        });
      }
      if (featureFlags.creatorPresenceLegacyFallbackReadEnabled) {
        const keys = missingCanonicalIds.map((id) => availabilityKey(id));
        const values = await redis.mget(...keys);
        logInfo('creator_availability_batch_legacy_fallback', {
          count: missingCanonicalIds.length,
          batchSize,
          missingRate,
          sampleIds: missingCanonicalIds.slice(0, 5),
        });
        missingCanonicalIds.forEach((id, index) => {
          const value = values[index];
          result[id] = (value === 'online' ? 'online' : 'busy') as CreatorAvailability;
        });
      } else {
        missingCanonicalIds.forEach((id) => {
          result[id] = 'busy';
        });
      }
    }

    creatorIds.forEach((id) => {
      if (result[id] == null) {
        result[id] = 'busy';
      }
    });

    return result;
  } catch (err) {
    logError('creator_availability_batch_get_failed', err, {
      creatorCount: creatorIds.length,
      alert: true,
      failSafe: 'all_busy',
    });
    // Return all as busy on error
    const result: Record<string, CreatorAvailability> = {};
    creatorIds.forEach(id => { result[id] = 'busy'; });
    return result;
  }
}
