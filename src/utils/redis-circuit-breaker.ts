/**
 * 🔥 FIX: Redis Circuit Breaker
 * 
 * Wraps Redis operations with circuit breaker pattern to handle failures gracefully.
 * Prevents cascading failures when Redis is unavailable.
 * 
 * Features:
 * - Circuit breaker with configurable thresholds
 * - Fallback to in-memory state (with warnings)
 * - Health checks and alerts
 * - Graceful degradation mode
 */

import { getRedis } from '../config/redis';
import { logWarning, logInfo } from './logger';
import { recordBillingMetric } from './monitoring';
import { CircuitBreaker } from './circuit-breaker';

// In-memory fallback storage (used when Redis is down)
const inMemoryFallback = new Map<string, { value: any; expiresAt: number }>();

// Circuit breaker for Redis operations
const redisCircuitBreaker = new CircuitBreaker({
  failureThreshold: 5, // Open circuit after 5 failures
  resetTimeout: 30000, // Try to reset after 30 seconds
  monitoringWindow: 60000, // 1 minute window
});

/**
 * Check if Redis is available
 */
async function isRedisAvailable(): Promise<boolean> {
  try {
    const redis = getRedis();
    await redis.ping();
    return true;
  } catch (error) {
    return false;
  }
}

/**
 * Execute Redis operation with circuit breaker protection
 */
async function executeWithCircuitBreaker<T>(
  operation: () => Promise<T>,
  fallback?: () => Promise<T>
): Promise<T> {
  try {
    return await redisCircuitBreaker.execute(operation);
  } catch (error) {
    const circuitState = redisCircuitBreaker.getState();
    
    // Log circuit breaker state
    if (circuitState.state === 'open') {
      logWarning('Redis circuit breaker is OPEN', {
        failures: circuitState.failures,
        nextAttempt: new Date(circuitState.nextAttempt).toISOString(),
      });
      recordBillingMetric('redis_circuit_open', 1, {});
    }
    
    // Try fallback if provided
    if (fallback) {
      logWarning('Using fallback for Redis operation', { error: error instanceof Error ? error.message : String(error) });
      return await fallback();
    }
    
    throw error;
  }
}

/**
 * Safe Redis GET with circuit breaker and fallback
 */
export async function safeRedisGet<T = any>(key: string): Promise<T | null> {
  return executeWithCircuitBreaker(
    async () => {
      const redis = getRedis();
      const value = await redis.get(key);
      if (value === null) return null;
      // Try to parse as JSON, fallback to string
      try {
        return JSON.parse(value) as T;
      } catch {
        return value as T;
      }
    },
    async () => {
      // Fallback to in-memory storage
      const fallback = inMemoryFallback.get(key);
      if (fallback && fallback.expiresAt > Date.now()) {
        logWarning('Using in-memory fallback for Redis GET', { key });
        return fallback.value as T;
      }
      return null;
    }
  );
}

/**
 * Safe Redis SET with circuit breaker and fallback
 */
export async function safeRedisSet(
  key: string,
  value: any,
  options?: { ex?: number }
): Promise<boolean> {
  return executeWithCircuitBreaker(
    async () => {
      const redis = getRedis();
      if (options?.ex) {
        await redis.setex(key, options.ex, value);
      } else {
        await redis.set(key, value);
      }
      return true;
    },
    async () => {
      // Fallback to in-memory storage
      const expiresAt = options?.ex 
        ? Date.now() + (options.ex * 1000)
        : Date.now() + (24 * 60 * 60 * 1000); // Default 24 hours
      
      inMemoryFallback.set(key, { value, expiresAt });
      logWarning('Using in-memory fallback for Redis SET', { 
        key,
        expiresAt: new Date(expiresAt).toISOString(),
      });
      recordBillingMetric('redis_fallback_used', 1, { operation: 'set' });
      return true;
    }
  );
}

/**
 * Safe Redis DEL with circuit breaker
 */
export async function safeRedisDel(key: string): Promise<number> {
  return executeWithCircuitBreaker(
    async () => {
      const redis = getRedis();
      return await redis.del(key);
    },
    async () => {
      // Fallback: remove from in-memory storage
      inMemoryFallback.delete(key);
      logWarning('Using in-memory fallback for Redis DEL', { key });
      return 1;
    }
  );
}

/**
 * Safe Redis ZADD with circuit breaker
 */
export async function safeRedisZadd(
  key: string,
  items: { score: number; member: string } | { score: number; member: string }[]
): Promise<number> {
  return executeWithCircuitBreaker(
    async () => {
      const redis = getRedis();
      const scoreMembers = Array.isArray(items) ? items : [items];
      // Convert to ioredis format: zadd(key, score1, member1, score2, member2, ...)
      const args: (number | string)[] = [];
      for (const item of scoreMembers) {
        args.push(item.score, item.member);
      }
      // Use apply to spread the args array
      const result = await (redis.zadd as any)(key, ...args);
      return result ?? 0;
    },
    async () => {
      // Fallback: log warning but don't store (sorted sets are complex)
      logWarning('Redis ZADD failed - operation skipped', { key });
      recordBillingMetric('redis_fallback_used', 1, { operation: 'zadd' });
      return 0;
    }
  );
}

/**
 * Safe Redis ZREM with circuit breaker
 */
export async function safeRedisZrem(key: string, member: string | string[]): Promise<number> {
  return executeWithCircuitBreaker(
    async () => {
      const redis = getRedis();
      // ioredis zrem accepts either individual members or an array
      if (Array.isArray(member)) {
        return await redis.zrem(key, ...member);
      } else {
        return await redis.zrem(key, member);
      }
    },
    async () => {
      // Fallback: log warning
      logWarning('Redis ZREM failed - operation skipped', { key });
      return 0;
    }
  );
}

/**
 * Safe Redis ZSCORE with circuit breaker
 */
export async function safeRedisZscore(key: string, member: string): Promise<number | null> {
  return executeWithCircuitBreaker(
    async () => {
      const redis = getRedis();
      const result = await redis.zscore(key, member);
      // ioredis returns string | null, convert to number | null
      if (result === null) return null;
      return parseFloat(result);
    },
    async () => {
      // Fallback: return null (member not found)
      logWarning('Redis ZSCORE failed - returning null', { key, member });
      return null;
    }
  );
}

/**
 * Safe Redis ZRANGE with circuit breaker
 */
export async function safeRedisZrange(
  key: string,
  min: number | string,
  max: number | string,
  options?: { byScore?: boolean; limit?: { offset: number; count: number } }
): Promise<string[]> {
  return executeWithCircuitBreaker(
    async () => {
      const redis = getRedis();
      // Cast to any to avoid tight coupling to specific Redis client ZRANGE overloads,
      // while still preserving runtime behavior.
      return await (redis as any).zrange(key, min, max, options);
    },
    async () => {
      // Fallback: return empty array
      logWarning('Redis ZRANGE failed - returning empty array', { key });
      return [];
    }
  );
}

/**
 * Safe Redis SMEMBERS with circuit breaker
 */
export async function safeRedisSmembers(key: string): Promise<string[]> {
  return executeWithCircuitBreaker(
    async () => {
      const redis = getRedis();
      return await redis.smembers(key);
    },
    async () => {
      // Fallback: return empty array
      logWarning('Redis SMEMBERS failed - returning empty array', { key });
      return [];
    }
  );
}

/**
 * Safe Redis SADD with circuit breaker
 */
export async function safeRedisSadd(key: string, member: string | string[]): Promise<number> {
  return executeWithCircuitBreaker(
    async () => {
      const redis = getRedis();
      // ioredis sadd accepts either individual members or an array
      if (Array.isArray(member)) {
        return await redis.sadd(key, ...member);
      } else {
        return await redis.sadd(key, member);
      }
    },
    async () => {
      // Fallback: log warning
      logWarning('Redis SADD failed - operation skipped', { key });
      return 0;
    }
  );
}

/**
 * Safe Redis SREM with circuit breaker
 */
export async function safeRedisSrem(key: string, member: string | string[]): Promise<number> {
  return executeWithCircuitBreaker(
    async () => {
      const redis = getRedis();
      // ioredis srem accepts either individual members or an array
      if (Array.isArray(member)) {
        return await redis.srem(key, ...member);
      } else {
        return await redis.srem(key, member);
      }
    },
    async () => {
      // Fallback: log warning
      logWarning('Redis SREM failed - operation skipped', { key });
      return 0;
    }
  );
}

/**
 * Safe Redis INCR with circuit breaker
 */
export async function safeRedisIncr(key: string): Promise<number> {
  return executeWithCircuitBreaker(
    async () => {
      const redis = getRedis();
      return await redis.incr(key);
    },
    async () => {
      // Fallback: return 1 (assume first increment)
      logWarning('Redis INCR failed - returning fallback value', { key });
      return 1;
    }
  );
}

/**
 * Safe Redis EXPIRE with circuit breaker
 */
export async function safeRedisExpire(key: string, seconds: number): Promise<boolean> {
  return executeWithCircuitBreaker(
    async () => {
      const redis = getRedis();
      const result = await redis.expire(key, seconds);
      // Redis returns 1 (true) or 0 (false); normalize to boolean
      return result === 1;
    },
    async () => {
      // Fallback: update in-memory expiration
      const fallback = inMemoryFallback.get(key);
      if (fallback) {
        fallback.expiresAt = Date.now() + (seconds * 1000);
      }
      logWarning('Redis EXPIRE failed - using in-memory fallback', { key });
      return true;
    }
  );
}

/**
 * Get Redis circuit breaker state
 */
export function getRedisCircuitBreakerState(): {
  failures: number;
  lastFailureTime: number;
  state: 'closed' | 'open' | 'half-open';
  nextAttempt: number;
} {
  return redisCircuitBreaker.getState();
}

/**
 * Check Redis health
 */
export async function checkRedisHealth(): Promise<{
  available: boolean;
  circuitState: 'closed' | 'open' | 'half-open';
  failures: number;
}> {
  const available = await isRedisAvailable();
  const circuitState = redisCircuitBreaker.getState();
  
  return {
    available,
    circuitState: circuitState.state,
    failures: circuitState.failures,
  };
}

/**
 * Clean up expired in-memory fallback entries
 */
export function cleanupInMemoryFallback(): void {
  const now = Date.now();
  let cleaned = 0;
  
  for (const [key, value] of inMemoryFallback.entries()) {
    if (value.expiresAt <= now) {
      inMemoryFallback.delete(key);
      cleaned++;
    }
  }
  
  if (cleaned > 0) {
    logInfo('Cleaned up expired in-memory fallback entries', { cleaned });
  }
}

// Clean up expired entries every 5 minutes
setInterval(cleanupInMemoryFallback, 5 * 60 * 1000);
