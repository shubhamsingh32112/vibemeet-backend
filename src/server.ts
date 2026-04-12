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
import { connectDatabase } from './config/database';
import { initializeFirebase } from './config/firebase';
import { isRedisConfigured } from './config/redis';
import { configureStreamPush } from './config/stream';
import { setIO } from './config/socket';
import { setupAvailabilityGateway } from './modules/availability/availability.gateway';
import { setupBillingGateway, cleanupBillingIntervals, startGlobalBillingProcessor } from './modules/billing/billing.gateway';
import { startReconciliationJob, stopReconciliationJob } from './modules/billing/billing-reconciliation';
import { verifyStartupRecovery } from './modules/billing/billing-recovery';
import { setupAdminGateway } from './modules/admin/admin.gateway';
import routes from './routes';
import { cleanupStaleCreatorLocks } from './modules/video/video.webhook';
import { startCallReconciliationJob, stopCallReconciliationJob } from './modules/video/call-reconciliation';
import { isRazorpayConfigured } from './config/razorpay';
import { CreatorTaskProgress } from './modules/creator/creator-task.model';
import { getDailyPeriodBounds } from './modules/creator/creator-tasks.config';
import { validatePricingConfig } from './config/pricing.config';
import { logRequest, logError, logWarning, logInfo } from './utils/logger';
import { logRateLimitConfig } from './utils/rate-limit.service';
import { requestQueueMiddleware, getRequestQueueStats } from './middlewares/request-queue.middleware';
import { mongoPoolMonitor } from './utils/mongo-pool-monitor';
import { getDriverMetrics } from './utils/driver-metrics';
import { monitoring, recordAPIMetric } from './utils/monitoring';
import mongoose from 'mongoose';

const app = express();
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

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

function buildCorsOrigin(): boolean | string | RegExp | (string | RegExp)[] {
  const raw = process.env.CORS_ORIGIN;
  if (!raw || raw === '*') {
    if (process.env.NODE_ENV === 'production') {
      logWarning('CORS_ORIGIN is * or unset in production — set explicit origins for web clients', {});
    }
    return '*';
  }
  const parts = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) {
    return '*';
  }
  if (parts.length === 1) {
    return parts[0];
  }
  return parts;
}

app.use(
  cors({
    origin: buildCorsOrigin(),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'X-Requested-With'],
    exposedHeaders: ['Content-Length', 'Content-Type'],
    maxAge: 86400,
  })
);

// Rate limiting
// FIX 3: More lenient limit for status endpoint (polling every 3s = 20/min)
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later.',
});

// Separate limiter for status endpoint (more lenient for polling)
const statusLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 30, // 30 requests per minute (polling every 3s = 20/min, with buffer)
  message: 'Too many status requests, please wait.',
  skip: (req) => {
    // Only apply to status endpoint
    return !req.path.includes('/status');
  },
});

// Apply general limiter to all API routes
app.use('/api/', generalLimiter);
// Apply stricter limiter specifically for status endpoints.
app.use('/api/', statusLimiter);

// Compression - gzip responses for scalability (reduces bandwidth)
app.use(compression());

/** Stream Video webhooks must use the raw request bytes for HMAC (see webhook-signature.middleware). */
function isStreamVideoWebhookPost(req: Request): boolean {
  if (req.method !== 'POST') return false;
  const pathOnly = req.originalUrl.split('?')[0];
  return pathOnly === '/api/v1/video/webhook';
}

const jsonParser = express.json({ limit: '50mb' });
const urlEncodedParser = express.urlencoded({ extended: true, limit: '50mb' });

app.use((req, res, next) => {
  if (isStreamVideoWebhookPost(req)) {
    return express.raw({ type: '*/*', limit: '2mb' })(req, res, next);
  }
  next();
});

app.use((req, res, next) => {
  if (isStreamVideoWebhookPost(req)) {
    return next();
  }
  jsonParser(req, res, next);
});

app.use((req, res, next) => {
  if (isStreamVideoWebhookPost(req)) {
    return next();
  }
  urlEncodedParser(req, res, next);
});

// Request logging middleware
app.use((req, _res, next) => {
  logRequest(req.method, req.path, req.ip || 'unknown-ip', {
    fullUrl: `${req.protocol}://${req.get('host') ?? 'unknown-host'}${req.originalUrl}`,
    hasAuth: !!req.headers.authorization,
    authHeaderPrefix: req.headers.authorization ? req.headers.authorization.substring(0, 20) : undefined,
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
app.get('/metrics', (req, res) => {
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
    const apiSummary = monitoring.getMetricsSummary().byName['api.latency_ms'];
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
        http5xxSamples: monitoring.getMetricsSummary().byName['api.http_5xx']?.count ?? 0,
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
app.use((req, res) => {
  logWarning('Route not found', {
    method: req.method,
    path: req.path,
    fullUrl: `${req.protocol}://${req.get('host') ?? 'unknown-host'}${req.originalUrl}`,
    ip: req.ip,
  });
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

const startServer = async () => {
  try {
    // Initialize Firebase Admin
    initializeFirebase();

    assertProductionSecurity();
    
    // 🔥 FIX 12: Validate pricing configuration on startup
    validatePricingConfig();
    
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
        const redisUrl = process.env.REDIS_URL || process.env.REDIS_PUBLIC_URL;
        let pubClient: Redis | null = null;
        if (redisUrl) {
          pubClient = new Redis(redisUrl, {
            maxRetriesPerRequest: 20,
            enableReadyCheck: true,
          });
        } else if (process.env.REDISHOST) {
          pubClient = new Redis({
            host: process.env.REDISHOST,
            port: parseInt(process.env.REDISPORT || '6379', 10),
            password: process.env.REDIS_PASSWORD || process.env.REDISPASSWORD,
            username: process.env.REDISUSER,
            maxRetriesPerRequest: 20,
            enableReadyCheck: true,
          });
        }
        if (pubClient) {
          const subClient = pubClient.duplicate();
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
    // 🔥 FIX 5: Start reconciliation job for error recovery
    startReconciliationJob(io);
    logInfo('Global billing batch processor started');
    
    // 🔥 FIX: Verify startup recovery for active calls
    verifyStartupRecovery(io).catch((err) => {
      logError('Startup recovery verification failed', err);
    });

    // 🔥 NEW: Start periodic call reconciliation against Stream
    startCallReconciliationJob(io);

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
        // Optionally: throw error to prevent server start
        // throw new Error('Redis connection required for billing');
      }
    } else {
      logError('CRITICAL: Redis not configured', {
        alert: true,
        impact: 'Billing will not work - coins will not be deducted, creators will not earn',
        requiredEnvVars: ['REDIS_URL', 'REDIS_PUBLIC_URL', 'REDISHOST'],
      });
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
  stopCallReconciliationJob();
  process.exit(1);
});

process.on('SIGTERM', async () => {
  logInfo('SIGTERM received — cleaning up', { signal: 'SIGTERM' });
  await cleanupBillingIntervals();
  stopReconciliationJob();
  stopCallReconciliationJob();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logInfo('SIGINT received — cleaning up', { signal: 'SIGINT' });
  await cleanupBillingIntervals();
  stopReconciliationJob();
  stopCallReconciliationJob();
  process.exit(0);
});

startServer();
