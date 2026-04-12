/**
 * Process-local counters for infrastructure driver events (Mongo, Redis).
 * No dependency on redis.ts or database.ts — safe to import from those modules.
 */

let redisErrorCount = 0;
let redisCloseCount = 0;
let mongoConnectionErrorCount = 0;

export function bumpRedisError(): void {
  redisErrorCount += 1;
}

export function bumpRedisClose(): void {
  redisCloseCount += 1;
}

export function bumpMongoConnectionError(): void {
  mongoConnectionErrorCount += 1;
}

export function getDriverMetrics(): {
  redis: { errors: number; closes: number };
  mongo: { connectionErrors: number };
} {
  return {
    redis: { errors: redisErrorCount, closes: redisCloseCount },
    mongo: { connectionErrors: mongoConnectionErrorCount },
  };
}
