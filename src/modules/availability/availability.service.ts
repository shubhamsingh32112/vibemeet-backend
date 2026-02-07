/**
 * Creator Availability Service
 * 
 * BACKEND-AUTHORITATIVE availability system using Upstash Redis.
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
 * TTL: 120 seconds (auto-expire safety)
 * - Prevents ghost online users
 * - Handles crashes cleanly
 * - Forces creators to re-announce presence
 */

import { getRedis, isRedisConfigured } from '../../config/redis';

export type CreatorAvailability = 'online' | 'busy';

// Redis key prefix
const KEY_PREFIX = 'creator:availability:';

// TTL in seconds (2 minutes)
// Creators must re-announce presence within this window
const AVAILABILITY_TTL = 120;

/**
 * Set a creator's availability status
 * @param creatorId - The creator's Firebase UID
 * @param status - 'online' or 'busy'
 */
export async function setAvailability(
  creatorId: string,
  status: CreatorAvailability
): Promise<void> {
  if (!isRedisConfigured()) {
    console.error('❌ [AVAILABILITY] Redis not configured');
    return;
  }

  try {
    const redis = getRedis();
    await redis.set(`${KEY_PREFIX}${creatorId}`, status, { ex: AVAILABILITY_TTL });
    console.log(`📡 [AVAILABILITY] Set: ${creatorId} → ${status} (TTL: ${AVAILABILITY_TTL}s)`);
  } catch (err) {
    console.error(`❌ [AVAILABILITY] Failed to set status:`, err);
  }
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
    const status = await redis.get<CreatorAvailability>(`${KEY_PREFIX}${creatorId}`);
    return status ?? 'busy'; // Unknown = Busy
  } catch (err) {
    console.error(`❌ [AVAILABILITY] Failed to get status:`, err);
    return 'busy'; // Error = Busy (fail safe)
  }
}

/**
 * Refresh a creator's TTL (keep-alive)
 * Call this periodically to prevent auto-expire
 * @param creatorId - The creator's Firebase UID
 */
export async function refreshAvailability(creatorId: string): Promise<void> {
  if (!isRedisConfigured()) {
    return;
  }

  try {
    const redis = getRedis();
    const status = await redis.get<CreatorAvailability>(`${KEY_PREFIX}${creatorId}`);
    
    if (status === 'online') {
      // Re-set with fresh TTL
      await redis.set(`${KEY_PREFIX}${creatorId}`, 'online', { ex: AVAILABILITY_TTL });
      console.log(`🔄 [AVAILABILITY] Refreshed TTL: ${creatorId}`);
    }
  } catch (err) {
    console.error(`❌ [AVAILABILITY] Failed to refresh:`, err);
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
    await redis.del(`${KEY_PREFIX}${creatorId}`);
    console.log(`🗑️  [AVAILABILITY] Removed: ${creatorId}`);
  } catch (err) {
    console.error(`❌ [AVAILABILITY] Failed to remove:`, err);
  }
}

/**
 * Get all online creators
 * Note: This scans keys - use sparingly (e.g., on initial page load)
 */
export async function getAllOnlineCreators(): Promise<string[]> {
  if (!isRedisConfigured()) {
    return [];
  }

  try {
    const redis = getRedis();
    
    // Scan for all creator:availability:* keys
    const keys = await redis.keys(`${KEY_PREFIX}*`);
    
    if (keys.length === 0) {
      return [];
    }

    // Get all values
    const onlineCreators: string[] = [];
    
    for (const key of keys) {
      const status = await redis.get<CreatorAvailability>(key);
      if (status === 'online') {
        const creatorId = key.replace(KEY_PREFIX, '');
        onlineCreators.push(creatorId);
      }
    }

    return onlineCreators;
  } catch (err) {
    console.error(`❌ [AVAILABILITY] Failed to get all online:`, err);
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
    
    // Upstash supports mget
    const keys = creatorIds.map(id => `${KEY_PREFIX}${id}`);
    const values = await redis.mget<CreatorAvailability[]>(...keys);
    
    creatorIds.forEach((id, index) => {
      result[id] = values[index] ?? 'busy';
    });
    
    return result;
  } catch (err) {
    console.error(`❌ [AVAILABILITY] Failed to get batch:`, err);
    // Return all as busy on error
    const result: Record<string, CreatorAvailability> = {};
    creatorIds.forEach(id => { result[id] = 'busy'; });
    return result;
  }
}
