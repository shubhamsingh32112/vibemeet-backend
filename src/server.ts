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
import routes from './routes';
import { clearAllCreatorBusyStates } from './modules/video/video.webhook';
import { registerAvailabilitySocket } from './modules/availability/availability.socket';




const app = express();
const httpServer = createServer(app);
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

// Initialize Socket.IO with CORS for Flutter clients
const io = new SocketIOServer(httpServer, {
  cors: {
    origin: '*', // Allow all origins for mobile clients
    methods: ['GET', 'POST'],
    credentials: true,
  },
  // Connection settings for mobile clients
  pingTimeout: 60000,
  pingInterval: 25000,
  transports: ['websocket', 'polling'], // Prefer WebSocket, fallback to polling
});

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

// Body parsing middleware - increase limit for base64 images
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Request logging middleware
app.use((req, _res, next) => {
  console.log(`📥 ${req.method} ${req.path} from ${req.ip}`);
  console.log(`   Full URL: ${req.protocol}://${req.get('host')}${req.originalUrl}`);
  if (req.headers.authorization) {
    console.log(`   Auth header present: ${req.headers.authorization.substring(0, 20)}...`);
  } else {
    console.log(`   ⚠️  No auth header`);
  }
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

// API routes
app.use('/api/v1', routes);

// 404 handler
app.use((req, res) => {
  console.log(`❌ [404] Route not found: ${req.method} ${req.path}`);
  console.log(`   Full URL: ${req.protocol}://${req.get('host')}${req.originalUrl}`);
  res.status(404).json({
    success: false,
    error: 'Route not found',
    path: req.path,
    method: req.method,
  });
});

// Error handling middleware
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('Unhandled error:', err);
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
    
    // Connect to MongoDB
    await connectDatabase();
    
    // 🔴 Check Redis configuration (Upstash - serverless, no init needed)
    if (isRedisConfigured()) {
      console.log('✅ [REDIS] Upstash Redis configured');
    } else {
      console.warn('⚠️  [REDIS] Upstash Redis NOT configured - availability will fail');
      console.warn('   Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN env vars');
    }
    
    // 🔌 Register Socket.IO availability handlers
    // This is the SINGLE SOURCE OF TRUTH for creator availability
    registerAvailabilitySocket(io);
    console.log('🔌 [SOCKET.IO] Availability socket handlers registered');
    
    // Start server - listen on all interfaces (0.0.0.0) for USB/WiFi debugging
    httpServer.listen(PORT, '0.0.0.0', () => {
      console.log(`🚀 Server running on port ${PORT}`);
      console.log(`📡 Listening on all interfaces (0.0.0.0:${PORT})`);
      console.log(`🔌 Socket.IO ready on same port`);
      console.log(`\n📍 Access URLs:`);
      console.log(`   HTTP:     http://localhost:${PORT}/health`);
      console.log(`   Socket:   ws://localhost:${PORT}`);
      console.log(`   Network:  http://YOUR_DESKTOP_IP:${PORT}/health`);
      console.log(`\n📱 Frontend Configuration (USB Debugging):`);
      console.log(`   Find your desktop IP: ipconfig (Windows) or ifconfig (Mac/Linux)`);
      console.log(`   Update baseUrl in: frontend/lib/core/constants/app_constants.dart`);
      console.log(`   Example: http://192.168.1.10:${PORT}/api/v1`);
      console.log(`\n✅ Backend is ready to accept connections from your Flutter app`);
      console.log(`💡 Make sure your desktop and phone are on the same WiFi network`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
};

// Process cleanup handlers - clear stuck busy states on crash/redeploy
// Note: Redis (Upstash) is stateless HTTP - no connection to close
// Note: Redis TTL (120s) handles ghost online users automatically
process.on('uncaughtException', async (error) => {
  console.error('🚨 [PROCESS] Uncaught exception:', error);
  await clearAllCreatorBusyStates();
  process.exit(1);
});

process.on('SIGTERM', async () => {
  console.log('🛑 [PROCESS] SIGTERM received - clearing Stream busy states');
  await clearAllCreatorBusyStates();
  // Redis availability persists (that's the point - survives restarts)
  // TTL handles cleanup automatically
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('🛑 [PROCESS] SIGINT received - clearing Stream busy states');
  await clearAllCreatorBusyStates();
  // Redis availability persists (that's the point)
  process.exit(0);
});

startServer();
