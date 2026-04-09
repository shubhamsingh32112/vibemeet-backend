import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import RedisStore from 'rate-limit-redis';
import type { RedisReply } from 'rate-limit-redis';
import { getReferralPreview } from './referral.controller';
import { getRedis } from '../../config/redis';
import { logInfo, logWarning } from '../../utils/logger';

const router = Router();

const REFERRAL_PREVIEW_WINDOW_MS = 15 * 60 * 1000;
const REFERRAL_PREVIEW_MAX = 60;

function memoryReferralPreviewLimiter() {
  return rateLimit({
    windowMs: REFERRAL_PREVIEW_WINDOW_MS,
    max: REFERRAL_PREVIEW_MAX,
    standardHeaders: true,
    legacyHeaders: false,
  });
}

/**
 * Distributed limiter when Redis is configured; falls back to in-memory per process.
 * Set REFERRAL_PREVIEW_REDIS=0 to force memory store (e.g. local dev without Redis).
 */
function createReferralPreviewLimiter() {
  if (process.env.REFERRAL_PREVIEW_REDIS === '0') {
    logInfo('Referral preview rate limit: memory store (REFERRAL_PREVIEW_REDIS=0)');
    return memoryReferralPreviewLimiter();
  }

  const hasRedisEnv = Boolean(
    process.env.REDIS_URL || process.env.REDIS_PUBLIC_URL || process.env.REDISHOST
  );
  if (!hasRedisEnv) {
    logInfo('Referral preview rate limit: memory store (no Redis env)');
    return memoryReferralPreviewLimiter();
  }

  try {
    const client = getRedis();
    return rateLimit({
      windowMs: REFERRAL_PREVIEW_WINDOW_MS,
      max: REFERRAL_PREVIEW_MAX,
      standardHeaders: true,
      legacyHeaders: false,
      store: new RedisStore({
        sendCommand: (...args: string[]): Promise<RedisReply> => {
          const [cmd, ...rest] = args;
          return client.call(cmd, ...rest) as Promise<RedisReply>;
        },
        prefix: 'rl:referral-preview:',
      }),
    });
  } catch (err) {
    logWarning('Referral preview rate limit: memory store (Redis init failed)', {
      error: err instanceof Error ? err.message : String(err),
    });
    return memoryReferralPreviewLimiter();
  }
}

const referralPreviewLimiter = createReferralPreviewLimiter();

router.get('/preview', referralPreviewLimiter, getReferralPreview);

export default router;
