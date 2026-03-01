import { getRedis } from '../config/redis';
import logger, { logWarning, logInfo, logError, logDebug } from './logger';
import { recordBillingMetric } from './monitoring';

/**
 * 🔥 FIX 40: Per-User Rate Limiting Service
 * 
 * Prevents users from spamming calls by tracking call attempts per user.
 * Uses Redis for distributed rate limiting across multiple server instances.
 * 
 * 🔥 CRITICAL FIX: Fail-Closed with In-Memory Fallback
 * - When Redis is unavailable, falls back to in-memory rate limiting
 * - Uses degraded limits (50% of normal limit) to provide protection
 * - Prevents DDoS attacks during Redis outages
 * 
 * Rate limits are configurable via environment variables:
 * - CALL_RATE_LIMIT_MAX: Maximum calls allowed per window (default: 10)
 * - CALL_RATE_LIMIT_WINDOW_SECONDS: Time window in seconds (default: 60)
 */

// Rate limiting configuration
const CALL_RATE_LIMIT_MAX = parseInt(process.env.CALL_RATE_LIMIT_MAX || '10', 10);
const CALL_RATE_LIMIT_WINDOW_SECONDS = parseInt(process.env.CALL_RATE_LIMIT_WINDOW_SECONDS || '60', 10);

// 🔥 FIX: In-memory fallback configuration
// Use degraded limits (50% of normal) when Redis is unavailable
const FALLBACK_RATE_LIMIT_MAX = Math.max(1, Math.floor(CALL_RATE_LIMIT_MAX * 0.5));
const FALLBACK_RATE_LIMIT_WINDOW_SECONDS = CALL_RATE_LIMIT_WINDOW_SECONDS;

// Redis key prefix for rate limiting
const RATE_LIMIT_PREFIX = 'rate_limit:call:';

/**
 * 🔥 FIX: In-memory fallback storage for rate limiting
 * Used when Redis is unavailable to provide fail-closed behavior
 * 
 * Structure: Map<firebaseUid, { count: number, expiresAt: number }>
 */
const inMemoryRateLimitStore = new Map<string, { count: number; expiresAt: number }>();

/**
 * Clean up expired entries from in-memory store (runs periodically)
 */
function cleanupInMemoryStore(): void {
  const now = Date.now();
  let cleaned = 0;
  for (const [key, value] of inMemoryRateLimitStore.entries()) {
    if (value.expiresAt <= now) {
      inMemoryRateLimitStore.delete(key);
      cleaned++;
    }
  }
  if (cleaned > 0) {
    logDebug('Cleaned up expired in-memory rate limit entries', { cleaned });
  }
}

// Run cleanup every 30 seconds
setInterval(cleanupInMemoryStore, 30000);

/**
 * Generate Redis key for user rate limiting
 */
function getRateLimitKey(firebaseUid: string): string {
  return `${RATE_LIMIT_PREFIX}${firebaseUid}`;
}

/**
 * 🔥 FIX: In-memory rate limit check (fallback when Redis is unavailable)
 * Uses degraded limits to provide protection during Redis outages
 */
function checkInMemoryRateLimit(firebaseUid: string): {
  allowed: boolean;
  remaining: number;
  resetAt: number;
  limit: number;
  windowSeconds: number;
} {
  const now = Date.now();
  const windowMs = FALLBACK_RATE_LIMIT_WINDOW_SECONDS * 1000;
  
  const entry = inMemoryRateLimitStore.get(firebaseUid);
  
  if (!entry || entry.expiresAt <= now) {
    // No entry or expired - create new entry
    const expiresAt = now + windowMs;
    inMemoryRateLimitStore.set(firebaseUid, { count: 1, expiresAt });
    
    return {
      allowed: true,
      remaining: FALLBACK_RATE_LIMIT_MAX - 1,
      resetAt: expiresAt,
      limit: FALLBACK_RATE_LIMIT_MAX,
      windowSeconds: FALLBACK_RATE_LIMIT_WINDOW_SECONDS,
    };
  }
  
  // Entry exists and is valid - increment count
  entry.count += 1;
  const allowed = entry.count <= FALLBACK_RATE_LIMIT_MAX;
  const remaining = Math.max(0, FALLBACK_RATE_LIMIT_MAX - entry.count);
  
  return {
    allowed,
    remaining,
    resetAt: entry.expiresAt,
    limit: FALLBACK_RATE_LIMIT_MAX,
    windowSeconds: FALLBACK_RATE_LIMIT_WINDOW_SECONDS,
  };
}

/**
 * Check if user has exceeded rate limit for call initiation
 * 
 * @param firebaseUid - Firebase UID of the user
 * @returns Object with `allowed: boolean` and `remaining: number` and `resetAt: number`
 */
export async function checkCallRateLimit(firebaseUid: string): Promise<{
  allowed: boolean;
  remaining: number;
  resetAt: number;
  limit: number;
  windowSeconds: number;
}> {
  const redis = getRedis();
  const key = getRateLimitKey(firebaseUid);
  const now = Date.now();
  const windowMs = CALL_RATE_LIMIT_WINDOW_SECONDS * 1000;
  
  try {
    // Use Redis INCR with expiration for atomic increment + expiration
    // If key doesn't exist, INCR creates it with value 1
    // We'll set expiration after increment if needed
    const newCount = await redis.incr(key);
    
    // If this is the first increment (count = 1), set expiration
    if (newCount === 1) {
      await redis.expire(key, CALL_RATE_LIMIT_WINDOW_SECONDS);
    }
    
    // Get TTL to calculate reset time
    const ttl = await redis.ttl(key);
    const resetAt = ttl > 0 ? now + (ttl * 1000) : now + windowMs;
    
    // Check if limit exceeded after increment
    const allowed = newCount <= CALL_RATE_LIMIT_MAX;
    const remaining = Math.max(0, CALL_RATE_LIMIT_MAX - newCount);
    
    return {
      allowed,
      remaining,
      resetAt,
      limit: CALL_RATE_LIMIT_MAX,
      windowSeconds: CALL_RATE_LIMIT_WINDOW_SECONDS,
    };
  } catch (error) {
    // 🔥 CRITICAL FIX: Fail-Closed with In-Memory Fallback
    // When Redis is unavailable, use in-memory rate limiting with degraded limits
    // This prevents DDoS attacks during Redis outages while still providing protection
    
    const errorMessage = error instanceof Error ? error.message : String(error);
    logWarning('Rate limit check failed (Redis unavailable), using in-memory fallback', { 
      firebaseUid, 
      error: errorMessage,
      fallbackLimit: FALLBACK_RATE_LIMIT_MAX,
    });
    
    // Record metric for monitoring
    recordBillingMetric('rate_limit_redis_fallback', 1, { firebaseUid });
    
    // Use in-memory fallback with degraded limits
    const fallbackResult = checkInMemoryRateLimit(firebaseUid);
    
    // Log if rate limit would be exceeded in fallback mode
    if (!fallbackResult.allowed) {
      logWarning('Rate limit exceeded in fallback mode (Redis unavailable)', {
        firebaseUid,
        count: fallbackResult.limit - fallbackResult.remaining,
        limit: fallbackResult.limit,
      });
      recordBillingMetric('rate_limit_exceeded_fallback', 1, { firebaseUid });
    }
    
    return fallbackResult;
  }
}

/**
 * Reset rate limit for a user (useful for testing or manual overrides)
 */
export async function resetCallRateLimit(firebaseUid: string): Promise<void> {
  const redis = getRedis();
  const key = getRateLimitKey(firebaseUid);
  try {
    await redis.del(key);
    logInfo('Rate limit reset for user', { firebaseUid });
  } catch (error) {
    logWarning('Failed to reset rate limit', { firebaseUid, error });
  }
}

/**
 * Get current rate limit status for a user (without incrementing)
 */
export async function getCallRateLimitStatus(firebaseUid: string): Promise<{
  count: number;
  remaining: number;
  resetAt: number;
  limit: number;
  windowSeconds: number;
}> {
  const redis = getRedis();
  const key = getRateLimitKey(firebaseUid);
  const now = Date.now();
  const windowMs = CALL_RATE_LIMIT_WINDOW_SECONDS * 1000;
  
  try {
    const count = (await redis.get<number>(key)) || 0;
    const ttl = await redis.ttl(key);
    const resetAt = ttl > 0 ? now + (ttl * 1000) : now + windowMs;
    
    return {
      count,
      remaining: Math.max(0, CALL_RATE_LIMIT_MAX - count),
      resetAt,
      limit: CALL_RATE_LIMIT_MAX,
      windowSeconds: CALL_RATE_LIMIT_WINDOW_SECONDS,
    };
  } catch (error) {
    logWarning('Failed to get rate limit status', { firebaseUid, error });
    return {
      count: 0,
      remaining: CALL_RATE_LIMIT_MAX,
      resetAt: now + windowMs,
      limit: CALL_RATE_LIMIT_MAX,
      windowSeconds: CALL_RATE_LIMIT_WINDOW_SECONDS,
    };
  }
}

/**
 * Log rate limit configuration on startup
 */
export function logRateLimitConfig(): void {
  logger.info('📊 [RATE LIMIT] Call rate limiting configured', {
    maxCalls: CALL_RATE_LIMIT_MAX,
    windowSeconds: CALL_RATE_LIMIT_WINDOW_SECONDS,
    envVars: {
      CALL_RATE_LIMIT_MAX: process.env.CALL_RATE_LIMIT_MAX || 'default (10)',
      CALL_RATE_LIMIT_WINDOW_SECONDS: process.env.CALL_RATE_LIMIT_WINDOW_SECONDS || 'default (60)',
    },
  });
}
