import express from 'express';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
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
import { clearAllCreatorBusyStates, cleanupStaleCreatorLocks } from './modules/video/video.webhook';
import { startCallReconciliationJob, stopCallReconciliationJob } from './modules/video/call-reconciliation';
import { isRazorpayConfigured } from './config/razorpay';
import { CreatorTaskProgress } from './modules/creator/creator-task.model';
import { getDailyPeriodBounds } from './modules/creator/creator-tasks.config';
import { validatePricingConfig } from './config/pricing.config';
import { logRequest, logError, logWarning, logInfo } from './utils/logger';
import { logRateLimitConfig } from './utils/rate-limit.service';
import { requestQueueMiddleware, getRequestQueueStats } from './middlewares/request-queue.middleware';
import { mongoPoolMonitor } from './utils/mongo-pool-monitor';
import mongoose from 'mongoose';

const app = express();
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

// Security middleware
app.use(helmet({
  // Allow cleartext traffic for local development
  contentSecurityPolicy: false,
  crossOriginOpenerPolicy: false, // Allow popups for OAuth
}));

// CORS configuration - allow all origins for development
// CRITICAL: Must allow mobile devices to connect
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*', // Allow all origins for local dev
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'X-Requested-With'],
  exposedHeaders: ['Content-Length', 'Content-Type'],
  maxAge: 86400, // 24 hours
}));

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

// Body parsing middleware - increase limit for base64 images
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

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

// Metrics endpoint (on-demand, no polling)
app.get('/metrics', (_req, res) => {
  try {
    const mongoStats = mongoPoolMonitor.getStats();
    const queueStats = getRequestQueueStats();
    res.status(200).json({
      mongo: {
        activeConnections: mongoStats.checkedOut,
        maxConnections: mongoStats.maxPoolSize,
        poolUtilization: Math.round(mongoStats.utilization * 100) / 100,
        checkOutFailedTotal: mongoStats.checkOutFailedTotal,
        lastCheckOutFailedAt: mongoStats.lastCheckOutFailedAt,
      },
      requestQueue: {
        active: queueStats.active,
        waiting: queueStats.waiting,
        rejected: queueStats.rejected,
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

  // Redis readiness (configuration + simple ping)
  try {
    if (!isRedisConfigured()) {
      checks.redis = { ok: false, error: 'not_configured' };
    } else {
      const { getRedis } = await import('./config/redis');
      const redis = getRedis();
      await redis.setex('healthcheck:ready', 30, Date.now().toString());
      checks.redis = { ok: true };
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
const startServer = async () => {
  try {
    // Initialize Firebase Admin
    initializeFirebase();
    
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
    
    // Create HTTP server and attach Socket.IO
    const httpServer = createServer(app);
    const io = new SocketIOServer(httpServer, {
      cors: {
        origin: process.env.CORS_ORIGIN || '*',
        methods: ['GET', 'POST'],
      },
      pingTimeout: 60000,
      pingInterval: 25000,
      transports: ['websocket', 'polling'],
    });

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
    
    // 🔴 Check Redis configuration (Railway Redis)
    if (isRedisConfigured()) {
      logInfo('Railway Redis configured');
    } else {
      logWarning('Railway Redis NOT configured - availability will fail', {
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

// Process cleanup handlers - clear stuck busy states on crash/redeploy
process.on('uncaughtException', async (error) => {
  logError('Uncaught exception - cleaning up and exiting', error);
  await clearAllCreatorBusyStates();
  process.exit(1);
});

process.on('SIGTERM', async () => {
  logInfo('SIGTERM received — cleaning up', { signal: 'SIGTERM' });
  await clearAllCreatorBusyStates();
  cleanupBillingIntervals();
  // 🔥 FIX 5: Stop reconciliation job
  stopReconciliationJob();
  stopCallReconciliationJob();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logInfo('SIGINT received — cleaning up', { signal: 'SIGINT' });
  await clearAllCreatorBusyStates();
  cleanupBillingIntervals();
  // 🔥 FIX 5: Stop reconciliation job
  stopReconciliationJob();
  stopCallReconciliationJob();
  process.exit(0);
});

startServer();
