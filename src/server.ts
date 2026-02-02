import express from 'express';
import http from 'http';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';
dotenv.config();
import { connectDatabase } from './config/database';
import { initializeFirebase } from './config/firebase';
import { initSocket } from './socket';
import routes from './routes';
import { startCallCleanupInterval } from './modules/call/call.cleanup';




const app = express();
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

// Security middleware
app.use(helmet({
  // Allow cleartext traffic for local development
  contentSecurityPolicy: false,
  crossOriginOpenerPolicy: false, // Allow popups for OAuth
}));

// CORS configuration - allow all origins for development
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
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

// Apply status limiter first (more specific)
app.use('/api/v1/calls', statusLimiter);
// Apply general limiter to all other API routes
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

// Health check endpoint
app.get('/health', (_req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    server: 'Eazy Talks Backend',
    version: '1.0.0',
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
    
    // Start call cleanup interval (prevents zombie calls)
    startCallCleanupInterval();
    
    // Create HTTP server (required for Socket.IO)
    const server = http.createServer(app);
    
    // Initialize Socket.IO
    initSocket(server);
    
    // Start server - listen on all interfaces (0.0.0.0) for USB/WiFi debugging
    server.listen(PORT, '0.0.0.0', () => {
      console.log(`🚀 Server running on port ${PORT}`);
      console.log(`📡 Listening on all interfaces (0.0.0.0:${PORT})`);
      console.log(`\n📍 Access URLs:`);
      console.log(`   HTTP:     http://localhost:${PORT}/health`);
      console.log(`   WebSocket: ws://localhost:${PORT}`);
      console.log(`   Network:  http://YOUR_DESKTOP_IP:${PORT}/health`);
      console.log(`\n📱 Frontend Configuration (USB Debugging):`);
      console.log(`   Find your desktop IP: ipconfig (Windows) or ifconfig (Mac/Linux)`);
      console.log(`   Update baseUrl in: frontend/lib/core/constants/app_constants.dart`);
      console.log(`   Example: http://192.168.1.10:${PORT}/api/v1`);
      console.log(`\n✅ Backend is ready to accept connections from your Flutter app`);
      console.log(`💡 Make sure your desktop and phone are on the same WiFi network`);
      console.log(`🔌 Socket.IO is ready for real-time events`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
};

startServer();
