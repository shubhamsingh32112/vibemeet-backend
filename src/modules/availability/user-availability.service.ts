/**
 * User Availability Service
 * 
 * BACKEND-AUTHORITATIVE availability system using Railway Redis.
 * 
 * 🔥 AUTOMATIC STATUS: Status is automatically managed by socket connection
 * - When user opens app → socket connects → automatically online
 * - When user closes app → socket disconnects → automatically offline
 * - No manual toggle - status is automatic based on app lifecycle
 * 
 * Status semantics:
 * - 'online' = user is online and active
 * - 'offline' = user is offline or inactive
 * 
 * Rule: Missing/unknown users are ALWAYS 'offline'
 * 
 * Redis key design:
 *   user:availability:{firebaseUid} → "online" | "offline"
 * 
 * 🔥 SCALABILITY OPTIMIZATION (1000 users/day, 200 creators):
 * - TTL: 120 seconds (auto-expire safety)
 * - Heartbeat: 60 seconds (refreshes TTL while connected)
 * - Batch operations: Uses MGET for efficient batch queries
 * - Socket.IO broadcasting: Instant updates to all connected clients
 * - Prevents ghost online users
 * - Handles crashes cleanly
 * - Forces users to re-announce presence
 */

import { getRedis, isRedisConfigured } from '../../config/redis';

export type UserAvailability = 'online' | 'offline';

// Redis key prefix
const KEY_PREFIX = 'user:availability:';

// TTL in seconds (2 minutes)
// Users must re-announce presence within this window
const AVAILABILITY_TTL = 120;

/**
 * Set a user's availability status
 * @param firebaseUid - The user's Firebase UID
 * @param status - 'online' or 'offline'
 */
export async function setUserAvailability(
  firebaseUid: string,
  status: UserAvailability
): Promise<void> {
  if (!isRedisConfigured()) {
    console.error('❌ [USER AVAILABILITY] Redis not configured');
    return;
  }

  try {
    const redis = getRedis();
    await redis.setex(`${KEY_PREFIX}${firebaseUid}`, AVAILABILITY_TTL, status);
    console.log(`📡 [USER AVAILABILITY] Set: ${firebaseUid} → ${status} (TTL: ${AVAILABILITY_TTL}s)`);
  } catch (err) {
    console.error(`❌ [USER AVAILABILITY] Failed to set status:`, err);
  }
}

/**
 * Get a user's availability status
 * @param firebaseUid - The user's Firebase UID
 * @returns 'online' or 'offline' (defaults to 'offline' if unknown)
 */
export async function getUserAvailability(firebaseUid: string): Promise<UserAvailability> {
  if (!isRedisConfigured()) {
    return 'offline'; // Unknown = Offline (always safe)
  }

  try {
    const redis = getRedis();
    const status = await redis.get(`${KEY_PREFIX}${firebaseUid}`);
    return (status === 'online' ? 'online' : 'offline') as UserAvailability;
  } catch (err) {
    console.error(`❌ [USER AVAILABILITY] Failed to get status:`, err);
    return 'offline'; // Error = Offline (fail safe)
  }
}

/**
 * Refresh a user's TTL (keep-alive)
 * Call this periodically to prevent auto-expire
 * @param firebaseUid - The user's Firebase UID
 */
export async function refreshUserAvailability(firebaseUid: string): Promise<void> {
  if (!isRedisConfigured()) {
    return;
  }

  try {
    const redis = getRedis();
    const status = await redis.get(`${KEY_PREFIX}${firebaseUid}`);
    
    if (status === 'online') {
      // Re-set with fresh TTL
      await redis.setex(`${KEY_PREFIX}${firebaseUid}`, AVAILABILITY_TTL, 'online');
      console.log(`🔄 [USER AVAILABILITY] Refreshed TTL: ${firebaseUid}`);
    }
  } catch (err) {
    console.error(`❌ [USER AVAILABILITY] Failed to refresh:`, err);
  }
}

/**
 * Remove a user's availability (explicit cleanup)
 * @param firebaseUid - The user's Firebase UID
 */
export async function removeUserAvailability(firebaseUid: string): Promise<void> {
  if (!isRedisConfigured()) {
    return;
  }

  try {
    const redis = getRedis();
    await redis.del(`${KEY_PREFIX}${firebaseUid}`);
    console.log(`🗑️  [USER AVAILABILITY] Removed: ${firebaseUid}`);
  } catch (err) {
    console.error(`❌ [USER AVAILABILITY] Failed to remove:`, err);
  }
}

/**
 * Get availability for multiple users (batch)
 * @param firebaseUids - Array of Firebase UIDs
 * @returns Object mapping firebaseUid -> status
 */
export async function getBatchUserAvailability(
  firebaseUids: string[]
): Promise<Record<string, UserAvailability>> {
  if (!isRedisConfigured() || firebaseUids.length === 0) {
    // Return all as offline
    const result: Record<string, UserAvailability> = {};
    firebaseUids.forEach(id => { result[id] = 'offline'; });
    return result;
  }

  try {
    const redis = getRedis();
    const result: Record<string, UserAvailability> = {};
    
    // Railway Redis supports mget
    const keys = firebaseUids.map(id => `${KEY_PREFIX}${id}`);
    const values = await redis.mget(...keys);
    
    firebaseUids.forEach((id, index) => {
      const value = values[index];
      result[id] = (value === 'online' ? 'online' : 'offline') as UserAvailability;
    });
    
    return result;
  } catch (err) {
    console.error(`❌ [USER AVAILABILITY] Failed to get batch:`, err);
    // Return all as offline on error
    const result: Record<string, UserAvailability> = {};
    firebaseUids.forEach(id => { result[id] = 'offline'; });
    return result;
  }
}

/**
 * Get all online users
 * 🔥 SCALABILITY FIX: Uses SCAN instead of KEYS to avoid blocking Redis
 * Note: Use sparingly (e.g., on initial page load or admin dashboard)
 */
export async function getAllOnlineUsers(): Promise<string[]> {
  if (!isRedisConfigured()) {
    return [];
  }

  try {
    const redis = getRedis();
    const onlineUsers: string[] = [];
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
            const firebaseUid = key.replace(KEY_PREFIX, '');
            onlineUsers.push(firebaseUid);
          }
        });
      }
    } while (cursor !== '0');
    
    return onlineUsers;
  } catch (err) {
    console.error(`❌ [USER AVAILABILITY] Failed to get all online:`, err);
    return [];
  }
}
