import rateLimit from 'express-rate-limit';
import type { Request } from 'express';
import RedisStore from 'rate-limit-redis';
import type { RedisReply } from 'rate-limit-redis';
import { getRedis } from '../config/redis';
import { logWarning } from '../utils/logger';
function createLimiter(
  config: Parameters<typeof rateLimit>[0],
  prefix: string
) {
  const hasRedisEnv = Boolean(
    process.env.REDIS_URL || process.env.REDIS_PUBLIC_URL || process.env.REDISHOST
  );
  if (process.env.RATE_LIMIT_REDIS === '0' || !hasRedisEnv) {
    return rateLimit(config);
  }
  try {
    const client = getRedis();
    return rateLimit({
      ...config,
      store: new RedisStore({
        sendCommand: (...args: string[]): Promise<RedisReply> => {
          const [cmd, ...rest] = args;
          return client.call(cmd, ...rest) as Promise<RedisReply>;
        },
        prefix,
      }),
    });
  } catch (err) {
    logWarning('Rate limiter Redis store unavailable; falling back to memory', {
      prefix,
      error: err instanceof Error ? err.message : String(err),
    });
    return rateLimit(config);
  }
}


/**
 * 🔥 FIX 11: Rate Limiting for Video Calling Endpoints
 * 
 * Prevents abuse and DDoS attacks on critical endpoints.
 * Different limits for different endpoints based on usage patterns.
 */

/**
 * Rate limiter for call initiation
 * - 10 calls per minute per user (prevents spam)
 * - Uses Firebase UID from auth token as key
 */
export const callInitiateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10, // 10 calls per minute
  message: 'Too many call attempts. Please wait a moment before trying again.',
  standardHeaders: true,
  legacyHeaders: false,
  // Use Firebase UID as key if available
  keyGenerator: (req: Request): string => {
    const firebaseUid = (req as any).auth?.firebaseUid || req.ip;
    return `call_initiate:${firebaseUid}`;
  },
  skip: (_req: Request): boolean => {
    // Skip rate limiting in development if needed
    return process.env.NODE_ENV === 'development' && process.env.DISABLE_RATE_LIMIT === 'true';
  },
});

/**
 * Rate limiter for call acceptance
 * - 20 accepts per minute per user (creators may accept multiple calls)
 */
export const callAcceptLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 20, // 20 accepts per minute
  message: 'Too many call acceptances. Please wait a moment.',
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request): string => {
    const firebaseUid = (req as any).auth?.firebaseUid || req.ip;
    return `call_accept:${firebaseUid}`;
  },
});

/**
 * Rate limiter for webhook endpoint
 * - 100 requests per minute per IP (Stream may send multiple webhooks)
 * - Higher limit because Stream controls the rate
 */
export const webhookLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100, // 100 webhooks per minute per IP
  message: 'Too many webhook requests from this IP.',
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request): string => {
    // Use IP address for webhooks (no auth token)
    return `webhook:${req.ip}`;
  },
});

/**
 * Rate limiter for billing endpoints
 * - 30 requests per minute per user (fallback endpoints)
 */
export const billingLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30, // 30 billing events per minute
  message: 'Too many billing requests. Please wait a moment.',
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request): string => {
    const firebaseUid = (req as any).auth?.firebaseUid || req.ip;
    return `billing:${firebaseUid}`;
  },
});

/**
 * Rate limiter for withdrawal endpoints
 * - 5 requests per hour per user (prevents spam/abuse)
 * - Allows legitimate retries while preventing abuse
 * - Uses Firebase UID as key for per-user limiting
 */
export const withdrawalLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5, // 5 withdrawal requests per hour per user
  message: 'Too many withdrawal requests. Please wait before trying again.',
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request): string => {
    const firebaseUid = (req as any).auth?.firebaseUid || req.ip;
    return `withdrawal:${firebaseUid}`;
  },
  skip: (_req: Request): boolean => {
    // Skip rate limiting in development if needed
    return process.env.NODE_ENV === 'development' && process.env.DISABLE_RATE_LIMIT === 'true';
  },
});

/**
 * 🔥 SCALABILITY FIX: Rate limiter for creator tasks endpoint
 * - 30 requests per minute per user (prevents aggressive polling)
 * - Allows reasonable refresh rates (every 2 seconds) while preventing abuse
 * - Uses Firebase UID as key for per-user limiting
 */
export const tasksLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30, // 30 requests per minute per user
  message: 'Too many task requests. Please wait a moment before refreshing.',
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request): string => {
    const firebaseUid = (req as any).auth?.firebaseUid || req.ip;
    return `tasks:${firebaseUid}`;
  },
  skip: (_req: Request): boolean => {
    // Skip rate limiting in development if needed
    return process.env.NODE_ENV === 'development' && process.env.DISABLE_RATE_LIMIT === 'true';
  },
});

/**
 * Rate limiter for creator gallery upload-url generation.
 * - 20 requests per minute per creator is sufficient for retries/burst uploads.
 */
export const creatorGalleryUploadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: 'Too many gallery upload requests. Please wait a moment.',
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request): string => {
    const firebaseUid = (req as any).auth?.firebaseUid || req.ip;
    return `creator_gallery_upload:${firebaseUid}`;
  },
  skip: (_req: Request): boolean => {
    return process.env.NODE_ENV === 'development' && process.env.DISABLE_RATE_LIMIT === 'true';
  },
});

/**
 * Rate limiter for publishing global app updates (admin endpoint).
 * - Prevent rapid repeated publish actions across admin sessions.
 */
export const appUpdatePublishLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 5,
  message: 'Too many update publish attempts. Please wait a moment.',
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request): string => {
    const firebaseUid = (req as any).auth?.firebaseUid || req.ip;
    return `app_update_publish:${firebaseUid}`;
  },
  skip: (_req: Request): boolean => {
    return process.env.NODE_ENV === 'development' && process.env.DISABLE_RATE_LIMIT === 'true';
  },
});

/**
 * Rate limiter for chat endpoints (pre-send, other-member, quota)
 * - 60 requests per minute per user (1 msg/sec; 1000 users/day, 200 creators)
 * - Prevents abuse while allowing normal usage
 */
export const chatLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 60,
  message: 'Too many chat requests. Please wait a moment.',
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request): string => {
    const firebaseUid = (req as any).auth?.firebaseUid || req.ip;
    return `chat:${firebaseUid}`;
  },
});

/**
 * Rate limiter for Fast Login (unauthenticated)
 * - 20 requests per minute per IP (scalable for 1000 users/day, 200 creators)
 * - Allows peak onboarding without blocking legitimate retries
 */
export const fastLoginLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 20,
  message: 'Too many login attempts. Please wait a moment before trying again.',
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request): string => `fast_login:${req.ip}`,
  skip: (_req: Request): boolean => {
    return process.env.NODE_ENV === 'development' && process.env.DISABLE_RATE_LIMIT === 'true';
  },
});

/**
 * Rate limiter for /auth/login (authenticated endpoint - Firebase token required)
 * - 30 requests per minute per user (prevents abuse, allows retries)
 * - Keyed by Firebase UID when available, falls back to IP for edge cases
 */
export const loginLimiter = createLimiter({
  windowMs: 60 * 1000, // 1 minute
  max: 30,
  message: 'Too many login requests. Please wait a moment.',
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request): string => {
    const firebaseUid = (req as any).auth?.firebaseUid || req.ip;
    return `login:${firebaseUid}`;
  },
  skip: (_req: Request): boolean => {
    return process.env.NODE_ENV === 'development' && process.env.DISABLE_RATE_LIMIT === 'true';
  },
}, 'rl:login:');

/**
 * Rate limiter for phone auth precheck endpoint.
 * Returns explicit retry_after to support client-enforced cooldown UX.
 */
export const phonePrecheckLimiter = createLimiter({
  windowMs: 60 * 1000, // 1 minute
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request): string => {
    const phone = typeof req.body?.phoneNumber === 'string'
      ? req.body.phoneNumber.trim()
      : 'unknown';
    return `phone_precheck:${req.ip}:${phone}`;
  },
  handler: (req, res) => {
    const resetTime = req.rateLimit?.resetTime instanceof Date
      ? req.rateLimit.resetTime.getTime()
      : Date.now() + 60 * 1000;
    const retryAfter = Math.max(1, Math.ceil((resetTime - Date.now()) / 1000));
    res.status(429).json({
      success: false,
      error: 'too_many_requests',
      retry_after: retryAfter,
    });
  },
  skip: (_req: Request): boolean => {
    return process.env.NODE_ENV === 'development' && process.env.DISABLE_RATE_LIMIT === 'true';
  },
}, 'rl:phone-precheck:');

export const referralApplyLimiter = createLimiter(
  {
    windowMs: 15 * 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req: Request): string => {
      const firebaseUid = (req as any).auth?.firebaseUid || req.ip;
      return `referral_apply:${firebaseUid}`;
    },
  },
  'rl:referral-apply:'
);
