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
 * - Base state (`creator:availability:*`): 'online' | 'offline'
 * - Effective API state: 'online' | 'on_call' | 'offline'
 *
 * Rule: Missing/unknown creators are ALWAYS 'offline'
 * 
 * Redis key design:
 *   creator:availability:{creatorId} → "online" | "offline"
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
  availabilityKey,
  AVAILABILITY_KEY_PREFIX,
  activeCallByUserKey,
} from '../../config/redis';
import { logError } from '../../utils/logger';
import { getBatchCreatorPresence, readCreatorPresenceState } from './presence.service';

export type CreatorAvailability = 'online' | 'on_call' | 'offline';
type CreatorBaseAvailability = 'online' | 'offline';

const CREATOR_BASE_TTL_SECONDS = 120;

function parsePresenceState(raw: string | null): CreatorAvailability | null {
  if (raw === 'online') return 'online';
  if (raw === 'on_call') return 'on_call';
  return 'offline';
}

/**
 * Set a creator's availability status
 * @param creatorId - The creator's Firebase UID
 * @param status - 'online' or 'offline'
 */
export async function setAvailability(
  creatorId: string,
  status: CreatorAvailability
): Promise<void> {
  await setCreatorBaseAvailability(creatorId, status === 'online' ? 'online' : 'offline');
}

export async function setCreatorBaseAvailability(
  creatorId: string,
  status: CreatorBaseAvailability
): Promise<void> {
  if (!isRedisConfigured()) {
    return;
  }
  try {
    const redis = getRedis();
    await redis.setex(availabilityKey(creatorId), CREATOR_BASE_TTL_SECONDS, status);
  } catch (err) {
    logError('creator_base_availability_set_failed', err, { creatorId, status });
  }
}

/**
 * Get a creator's availability status
 * @param creatorId - The creator's Firebase UID
 * @returns 'online' | 'on_call' | 'offline' (defaults to 'offline' if unknown)
 */
export async function getAvailability(creatorId: string): Promise<CreatorAvailability> {
  if (!isRedisConfigured()) {
    return 'offline'; // Unknown = offline
  }

  try {
    const record = await readCreatorPresenceState(creatorId);
    return record.state;
  } catch (err) {
    logError('creator_availability_get_failed', err, { creatorId, failSafe: 'offline' });
    return 'offline'; // Error = offline (fail safe)
  }
}

/**
 * Refresh a creator's TTL (keep-alive)
 * Call this periodically to prevent auto-expire
 * @param creatorId - The creator's Firebase UID
 */
export async function refreshAvailability(creatorId: string): Promise<void> {
  await refreshCreatorBaseAvailability(creatorId);
}

export async function refreshCreatorBaseAvailability(creatorId: string): Promise<void> {
  if (!isRedisConfigured()) {
    return;
  }
  try {
    const redis = getRedis();
    const current = await redis.get(availabilityKey(creatorId));
    if (current === 'online') {
      await redis.setex(availabilityKey(creatorId), CREATOR_BASE_TTL_SECONDS, 'online');
    }
  } catch (err) {
    logError('creator_base_availability_refresh_failed', err, { creatorId });
  }
}

/**
 * Remove a creator's availability (explicit cleanup)
 * @param creatorId - The creator's Firebase UID
 */
export async function removeAvailability(creatorId: string): Promise<void> {
  if (!isRedisConfigured()) {
    return;
  }
  try {
    const redis = getRedis();
    await redis.del(availabilityKey(creatorId));
  } catch (err) {
    logError('creator_base_availability_remove_failed', err, { creatorId });
  }
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
        `${AVAILABILITY_KEY_PREFIX}*`,
        'COUNT',
        100 // Process 100 keys at a time
      );
      
      cursor = nextCursor;
      
      if (keys.length > 0) {
        // Batch get values using MGET (efficient)
        const values = await redis.mget(...keys);
        const candidateCreatorIds: string[] = [];
        keys.forEach((key, index) => {
          const availability = parsePresenceState(values[index]);
          if (availability === 'online') {
            candidateCreatorIds.push(key.replace(AVAILABILITY_KEY_PREFIX, ''));
          }
        });
        if (candidateCreatorIds.length > 0) {
          const activeVals = await redis.mget(
            ...candidateCreatorIds.map((creatorId) => activeCallByUserKey(creatorId))
          );
          candidateCreatorIds.forEach((creatorId, index) => {
            if (!activeVals[index]) {
              onlineCreators.push(creatorId);
            }
          });
        }
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
    // Return all as offline
    const result: Record<string, CreatorAvailability> = {};
    creatorIds.forEach(id => { result[id] = 'offline'; });
    return result;
  }

  try {
    const result: Record<string, CreatorAvailability> = {};
    const presence = await getBatchCreatorPresence(creatorIds);
    creatorIds.forEach((id) => {
      const record = presence[id];
      result[id] = record?.state ?? 'offline';
    });

    creatorIds.forEach((id) => {
      if (result[id] == null) {
        result[id] = 'offline';
      }
    });

    return result;
  } catch (err) {
    logError('creator_availability_batch_get_failed', err, {
      creatorCount: creatorIds.length,
      alert: true,
      failSafe: 'all_offline',
    });
    // Return all as offline on error
    const result: Record<string, CreatorAvailability> = {};
    creatorIds.forEach(id => { result[id] = 'offline'; });
    return result;
  }
}
