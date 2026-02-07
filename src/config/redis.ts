/**
 * Redis Configuration (Upstash)
 * 
 * Serverless-safe HTTP-based Redis client.
 * 
 * Why Upstash (not ioredis)?
 * - Stateless: No persistent connections
 * - Serverless-safe: Works with Vercel, Netlify, etc.
 * - No connection management: HTTP-based REST API
 * - No reconnect spam: Each request is independent
 * 
 * Used for:
 * - Creator availability state
 * - Realtime presence flags
 * - Distributed locks
 * 
 * NOT used for:
 * - Users (MongoDB)
 * - Calls (MongoDB)
 * - Payments (MongoDB)
 * - History (MongoDB)
 */

import { Redis } from '@upstash/redis';

// Singleton Redis client
let redis: Redis | null = null;

/**
 * Get or create the Redis client
 */
export function getRedis(): Redis {
  if (redis) {
    return redis;
  }

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    console.error('❌ [REDIS] Missing UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN');
    throw new Error('Redis configuration missing. Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN environment variables.');
  }

  console.log('🔴 [REDIS] Initializing Upstash Redis client...');
  
  redis = new Redis({
    url,
    token,
  });

  console.log('✅ [REDIS] Upstash Redis client ready');
  return redis;
}

/**
 * Check if Redis is configured
 */
export function isRedisConfigured(): boolean {
  return !!(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
}
