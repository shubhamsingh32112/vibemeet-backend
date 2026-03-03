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
    await redis.setex(`${KEY_PREFIX}${creatorId}`, AVAILABILITY_TTL, status);
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
    const status = await redis.get(`${KEY_PREFIX}${creatorId}`);
    return (status === 'online' ? 'online' : 'busy') as CreatorAvailability;
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
    const status = await redis.get(`${KEY_PREFIX}${creatorId}`);
    
    if (status === 'online') {
      // Re-set with fresh TTL
      await redis.setex(`${KEY_PREFIX}${creatorId}`, AVAILABILITY_TTL, 'online');
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
        `${KEY_PREFIX}*`,
        'COUNT',
        100 // Process 100 keys at a time
      );
      
      cursor = nextCursor;
      
      if (keys.length > 0) {
        // Batch get values using MGET (efficient)
        const values = await redis.mget(...keys);
        keys.forEach((key, index) => {
          if (values[index] === 'online') {
            const creatorId = key.replace(KEY_PREFIX, '');
            onlineCreators.push(creatorId);
          }
        });
      }
    } while (cursor !== '0');
    
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
    
    // Railway Redis supports mget
    const keys = creatorIds.map(id => `${KEY_PREFIX}${id}`);
    const values = await redis.mget(...keys);
    
    creatorIds.forEach((id, index) => {
      const value = values[index];
      result[id] = (value === 'online' ? 'online' : 'busy') as CreatorAvailability;
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
