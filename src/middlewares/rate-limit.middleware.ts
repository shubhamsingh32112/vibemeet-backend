import rateLimit from 'express-rate-limit';
import type { Request, Response } from 'express';
import RedisStore from 'rate-limit-redis';
import type { RedisReply } from 'rate-limit-redis';
import { getRedis } from '../config/redis';
import { logWarning } from '../utils/logger';

/** Per-Firebase-UID general API cap (15 min) for mobile app users. */
export const MOBILE_FIREBASE_GENERAL_RATE_LIMIT_MAX = 600;
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
 * Rate limiter for Cloudflare Images direct-upload URL generation.
 * - 30 requests per minute per user covers retries + multi-image flows
 *   without giving abusers a cheap way to spawn upload sessions.
 */
export const imageDirectUploadLimiter = createLimiter(
  {
    windowMs: 60 * 1000,
    max: 30,
    message: 'Too many image upload requests. Please wait a moment.',
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req: Request): string => {
      const firebaseUid = (req as any).auth?.firebaseUid || req.ip;
      return `image_direct_upload:${firebaseUid}`;
    },
    skip: (_req: Request): boolean => {
      return process.env.NODE_ENV === 'development' && process.env.DISABLE_RATE_LIMIT === 'true';
    },
  },
  'rl:image-direct-upload:',
);

/**
 * Rate limiter for the client-side image render-latency telemetry endpoint.
 * Clients ship small batches (~ once per minute) so 60 req/min/user is more
 * than enough. Excess traffic is silently dropped — telemetry is best-effort
 * and MUST NEVER cascade into a 429 that the UI surfaces to the end user.
 */
export const imageRenderMetricsLimiter = createLimiter(
  {
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: false,
    legacyHeaders: false,
    keyGenerator: (req: Request): string => {
      const firebaseUid = (req as any).auth?.firebaseUid || req.ip;
      return `image_render_metrics:${firebaseUid}`;
    },
    skip: (_req: Request): boolean => {
      return process.env.NODE_ENV === 'development' && process.env.DISABLE_RATE_LIMIT === 'true';
    },
  },
  'rl:image-render-metrics:',
);

export const videoPlaybackMetricsLimiter = createLimiter(
  {
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: false,
    legacyHeaders: false,
    keyGenerator: (req: Request): string => {
      const firebaseUid = (req as any).auth?.firebaseUid || req.ip;
      return `video_playback_metrics:${firebaseUid}`;
    },
    skip: (_req: Request): boolean => {
      return process.env.NODE_ENV === 'development' && process.env.DISABLE_RATE_LIMIT === 'true';
    },
  },
  'rl:video-playback-metrics:',
);

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

export type StaffRateLimitIdentity = { userId: string; role: string };

export function staffGeneralRateLimitMaxForRole(role: string | undefined, isDev: boolean): number {
  if (isDev) return 5000;
  if (role === 'admin' || role === 'super_admin') return 2000;
  if (role === 'bd') return 400;
  if (role === 'agency') return 800;
  return 100;
}

function generalRateLimitMaxForRequest(req: Request, isDev: boolean): number {
  const staff = req.staffRateLimit;
  if (staff?.userId) {
    return staffGeneralRateLimitMaxForRole(staff.role, isDev);
  }
  if (req.firebaseRateLimitUid) {
    return isDev ? 5000 : MOBILE_FIREBASE_GENERAL_RATE_LIMIT_MAX;
  }
  return staffGeneralRateLimitMaxForRole(undefined, isDev);
}

function generalRateLimitKey(req: Request): string {
  const staff = req.staffRateLimit;
  if (staff?.userId) {
    return `staff:${staff.userId}:${staff.role}`;
  }
  if (req.firebaseRateLimitUid) {
    return `firebase:${req.firebaseRateLimitUid}`;
  }
  return `ip:${req.ip ?? 'unknown'}`;
}

function generalRateLimitBucketKind(req: Request): 'staff' | 'firebase' | 'ip' {
  if (req.staffRateLimit?.userId) return 'staff';
  if (req.firebaseRateLimitUid) return 'firebase';
  return 'ip';
}

/** Staff- and Firebase-aware general API limiter; unauthenticated traffic uses IP. */
export function createStaffGeneralLimiter(isDev: boolean) {
  return createLimiter(
    {
      windowMs: 15 * 60 * 1000,
      max: (req: Request) => generalRateLimitMaxForRequest(req, isDev),
      standardHeaders: true,
      legacyHeaders: false,
      keyGenerator: (req: Request): string => generalRateLimitKey(req),
      handler: (req: Request, res: Response) => {
        const resetTime = req.rateLimit?.resetTime instanceof Date
          ? req.rateLimit.resetTime.getTime()
          : Date.now() + 15 * 60 * 1000;
        const retryAfter = Math.max(1, Math.ceil((resetTime - Date.now()) / 1000));
        logWarning('general API rate limit exceeded', {
          bucket: generalRateLimitBucketKind(req),
          key: generalRateLimitKey(req),
          path: req.path,
          requestId: req.headers['x-request-id'],
          retryAfterSeconds: retryAfter,
        });
        res.status(429).json({
          success: false,
          error: 'too_many_requests',
          retry_after: retryAfter,
        });
      },
    },
    'rl:staff-general:'
  );
}
