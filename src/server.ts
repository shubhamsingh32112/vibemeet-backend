import express, { type Request } from 'express';
import compression from 'compression';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import Redis from 'ioredis';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';
dotenv.config();
import { createStaffGeneralLimiter } from './middlewares/rate-limit.middleware';
import { attachFirebaseRateLimitIdentity } from './middlewares/firebase-rate-limit.middleware';
import { attachStaffRateLimitIdentity } from './middlewares/staff-rate-limit.middleware';
import { connectDatabase } from './config/database';
import { initializeFirebase } from './config/firebase';
import {
  isRedisConfigured,
  getRedis,
  metricsKey,
  attachRedisClientMonitoring,
} from './config/redis';
import { configureStreamPush } from './config/stream';
import { setIO } from './config/socket';
import { setupAvailabilityGateway } from './modules/availability/availability.gateway';
import { setupBillingGateway, cleanupBillingIntervals, startGlobalBillingProcessor } from './modules/billing/billing.gateway';
import { isBullmqBillingEnabled } from './modules/billing/billing.queue';
import { startTerminationRetryWorker } from './modules/billing/billing-termination.queue';
import { startReconciliationJob, stopReconciliationJob } from './modules/billing/billing-reconciliation';
import { startBillingWatchdog, stopBillingWatchdog } from './modules/billing/billing-watchdog.service';
import {
  startStaffWalletReconciliationScheduler,
  stopStaffWalletReconciliationScheduler,
} from './modules/billing/staff-wallet-reconciliation.scheduler';
import {
  startDomainEventWorker,
  stopDomainEventWorker,
} from './modules/events/domain-event.worker';
import { verifyStartupRecovery } from './modules/billing/billing-recovery';
import { setupAdminGateway } from './modules/admin/admin.gateway';
import routes from './routes';
import { cleanupStaleCreatorLocks } from './modules/video/video.webhook';
import { startCallReconciliationJob, stopCallReconciliationJob } from './modules/video/call-reconciliation';
import {
  startPaymentWebhookRetryWorker,
  stopPaymentWebhookRetryWorker,
} from './modules/payment/payment-webhook-retry.service';
import {
  startImagePipelineWorkers,
  stopImagePipelineWorkers,
} from './modules/images/images.bootstrap';
import { isRazorpayConfigured } from './config/razorpay';
import { CreatorTaskProgress } from './modules/creator/creator-task.model';
import { getDailyPeriodBounds } from './modules/creator/creator-tasks.config';
import { validatePricingConfig } from './config/pricing.config';
import { logRequest, logError, logWarning, logInfo } from './utils/logger';
import { requestContextMiddleware } from './middlewares/request-context.middleware';
import { logRateLimitConfig } from './utils/rate-limit.service';
import { requestQueueMiddleware, getRequestQueueStats } from './middlewares/request-queue.middleware';
import { mongoPoolMonitor } from './utils/mongo-pool-monitor';
import { getDriverMetrics } from './utils/driver-metrics';
import { monitoring, recordAPIMetric, recordSystemMetric } from './utils/monitoring';
import { setLatestEventLoopLagMs } from './utils/runtime-signals';
import mongoose from 'mongoose';
import { performance } from 'perf_hooks';

const app = express();
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
let eventLoopProbe: NodeJS.Timeout | null = null;

// One hop (Railway, Heroku, Fly, nginx ingress, etc.) sets X-Forwarded-For.
// Required so express-rate-limit can read client IPs without throwing
// ERR_ERL_UNEXPECTED_X_FORWARDED_FOR, and so req.ip is correct.
// Set TRUST_PROXY_HOPS=0 only if the app is never behind a reverse proxy.
const trustHops = process.env.TRUST_PROXY_HOPS;
if (trustHops === '0' || trustHops === 'false') {
  app.set('trust proxy', false);
} else {
  const n = trustHops != null && trustHops !== '' ? Number(trustHops) : 1;
  app.set('trust proxy', Number.isFinite(n) && n >= 0 ? n : 1);
}

// Security middleware
app.use(helmet({
  // Allow cleartext traffic for local development
  contentSecurityPolicy: false,
  crossOriginOpenerPolicy: false, // Allow popups for OAuth
}));

function escapeRegexLiteral(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function corsOriginEntryToMatcher(entry: string): string | RegExp {
  const trimmed = entry.trim();
  if (!trimmed) return '*';
  if (trimmed === '*') return '*';

  // Allow simple wildcard patterns like:
  // - https://*.example.com
  // - *.example.com
  // This compiles into a safe regex that matches full origins.
  if (trimmed.includes('*')) {
    const safe = escapeRegexLiteral(trimmed).replace(/\\\*/g, '.*');
    return new RegExp(`^${safe}$`);
  }
  return trimmed;
}

function buildCorsOrigin(): boolean | string | RegExp | (string | RegExp)[] {
  const raw = (process.env.CORS_ORIGIN || '').trim();
  if (!raw || raw === '*') {
    if (process.env.NODE_ENV === 'production') {
      logWarning('CORS_ORIGIN is * or unset in production — set explicit origins for web clients', {});
    }
    return '*';
  }

  const parts = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(corsOriginEntryToMatcher);

  if (parts.length === 0) return '*';
  if (parts.length === 1) return parts[0];
  return parts;
}

app.use(
  cors({
    origin: buildCorsOrigin(),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'Accept',
      'X-Requested-With',
      'x-idempotency-key',
      'X-Idempotency-Key',
      'x-request-id',
      'X-Request-Id',
      'x-correlation-id',
      'X-Correlation-Id',
    ],
    exposedHeaders: ['Content-Length', 'Content-Type'],
    maxAge: 86400,
    optionsSuccessStatus: 204,
    preflightContinue: false,
  })
);

// Rate limiting
// FIX 3: More lenient limit for status endpoint (polling every 3s = 20/min)
const isDev = process.env.NODE_ENV !== 'production';
const rateLimitDisabledInDev =
  isDev && process.env.DISABLE_RATE_LIMIT === 'true';

function isLoopbackClient(req: Request): boolean {
  const ip = req.ip ?? '';
  return (
    ip === '127.0.0.1' ||
    ip === '::1' ||
    ip === '::ffff:127.0.0.1' ||
    ip.endsWith('127.0.0.1')
  );
}

function shouldSkipGeneralRateLimit(req: Request): boolean {
  if (rateLimitDisabledInDev) return true;
  // Emulator + adb reverse share the host loopback IP; 100/15min is too low for dev.
  if (isDev && isLoopbackClient(req)) return true;
  return false;
}

const generalLimiter = createStaffGeneralLimiter(isDev);

// Separate limiter for status endpoint (more lenient for polling)
const statusLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: isDev ? 500 : 30,
  message: 'Too many status requests, please wait.',
  skip: (req) => {
    if (shouldSkipGeneralRateLimit(req)) return true;
    // Only apply to status endpoint
    return !req.path.includes('/status');
  },
});

// Staff JWT + Firebase UID identity for per-user rate buckets (before route auth)
app.use('/api/', attachStaffRateLimitIdentity);
app.use('/api/', attachFirebaseRateLimitIdentity);

// Apply general limiter to all API routes
app.use('/api/', (req, res, next) => {
  if (shouldSkipGeneralRateLimit(req)) return next();
  return generalLimiter(req, res, next);
});
// Apply stricter limiter specifically for status endpoints.
app.use('/api/', statusLimiter);

// Compression - gzip responses for scalability (reduces bandwidth)
app.use(compression());

/** Signed webhook endpoints must use raw request bytes for HMAC verification. */
function isSignedWebhookPost(req: Request): boolean {
  if (req.method !== 'POST') return false;
  const pathOnly = req.originalUrl.split('?')[0];
  return (
    pathOnly === '/api/v1/video/webhook' ||
    pathOnly === '/api/v1/chat/webhook' ||
    pathOnly === '/api/v1/payment/webhook'
  );
}

const jsonParser = express.json({ limit: '50mb' });
const urlEncodedParser = express.urlencoded({ extended: true, limit: '50mb' });

app.use((req, res, next) => {
  if (isSignedWebhookPost(req)) {
    return express.raw({ type: '*/*', limit: '2mb' })(req, res, next);
  }
  next();
});

app.use((req, res, next) => {
  if (isSignedWebhookPost(req)) {
    return next();
  }
  jsonParser(req, res, next);
});

app.use((req, res, next) => {
  if (isSignedWebhookPost(req)) {
    return next();
  }
  urlEncodedParser(req, res, next);
});

app.use(requestContextMiddleware);

// Request logging middleware
app.use((req, _res, next) => {
  logRequest(req.method, req.path, req.ip || 'unknown-ip', {
    fullUrl: `${req.protocol}://${req.get('host') ?? 'unknown-host'}${req.originalUrl}`,
    hasAuth: !!req.headers.authorization,
  });
  next();
});

// Request queuing & backpressure (applies to /api routes)
app.use('/api/', requestQueueMiddleware);

// Basic API latency + status (for dashboards / alerting)
app.use('/api/', (_req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    recordAPIMetric('latency_ms', ms);
    if (res.statusCode >= 500) {
      recordAPIMetric('http_5xx', 1);
    }
  });
  next();
});

// Metrics endpoint — set METRICS_TOKEN and send header X-Metrics-Token to access
app.get('/metrics', async (req, res) => {
  try {
    const metricsToken = (process.env.METRICS_TOKEN || '').trim();
    if (metricsToken) {
      const sent = req.headers['x-metrics-token'];
      if (sent !== metricsToken) {
        res.status(403).json({ success: false, error: 'Forbidden' });
        return;
      }
    }
    const mongoStats = mongoPoolMonitor.getStats();
    const queueStats = getRequestQueueStats();
    const driver = getDriverMetrics();
    const metricsSummary = monitoring.getMetricsSummary();
    const byName = metricsSummary.byName;
    const apiSummary = byName['api.latency_ms'];
    const forceTerminateRequested = byName['billing.force_terminate_requested']?.sum ?? 0;
    const forceTerminateFailed = byName['billing.force_terminate_stream_failed']?.sum ?? 0;
    const forceTerminateFailureRate =
      forceTerminateRequested > 0 ? forceTerminateFailed / forceTerminateRequested : 0;
    const bullLagAvgMs = byName['billing.bullmq_queue_lag_ms']?.avg ?? 0;
    const eventLoopLag = byName['system.event_loop_lag_ms'];
    const tickDrift = byName['billing.tick_drift_ms'];
    const settlementTotal = byName['billing.settlement_total_ms'];
    const backpressureStage = byName['billing.backpressure_stage'];
    const stateRecovery = byName['billing.state_recovery'];
    const stateRecoverySuppressed = byName['billing.state_recovery_suppressed'];
    const recoveryOutcome = byName['billing.recovery_outcome'];
    const creatorStatusPropagation = byName['presence.creator_status_propagation_ms'];
    const paymentWebhookVerifyFail = byName['payment.webhook.verify_failed'];
    const paymentWebhookVerifySuccess = byName['payment.webhook.verify_success'];
    const paymentWebhookProcessed = byName['payment.webhook.processed'];
    const paymentWebhookProcessFailed = byName['payment.webhook.process_failed'];
    const paymentFinalizeCompleted = byName['payment.finalize.completed'];
    const paymentFinalizeAlreadyCompleted = byName['payment.finalize.already_completed'];
    const paymentFinalizeFailed = byName['payment.finalize.failed'];
    const paymentWebVerifySuccess = byName['payment.web.verify_success'];
    const paymentWebVerifyFailed = byName['payment.web.verify_failed'];
    const paymentWebVerifyDuration = byName['payment.web.verify_duration_ms'];
    const reconRunMsAvg = byName['billing.reconciliation_run_ms']?.avg ?? 0;
    const reconItemsAvg = byName['billing.reconciliation_items_processed']?.avg ?? 0;
    const now = Date.now();
    const rollingWindowMs = 5 * 60 * 1000;
    const fromTs = now - rollingWindowMs;
    const rollingSampleLimit = 2000;
    const metricsAlerts: string[] = [];

    let rollingForceTerminateRequested = 0;
    let rollingForceTerminateFailed = 0;
    let rollingForceTerminateFailureRate = 0;
    let rollingBullLagAvgMs = 0;
    let rollingReconRunAvgMs = 0;
    let rollingRedisOpsPerSec = 0;
    let rollingRedisPipelineSuccess = 0;
    let rollingRedisPipelineFailure = 0;
    let rollingRedisPipelineFailureRate = 0;

    if (isRedisConfigured()) {
      const redis = getRedis();
      const [requested5m, failed5m] = await Promise.all([
        redis.zcount(metricsKey('billing.force_terminate_requested'), fromTs, now),
        redis.zcount(metricsKey('billing.force_terminate_stream_failed'), fromTs, now),
      ]);
      rollingForceTerminateRequested = Number(requested5m || 0);
      rollingForceTerminateFailed = Number(failed5m || 0);
      rollingForceTerminateFailureRate =
        rollingForceTerminateRequested > 0
          ? rollingForceTerminateFailed / rollingForceTerminateRequested
          : 0;

      const [lagSampleRaw, reconSampleRaw, redisOpsRaw, pipelineSuccess5m, pipelineFailure5m] = await Promise.all([
        redis.zrevrangebyscore(
          metricsKey('billing.bullmq_queue_lag_ms'),
          now,
          fromTs,
          'LIMIT',
          0,
          rollingSampleLimit
        ),
        redis.zrevrangebyscore(
          metricsKey('billing.reconciliation_run_ms'),
          now,
          fromTs,
          'LIMIT',
          0,
          rollingSampleLimit
        ),
        redis.zrevrangebyscore(
          metricsKey('billing.redis_ops'),
          now,
          fromTs,
          'LIMIT',
          0,
          rollingSampleLimit
        ),
        redis.zcount(metricsKey('billing.redis_pipeline_success'), fromTs, now),
        redis.zcount(metricsKey('billing.redis_pipeline_failure'), fromTs, now),
      ]);

      const parseMetricSampleStats = (raw: string[]): { avg: number; sum: number; count: number } => {
        if (!raw || raw.length === 0) return { avg: 0, sum: 0, count: 0 };
        let sum = 0;
        let count = 0;
        for (const item of raw) {
          try {
            const parsed = JSON.parse(item) as { value?: number };
            const v = Number(parsed.value);
            if (Number.isFinite(v)) {
              sum += v;
              count += 1;
            }
          } catch {
            // ignore malformed sample
          }
        }
        return {
          avg: count > 0 ? sum / count : 0,
          sum,
          count,
        };
      };

      const lagStats = parseMetricSampleStats(lagSampleRaw);
      const reconStats = parseMetricSampleStats(reconSampleRaw);
      const redisOpsStats = parseMetricSampleStats(redisOpsRaw);
      rollingBullLagAvgMs = lagStats.avg;
      rollingReconRunAvgMs = reconStats.avg;
      rollingRedisOpsPerSec = redisOpsStats.sum / (rollingWindowMs / 1000);
      rollingRedisPipelineSuccess = Number(pipelineSuccess5m || 0);
      rollingRedisPipelineFailure = Number(pipelineFailure5m || 0);
      const totalPipelines = rollingRedisPipelineSuccess + rollingRedisPipelineFailure;
      rollingRedisPipelineFailureRate =
        totalPipelines > 0 ? rollingRedisPipelineFailure / totalPipelines : 0;
    }

    if (rollingForceTerminateRequested > 0 && rollingForceTerminateFailureRate > 0.02) {
      metricsAlerts.push('billing_force_termination_failure_rate_high_5m');
    }
    if (rollingBullLagAvgMs > 5000) {
      metricsAlerts.push('bullmq_queue_lag_high_5m');
    }
    if ((eventLoopLag?.p95 ?? 0) > 50) {
      metricsAlerts.push('event_loop_lag_p95_high');
    }
    if ((tickDrift?.p95 ?? 0) > 100 || (tickDrift?.p99 ?? 0) > 300) {
      metricsAlerts.push('billing_tick_drift_high');
    }
    if ((backpressureStage?.max ?? 0) >= 3) {
      metricsAlerts.push('billing_backpressure_stage3');
    }
    const recoverySuccess = stateRecovery?.sum ?? 0;
    const recoverySuppressed = stateRecoverySuppressed?.sum ?? 0;
    const recoveryTotal = recoverySuccess + recoverySuppressed;
    if (recoveryTotal >= 20 && recoverySuppressed / recoveryTotal > 0.85) {
      metricsAlerts.push('billing_recovery_suppressed_high');
    }
    if ((settlementTotal?.p95 ?? 0) > 5000) {
      metricsAlerts.push('billing_settlement_p95_high');
    }
    if ((creatorStatusPropagation?.p95 ?? 0) > 500) {
      metricsAlerts.push('creator_status_propagation_high');
    }
    if (rollingRedisPipelineFailureRate > 0.02) {
      metricsAlerts.push('billing_redis_pipeline_failure_rate_high_5m');
    }
    if (rollingReconRunAvgMs > 0 && rollingReconRunAvgMs > 0.8 * 5 * 60 * 1000) {
      metricsAlerts.push('billing_reconciliation_runtime_high_5m');
    }
    res.status(200).json({
      mongo: {
        activeConnections: mongoStats.checkedOut,
        maxConnections: mongoStats.maxPoolSize,
        poolUtilization: Math.round(mongoStats.utilization * 100) / 100,
        checkOutFailedTotal: mongoStats.checkOutFailedTotal,
        lastCheckOutFailedAt: mongoStats.lastCheckOutFailedAt,
        driverConnectionErrors: driver.mongo.connectionErrors,
      },
      redis: {
        driverErrors: driver.redis.errors,
        driverCloses: driver.redis.closes,
      },
      requestQueue: {
        active: queueStats.active,
        waiting: queueStats.waiting,
        rejected: queueStats.rejected,
      },
      api: {
        latencyMs: apiSummary
          ? {
              samples: apiSummary.count,
              avgMs: Math.round((apiSummary.sum / apiSummary.count) * 100) / 100,
            }
          : null,
        http5xxSamples: byName['api.http_5xx']?.count ?? 0,
      },
      billing: {
        backpressure: {
          currentStage: Math.round(backpressureStage?.max ?? 0),
        },
        recovery: {
          stateRecoverySamples: stateRecovery?.count ?? 0,
          stateRecoverySuccessSum: recoverySuccess,
          stateRecoverySuppressedSamples: stateRecoverySuppressed?.count ?? 0,
          stateRecoverySuppressedSum: recoverySuppressed,
          recoveryOutcomeSamples: recoveryOutcome?.count ?? 0,
        },
        tickDriftMs: tickDrift
          ? {
              samples: tickDrift.count,
              avgMs: Math.round(tickDrift.avg * 100) / 100,
              p95Ms: Math.round(tickDrift.p95 * 100) / 100,
              p99Ms: Math.round(tickDrift.p99 * 100) / 100,
              maxMs: Math.round(tickDrift.max * 100) / 100,
            }
          : null,
        settlementTotalMs: settlementTotal
          ? {
              samples: settlementTotal.count,
              avgMs: Math.round(settlementTotal.avg * 100) / 100,
              p95Ms: Math.round(settlementTotal.p95 * 100) / 100,
              p99Ms: Math.round(settlementTotal.p99 * 100) / 100,
              maxMs: Math.round(settlementTotal.max * 100) / 100,
            }
          : null,
        forceTermination: {
          requested: forceTerminateRequested,
          streamFailures: forceTerminateFailed,
          failureRate: Math.round(forceTerminateFailureRate * 10000) / 10000,
          rolling5m: {
            requested: rollingForceTerminateRequested,
            streamFailures: rollingForceTerminateFailed,
            failureRate:
              Math.round(rollingForceTerminateFailureRate * 10000) / 10000,
          },
        },
        bullmq: {
          queueLagAvgMs: Math.round(bullLagAvgMs * 100) / 100,
          queueLagSamples: byName['billing.bullmq_queue_lag_ms']?.count ?? 0,
          rolling5m: {
            queueLagAvgMs: Math.round(rollingBullLagAvgMs * 100) / 100,
            sampleLimit: rollingSampleLimit,
          },
        },
        redis: {
          opsPerSecRolling5m: Math.round(rollingRedisOpsPerSec * 100) / 100,
          pipelineRolling5m: {
            success: rollingRedisPipelineSuccess,
            failure: rollingRedisPipelineFailure,
            failureRate: Math.round(rollingRedisPipelineFailureRate * 10000) / 10000,
          },
        },
        reconciliation: {
          runAvgMs: Math.round(reconRunMsAvg * 100) / 100,
          runSamples: byName['billing.reconciliation_run_ms']?.count ?? 0,
          itemsAvg: Math.round(reconItemsAvg * 100) / 100,
          rolling5m: {
            runAvgMs: Math.round(rollingReconRunAvgMs * 100) / 100,
            sampleLimit: rollingSampleLimit,
          },
        },
      },
      payment: {
        webhook: {
          verify: {
            successSamples: paymentWebhookVerifySuccess?.count ?? 0,
            failedSamples: paymentWebhookVerifyFail?.count ?? 0,
          },
          processing: {
            processedSamples: paymentWebhookProcessed?.count ?? 0,
            failedSamples: paymentWebhookProcessFailed?.count ?? 0,
          },
        },
        finalize: {
          completedSamples: paymentFinalizeCompleted?.count ?? 0,
          alreadyCompletedSamples: paymentFinalizeAlreadyCompleted?.count ?? 0,
          failedSamples: paymentFinalizeFailed?.count ?? 0,
        },
        webVerify: {
          successSamples: paymentWebVerifySuccess?.count ?? 0,
          failedSamples: paymentWebVerifyFailed?.count ?? 0,
          durationMs: paymentWebVerifyDuration
            ? {
                samples: paymentWebVerifyDuration.count,
                avgMs: Math.round(paymentWebVerifyDuration.avg * 100) / 100,
                p95Ms: Math.round(paymentWebVerifyDuration.p95 * 100) / 100,
                p99Ms: Math.round(paymentWebVerifyDuration.p99 * 100) / 100,
                maxMs: Math.round(paymentWebVerifyDuration.max * 100) / 100,
              }
            : null,
        },
      },
      runtime: {
        eventLoopLagMs: eventLoopLag
          ? {
              samples: eventLoopLag.count,
              avgMs: Math.round(eventLoopLag.avg * 100) / 100,
              p95Ms: Math.round(eventLoopLag.p95 * 100) / 100,
              p99Ms: Math.round(eventLoopLag.p99 * 100) / 100,
              maxMs: Math.round(eventLoopLag.max * 100) / 100,
            }
          : null,
      },
      presence: {
        creatorStatusPropagationMs: creatorStatusPropagation
          ? {
              samples: creatorStatusPropagation.count,
              avgMs: Math.round(creatorStatusPropagation.avg * 100) / 100,
              p95Ms: Math.round(creatorStatusPropagation.p95 * 100) / 100,
              p99Ms: Math.round(creatorStatusPropagation.p99 * 100) / 100,
              maxMs: Math.round(creatorStatusPropagation.max * 100) / 100,
            }
          : null,
      },
      alerts: {
        active: metricsAlerts,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (err: any) {
    logError('Metrics endpoint error', err);
    res.status(500).json({ error: 'Failed to collect metrics' });
  }
});

// Health & readiness endpoints - CRITICAL for connectivity and orchestration
// Test URLs: /health (backwards compatible), /live, /ready
app.get('/health', (_req, res) => {
  res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    server: 'Eazy Talks Backend',
    version: '1.0.0',
    uptime: process.uptime(),
    environment: process.env.NODE_ENV || 'development',
    redis: {
      configured: isRedisConfigured(),
      note: 'Use GET /ready for write/read probe',
    },
  });
});

// Simple liveness probe: process is up and Express is responding
app.get('/live', (_req, res) => {
  res.status(200).json({
    status: 'live',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

// Readiness probe: verify we can talk to core dependencies
app.get('/ready', async (_req, res) => {
  const checks: Record<string, { ok: boolean; error?: string }> = {};

  // MongoDB readiness
  try {
    // Check if mongoose connection exists and is ready
    if (!mongoose.connection || mongoose.connection.readyState === undefined) {
      checks.mongo = {
        ok: false,
        error: 'mongoose_not_initialized',
      };
    } else {
      const state = mongoose.connection.readyState;
      // 0 = disconnected, 1 = connected, 2 = connecting, 3 = disconnecting
      // Only state 1 (connected) is considered ready
      checks.mongo = {
        ok: state === 1,
        error: state === 1 ? undefined : `mongo_state_${state}`,
      };
    }
  } catch (err: any) {
    checks.mongo = {
      ok: false,
      error: err?.message || 'mongo_check_failed',
    };
  }

  // Redis readiness (configuration + write/read test)
  try {
    if (!isRedisConfigured()) {
      checks.redis = { ok: false, error: 'not_configured' };
    } else {
      const { getRedis } = await import('./config/redis');
      const redis = getRedis();
      
      // Test write/read operations (not just ping)
      const testKey = `healthcheck:ready:${Date.now()}`;
      await redis.setex(testKey, 10, 'test');
      const value = await redis.get(testKey);
      await redis.del(testKey);
      
      checks.redis = {
        ok: value === 'test',
        error: value === 'test' ? undefined : 'read_write_test_failed',
      };
    }
  } catch (err: any) {
    checks.redis = {
      ok: false,
      error: err?.message || 'redis_check_failed',
    };
  }

  const allOk = Object.values(checks).every((c) => c.ok);

  res.status(allOk ? 200 : 503).json({
    status: allOk ? 'ready' : 'degraded',
    timestamp: new Date().toISOString(),
    checks,
  });
});

// API routes
app.use('/api/v1', routes);

// 404 handler
const QUIET_404_PATHS = new Set([
  '/',
  '/favicon.ico',
  '/robots.txt',
  '/sitemap.xml',
  '/.well-known/security.txt',
]);

app.use((req, res) => {
  const quietProbe =
    QUIET_404_PATHS.has(req.path) ||
    req.path.startsWith('/.well-known/') ||
    req.path.startsWith('/api/v1') === false && req.method === 'GET' && req.path.endsWith('.php');
  if (!quietProbe) {
    logWarning('Route not found', {
      method: req.method,
      path: req.path,
      fullUrl: `${req.protocol}://${req.get('host') ?? 'unknown-host'}${req.originalUrl}`,
      ip: req.ip,
    });
  }
  res.status(404).json({
    success: false,
    error: 'Route not found',
    path: req.path,
    method: req.method,
  });
});

// Error handling middleware
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logError('Unhandled error in Express middleware', err, {
    path: _req.path,
    method: _req.method,
  });
  res.status(500).json({
    success: false,
    error: 'Internal server error',
  });
});

// Initialize services and start server
function assertProductionSecurity(): void {
  if (process.env.NODE_ENV !== 'production') return;
  const jwt = (process.env.JWT_SECRET || '').trim();
  if (!jwt || jwt === 'admin-secret-change-me') {
    throw new Error(
      'NODE_ENV=production requires JWT_SECRET to be set to a secure non-default value',
    );
  }
  const email = (process.env.ADMIN_EMAIL || '').trim();
  const pw = (process.env.ADMIN_PASSWORD || '').trim();
  if (!email || !pw) {
    throw new Error('NODE_ENV=production requires ADMIN_EMAIL and ADMIN_PASSWORD to be set');
  }
}

/** Web checkout depends on stable public URLs; warn early if unset. */
function warnIfMissingPublicUrls(): void {
  if (process.env.NODE_ENV !== 'production') return;
  const apiBase =
    (process.env.PUBLIC_API_BASE_URL || process.env.API_BASE_URL || process.env.BACKEND_PUBLIC_URL || '').trim();
  const webBase = (process.env.WEB_CHECKOUT_BASE_URL || '').trim();
  if (!apiBase) {
    logWarning('PUBLIC_API_BASE_URL is not set in production; checkout links may embed the wrong apiBase', {});
  }
  if (!webBase) {
    logWarning('WEB_CHECKOUT_BASE_URL is not set in production; /payment/web/initiate may generate broken checkoutUrl', {});
  }
}

/** Billing is Redis-backed; fail fast in production if not wired (e.g. Railway variable reference). */
function assertProductionRedis(): void {
  if (process.env.NODE_ENV !== 'production') return;
  if (!isRedisConfigured()) {
    throw new Error(
      'NODE_ENV=production requires Redis. Add variable references: REDIS_URL (private) or REDISHOST, REDISPORT, REDIS_PASSWORD, REDISUSER from your Railway Redis service.',
    );
  }
}

function enforceProductionBillingDriverSafety(): void {
  if (process.env.NODE_ENV !== 'production') return;
  const isRailway = !!process.env.RAILWAY_ENVIRONMENT || !!process.env.RAILWAY_PROJECT_ID;
  const bullmq = isBullmqBillingEnabled();
  if (bullmq) {
    logInfo('Production billing driver safety check passed', { billingDriver: 'bullmq' });
    return;
  }
  const allowUnsafe = process.env.BILLING_ALLOW_UNSAFE_ZSET_IN_PRODUCTION === 'true';
  if (!isRailway) {
    logWarning('Production is running billing driver without BullMQ', {
      billingDriver: process.env.BILLING_DRIVER || 'zset',
    });
    return;
  }
  if (allowUnsafe) {
    logWarning('Unsafe Railway billing driver override is enabled', {
      billingDriver: process.env.BILLING_DRIVER || 'zset',
      env: 'BILLING_ALLOW_UNSAFE_ZSET_IN_PRODUCTION=true',
    });
    return;
  }
  throw new Error(
    'Unsafe Railway billing configuration: set BILLING_DRIVER=bullmq for production replicas, or explicitly override with BILLING_ALLOW_UNSAFE_ZSET_IN_PRODUCTION=true.'
  );
}

const startServer = async () => {
  try {
    // Initialize Firebase Admin
    initializeFirebase();

    assertProductionSecurity();
    warnIfMissingPublicUrls();
    assertProductionRedis();
    enforceProductionBillingDriverSafety();

    // 🔥 FIX 12: Validate pricing configuration on startup
    validatePricingConfig();
    if (!eventLoopProbe) {
      eventLoopProbe = setInterval(() => {
        const startedAt = performance.now();
        setImmediate(() => {
          const lagMs = Math.max(0, performance.now() - startedAt);
          setLatestEventLoopLagMs(lagMs);
          recordSystemMetric('event_loop_lag_ms', lagMs);
        });
      }, 1000);
    }

    // 🔥 FIX 40: Log rate limiting configuration on startup
    logRateLimitConfig();
    
    // Connect to MongoDB
    await connectDatabase();
    
    // 🔥 FIX 6: Cleanup stale creator locks on startup
    await cleanupStaleCreatorLocks();

    // ── Drop old unique index if it exists (migration: daily task reset) ──
    // The old index { creatorUserId: 1, taskKey: 1 } must be replaced by
    // { creatorUserId: 1, taskKey: 1, periodStart: 1 } for daily resets.
    try {
      const collection = CreatorTaskProgress.collection;
      const indexes = await collection.indexes();
      const oldIndex = indexes.find(
        (idx: any) =>
          idx.key?.creatorUserId === 1 &&
          idx.key?.taskKey === 1 &&
          !idx.key?.periodStart &&
          idx.unique === true,
      );
      if (oldIndex) {
        logInfo('Dropping old CreatorTaskProgress unique index (no periodStart)', {
          indexName: oldIndex.name,
          collection: 'CreatorTaskProgress',
        });
        await collection.dropIndex(oldIndex.name!);
        logInfo('Old index dropped. New index will be created by Mongoose', {
          indexName: oldIndex.name,
        });
      }
    } catch (migrationErr) {
      // Ignore if collection doesn't exist yet or index already dropped
      logInfo('CreatorTaskProgress index check', {
        error: (migrationErr as Error).message,
      });
    }

    // Configure Stream Chat push notifications (FCM)
    await configureStreamPush();
    
    // Create HTTP server and attach Socket.IO (same CORS policy as Express)
    const httpServer = createServer(app);
    const socketCorsOrigin = buildCorsOrigin();
    const io = new SocketIOServer(httpServer, {
      cors: {
        origin: socketCorsOrigin,
        methods: ['GET', 'POST'],
      },
      pingTimeout: 60000,
      pingInterval: 25000,
      transports: ['websocket', 'polling'],
    });

    // Multi-node Socket.IO: same Redis pub/sub for all replicas (opt-out via env)
    if (isRedisConfigured() && process.env.SOCKET_IO_REDIS_ADAPTER !== 'false') {
      try {
        const rawFamily = process.env.REDIS_FAMILY;
        const socketAdapterFamily =
          rawFamily === undefined || rawFamily === ''
            ? undefined
            : (() => {
                const n = parseInt(rawFamily, 10);
                return Number.isFinite(n) && n >= 0 ? n : undefined;
              })();
        const redisUrl = process.env.REDIS_URL || process.env.REDIS_PUBLIC_URL;
        let pubClient: Redis | null = null;
        if (redisUrl) {
          pubClient = new Redis(redisUrl, {
            ...(socketAdapterFamily !== undefined ? { family: socketAdapterFamily } : {}),
            maxRetriesPerRequest: 20,
            enableReadyCheck: true,
          });
        } else if (process.env.REDISHOST) {
          pubClient = new Redis({
            host: process.env.REDISHOST,
            port: parseInt(process.env.REDISPORT || '6379', 10),
            password: process.env.REDIS_PASSWORD || process.env.REDISPASSWORD,
            username: process.env.REDISUSER,
            ...(socketAdapterFamily !== undefined ? { family: socketAdapterFamily } : {}),
            maxRetriesPerRequest: 20,
            enableReadyCheck: true,
          });
        }
        if (pubClient) {
          const subClient = pubClient.duplicate();
          attachRedisClientMonitoring(pubClient, 'socket_adapter_pub');
          attachRedisClientMonitoring(subClient, 'socket_adapter_sub');
          io.adapter(createAdapter(pubClient, subClient));
          logInfo('Socket.IO Redis adapter enabled (multi-node broadcasts)');
        }
      } catch (adapterErr) {
        logWarning('Socket.IO Redis adapter failed — using in-memory adapter only', {
          error: adapterErr instanceof Error ? adapterErr.message : String(adapterErr),
        });
      }
    }

    // Store IO instance globally (so controllers can broadcast)
    setIO(io);

    // Set up Socket.IO gateways
    setupAvailabilityGateway(io);
    logInfo('Socket.IO availability gateway ready');

    setupBillingGateway(io);
    logInfo('Socket.IO billing gateway ready');
    
    // 🔥 FIX: Start global billing batch processor (replaces per-call polling)
    startGlobalBillingProcessor(io);
    startTerminationRetryWorker();
    // 🔥 FIX 5: Start reconciliation job for error recovery
    startReconciliationJob(io);
    startBillingWatchdog(io);
    startStaffWalletReconciliationScheduler();
    startDomainEventWorker();
    logInfo('Global billing batch processor started');
    
    // 🔥 FIX: Verify startup recovery for active calls
    verifyStartupRecovery(io).catch((err) => {
      logError('Startup recovery verification failed', err);
    });

    // 🔥 NEW: Start periodic call reconciliation against Stream
    startCallReconciliationJob(io);
    startPaymentWebhookRetryWorker();

    // ☁️ Image pipeline workers (blurhash + orphan cleanup).
    // No-ops when USE_CLOUDFLARE_IMAGES is false or Cloudflare credentials are missing.
    startImagePipelineWorkers().catch((err) => {
      logError('Image pipeline workers failed to start', err);
    });

    setupAdminGateway(io);
    logInfo('Socket.IO admin gateway ready');
    
    // 🔴 Check Redis configuration (Railway Redis) - CRITICAL for billing
    if (isRedisConfigured()) {
      try {
        const { getRedis } = await import('./config/redis');
        const redis = getRedis();
        
        // Test Redis connection with ping
        await redis.ping();
        logInfo('Railway Redis connected successfully');
        
        // Test write/read operations
        const testKey = `healthcheck:startup:${Date.now()}`;
        await redis.setex(testKey, 10, 'test');
        const value = await redis.get(testKey);
        await redis.del(testKey);
        
        if (value !== 'test') {
          logError('CRITICAL: Redis write/read test failed', new Error('Read value mismatch'), {
            alert: true,
            impact: 'Billing will not work correctly',
          });
        } else {
          logInfo('Railway Redis health check passed');
        }
      } catch (err) {
        logError('CRITICAL: Redis connection failed', err, {
          alert: true,
          impact: 'Billing will not work - coins will not be deducted, creators will not earn',
          requiredEnvVars: ['REDIS_URL', 'REDIS_PUBLIC_URL', 'REDISHOST'],
        });
        if (process.env.NODE_ENV === 'production') {
          throw new Error('Redis connection required for production billing');
        }
      }
    } else {
      logError('CRITICAL: Redis not configured', {
        alert: true,
        impact: 'Billing will not work - coins will not be deducted, creators will not earn',
        requiredEnvVars: ['REDIS_URL', 'REDIS_PUBLIC_URL', 'REDISHOST'],
      });
      if (process.env.NODE_ENV === 'production') {
        throw new Error('Redis is required in production (assertProductionRedis should have failed)');
      }
    }

    // 💳 Check Razorpay configuration
    if (isRazorpayConfigured()) {
      logInfo('Payment gateway configured');
    } else {
      logWarning('Razorpay NOT configured - coin purchases will fail', {
        requiredEnvVars: ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET'],
      });
    }
    
    // Start server - listen on all interfaces (0.0.0.0) for USB/WiFi debugging
    httpServer.listen(PORT, '0.0.0.0', () => {
      logInfo('Server started successfully', {
        port: PORT,
        interface: '0.0.0.0',
        environment: process.env.NODE_ENV || 'development',
        urls: {
          http: `http://localhost:${PORT}/health`,
          socket: `ws://localhost:${PORT}`,
          network: `http://YOUR_DESKTOP_IP:${PORT}/health`,
        },
        frontendConfig: {
          instruction: 'Find your desktop IP: ipconfig (Windows) or ifconfig (Mac/Linux)',
          configFile: 'frontend/lib/core/constants/app_constants.dart',
          example: `http://192.168.1.10:${PORT}/api/v1`,
        },
      });
    });
  } catch (error) {
    logError('Failed to start server', error);
    process.exit(1);
  }
};

// ── Daily task progress cleanup (remove records older than 7 days) ────
// Runs every 6 hours. Old CreatorTaskProgress records are irrelevant
// because task queries filter by the current period's periodStart.
// This is purely for database hygiene.
async function cleanupOldTaskProgress(): Promise<void> {
  try {
    const { periodStart } = getDailyPeriodBounds();
    // Keep records from the last 7 days for auditing, delete older ones
    const cutoff = new Date(periodStart.getTime() - 7 * 24 * 60 * 60 * 1000);
    const result = await CreatorTaskProgress.deleteMany({
      periodStart: { $lt: cutoff },
    });
    if (result.deletedCount > 0) {
      logInfo('Cleaned up old task progress records', {
        deletedCount: result.deletedCount,
        cutoffDate: cutoff.toISOString(),
      });
    }
  } catch (err) {
    logError('Task progress cleanup failed', err);
  }
}

// Run cleanup every 6 hours
setInterval(cleanupOldTaskProgress, 6 * 60 * 60 * 1000);

// 🔥 FIX: Periodic creator lock cleanup during runtime
// In addition to startup cleanup, run every 5 minutes to release stale locks
setInterval(() => {
  cleanupStaleCreatorLocks().catch((err) => {
    logError('Creator lock cleanup failed', err);
  });
}, 5 * 60 * 1000);

// Process cleanup: do not mass-clear Stream Chat busy flags (deploys would desync presence).
// Stale locks are handled by cleanupStaleCreatorLocks + call reconciliation jobs.
process.on('uncaughtException', async (error) => {
  logError('Uncaught exception - cleaning up and exiting', error);
  await cleanupBillingIntervals().catch(() => {});
  stopReconciliationJob();
  stopBillingWatchdog();
  stopStaffWalletReconciliationScheduler();
  stopDomainEventWorker();
  stopCallReconciliationJob();
  stopPaymentWebhookRetryWorker();
  await stopImagePipelineWorkers().catch(() => {});
  if (eventLoopProbe) {
    clearInterval(eventLoopProbe);
    eventLoopProbe = null;
  }
  process.exit(1);
});

process.on('SIGTERM', async () => {
  logInfo('SIGTERM received — cleaning up', { signal: 'SIGTERM' });
  await cleanupBillingIntervals();
  stopReconciliationJob();
  stopBillingWatchdog();
  stopStaffWalletReconciliationScheduler();
  stopDomainEventWorker();
  stopCallReconciliationJob();
  stopPaymentWebhookRetryWorker();
  await stopImagePipelineWorkers().catch(() => {});
  if (eventLoopProbe) {
    clearInterval(eventLoopProbe);
    eventLoopProbe = null;
  }
  process.exit(0);
});

process.on('SIGINT', async () => {
  logInfo('SIGINT received — cleaning up', { signal: 'SIGINT' });
  await cleanupBillingIntervals();
  stopReconciliationJob();
  stopBillingWatchdog();
  stopStaffWalletReconciliationScheduler();
  stopDomainEventWorker();
  stopCallReconciliationJob();
  stopPaymentWebhookRetryWorker();
  await stopImagePipelineWorkers().catch(() => {});
  if (eventLoopProbe) {
    clearInterval(eventLoopProbe);
    eventLoopProbe = null;
  }
  process.exit(0);
});

startServer();
