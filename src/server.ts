import './bootstrap/load-env';
import express, { type Request } from 'express';
import compression from 'compression';
import { createServer } from 'http';
import { bootstrapCore } from './bootstrap/bootstrap-core';
import { buildSocketCorsOrigin, initializeSocketIo } from './bootstrap/bootstrap-socket';
import { bootstrapApiWs } from './bootstrap/bootstrap-api-ws';
import { bootstrapBillingWorkers } from './bootstrap/bootstrap-billing-workers';
import { bootstrapMomentsWorkers } from './bootstrap/bootstrap-moments-workers';
import { bootstrapImageWorkers } from './bootstrap/bootstrap-image-workers';
import {
  createWorkerHealthServer,
  listenWorkerHealthServer,
} from './bootstrap/bootstrap-worker-health';
import { registerShutdownHandlers, registerRuntimeServers } from './bootstrap/bootstrap-shutdown';
import { registerHealthRoutes } from './bootstrap/health-routes';
import { registerMetricsRoute } from './bootstrap/metrics-handler';
import {
  getServiceRole,
  runsHttpApi,
  runsBillingWorkers,
  runsMomentsWorkers,
  runsImageWorkers,
  runsApiHygieneIntervals,
} from './config/service-role';
import { createStaffGeneralLimiter } from './middlewares/rate-limit.middleware';
import { attachFirebaseRateLimitIdentity } from './middlewares/firebase-rate-limit.middleware';
import { attachStaffRateLimitIdentity } from './middlewares/staff-rate-limit.middleware';
import routes from './routes';
import { cleanupStaleCreatorLocks } from './modules/video/video.webhook';
import { CreatorTaskProgress } from './modules/creator/creator-task.model';
import { getDailyPeriodBounds } from './modules/creator/creator-tasks.config';
import { logRequest, logError, logWarning, logInfo } from './utils/logger';
import { requestContextMiddleware } from './middlewares/request-context.middleware';
import { requestQueueMiddleware } from './middlewares/request-queue.middleware';
import { recordAPIMetric } from './utils/monitoring';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';

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

function isStaffDashboardRequest(req: Request): boolean {
  const pathOnly = req.originalUrl.split('?')[0];
  return pathOnly.includes('/admin/dashboard/');
}

function shouldSkipGeneralRateLimit(req: Request): boolean {
  if (rateLimitDisabledInDev) return true;
  // Emulator + adb reverse share the host loopback IP; 100/15min is too low for dev.
  if (isDev && isLoopbackClient(req)) return true;
  // Staff dashboard BFF: many parallel widget fetches; route auth still required.
  if (req.staffRateLimit?.userId && isStaffDashboardRequest(req)) return true;
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
    pathOnly === '/api/v1/payment/webhook' ||
    pathOnly === '/api/v1/stream/webhook' ||
    pathOnly === '/api/v1/vip/webhook'
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

registerMetricsRoute(app);
registerHealthRoutes(app);

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
const startServer = async () => {
  try {
    const role = getServiceRole();
    await bootstrapCore();

    let httpServer;
    let io: import('socket.io').Server | null = null;

    if (runsHttpApi()) {
      httpServer = createServer(app);
      io = initializeSocketIo(httpServer, buildSocketCorsOrigin());
      bootstrapApiWs(io);
    } else if (runsBillingWorkers()) {
      const worker = createWorkerHealthServer({
        includeMetrics: true,
        headlessSocket: true,
      });
      httpServer = worker.httpServer;
      io = worker.io;
    } else {
      const worker = createWorkerHealthServer();
      httpServer = worker.httpServer;
    }

    if (runsBillingWorkers() && io) {
      bootstrapBillingWorkers(io);
    }
    if (runsMomentsWorkers()) {
      bootstrapMomentsWorkers();
    }
    if (runsImageWorkers()) {
      await bootstrapImageWorkers();
    }

    registerRuntimeServers(httpServer, io);

    const onListen = () => {
      logInfo('Server started successfully', {
        port: PORT,
        interface: '0.0.0.0',
        serviceRole: role,
        environment: process.env.NODE_ENV || 'development',
        urls: runsHttpApi()
          ? {
              http: `http://localhost:${PORT}/health`,
              socket: `ws://localhost:${PORT}`,
              network: `http://YOUR_DESKTOP_IP:${PORT}/health`,
            }
          : {
              health: `http://localhost:${PORT}/health`,
              ready: `http://localhost:${PORT}/ready`,
            },
        frontendConfig: runsHttpApi()
          ? {
              instruction: 'Find your desktop IP: ipconfig (Windows) or ifconfig (Mac/Linux)',
              configFile: 'frontend/lib/core/constants/app_constants.dart',
              example: `http://192.168.1.10:${PORT}/api/v1`,
            }
          : undefined,
      });
    };

    if (runsHttpApi()) {
      httpServer.listen(PORT, '0.0.0.0', onListen);
    } else {
      await listenWorkerHealthServer(httpServer, PORT);
      onListen();
    }
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

// Run cleanup every 6 hours (api-ws / monolith only)
if (runsApiHygieneIntervals()) {
  setInterval(cleanupOldTaskProgress, 6 * 60 * 60 * 1000);

  setInterval(() => {
    cleanupStaleCreatorLocks().catch((err) => {
      logError('Creator lock cleanup failed', err);
    });
  }, 5 * 60 * 1000);
}

registerShutdownHandlers();

startServer();
