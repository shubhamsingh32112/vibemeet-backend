import express from 'express';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';
dotenv.config();
import { connectDatabase } from './config/database';
import { validateRuntimeEnv } from './config/env';
import { initializeFirebase } from './config/firebase';
import { isRedisConfigured } from './config/redis';
import { configureStreamPush } from './config/stream';
import { setIO } from './config/socket';
import { withRequestContext } from './middlewares/request-context.middleware';
import { setupAvailabilityGateway } from './modules/availability/availability.gateway';
import { setupBillingGateway, cleanupBillingIntervals } from './modules/billing/billing.gateway';
import { setupAdminGateway } from './modules/admin/admin.gateway';
import { getReadinessReport } from './modules/system/readiness.service';
import { runSourceOfTruthReconciliation } from './modules/system/source-of-truth.service';
import routes from './routes';
import { clearAllCreatorBusyStates } from './modules/video/video.webhook';
import { isRazorpayConfigured } from './config/razorpay';
import { CreatorTaskProgress } from './modules/creator/creator-task.model';
import { getDailyPeriodBounds } from './modules/creator/creator-tasks.config';
import { logger } from './utils/logger';
import { featureFlags } from './config/feature-flags';

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

// Correlation and request logging middleware
app.use(withRequestContext);
app.use((req, res, next) => {
  const start = Date.now();
  logger.info('http.request.received', {
    method: req.method,
    path: req.path,
    ip: req.ip,
    hasAuthorizationHeader: Boolean(req.headers.authorization),
  });

  res.on('finish', () => {
    logger.info('http.request.completed', {
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      durationMs: Date.now() - start,
    });
  });

  next();
});

// Health check endpoint - CRITICAL for connectivity testing
// Returns HTTP 200 with server status
// Test URL: http://YOUR_IP:3000/health
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

app.get('/readiness', async (_req, res) => {
  const readiness = await getReadinessReport();
  res.status(readiness.status === 'ready' ? 200 : 503).json(readiness);
});

// API routes
app.use('/api/v1', routes);

// 404 handler
app.use((req, res) => {
  logger.warn('http.route.not_found', {
    method: req.method,
    path: req.path,
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
  logger.error('http.unhandled_error', {
    message: err.message,
    stack: err.stack,
  });
  res.status(500).json({
    success: false,
    error: 'Internal server error',
  });
});

// Initialize services and start server
const startServer = async () => {
  try {
    validateRuntimeEnv();

    // Initialize Firebase Admin
    initializeFirebase();
    
    // Connect to MongoDB
    await connectDatabase();

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
        logger.info('migration.creator_task_progress.drop_old_index');
        await collection.dropIndex(oldIndex.name!);
        logger.info('migration.creator_task_progress.old_index_dropped');
      }
    } catch (migrationErr) {
      // Ignore if collection doesn't exist yet or index already dropped
      logger.info('migration.creator_task_progress.index_check_skipped', {
        message: (migrationErr as Error).message,
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
    logger.info('socket.gateway.availability.ready');

    setupBillingGateway(io);
    logger.info('socket.gateway.billing.ready');

    setupAdminGateway(io);
    logger.info('socket.gateway.admin.ready');
    
    // 🔴 Check Redis configuration (Upstash - serverless, no init needed)
    if (isRedisConfigured()) {
      logger.info('dependencies.redis.configured');
    } else {
      logger.warn('dependencies.redis.not_configured');
    }

    // 💳 Check Razorpay configuration
    if (isRazorpayConfigured()) {
      logger.info('dependencies.razorpay.configured');
    } else {
      logger.warn('dependencies.razorpay.not_configured');
    }
    
    // Start server - listen on all interfaces (0.0.0.0) for USB/WiFi debugging
    httpServer.listen(PORT, '0.0.0.0', () => {
      logger.info('server.started', {
        port: PORT,
        bind: `0.0.0.0:${PORT}`,
        healthUrl: `http://localhost:${PORT}/health`,
        readinessUrl: `http://localhost:${PORT}/readiness`,
      });
    });
  } catch (error) {
    logger.error('server.start_failed', { error });
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
      logger.info('tasks.cleanup.completed', {
        deletedCount: result.deletedCount,
        cutoff: cutoff.toISOString(),
      });
    }
  } catch (err) {
    logger.error('tasks.cleanup.failed', { err });
  }
}

// Run cleanup every 6 hours
setInterval(cleanupOldTaskProgress, 6 * 60 * 60 * 1000);

// Process cleanup handlers - clear stuck busy states on crash/redeploy
process.on('uncaughtException', async (error) => {
  logger.error('process.uncaught_exception', { error });
  await clearAllCreatorBusyStates();
  process.exit(1);
});

process.on('SIGTERM', async () => {
  logger.warn('process.sigterm');
  await clearAllCreatorBusyStates();
  cleanupBillingIntervals();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.warn('process.sigint');
  await clearAllCreatorBusyStates();
  cleanupBillingIntervals();
  process.exit(0);
});

startServer();

// ── Source-of-truth reconciliation scheduler (Phase 4) ──────────────────
// Runs in shadow/repair mode based on feature flags.
setInterval(() => {
  if (!featureFlags.sourceOfTruthReconciliationEnabled) return;
  runSourceOfTruthReconciliation('scheduled').catch((error) => {
    logger.warn('sot.reconciliation.scheduler_failed', { error });
  });
}, 5 * 60 * 1000);
