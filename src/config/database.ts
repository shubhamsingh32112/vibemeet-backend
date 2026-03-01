import mongoose from 'mongoose';
import { mongoPoolMonitor } from '../utils/mongo-pool-monitor';
import logger, { logInfo, logError } from '../utils/logger';

/**
 * 🔥 FIX 8: MongoDB Connection Pooling Configuration
 *
 * Configures connection pool for optimal performance at scale.
 *
 * Pool size calculation:
 * - Base: 10 connections for general operations
 * - Per concurrent call: 1 connection (for settlement writes)
 * - Target: 1000 concurrent calls = 1010 connections
 * - Max pool size: 1500 (with buffer for spikes)
 *
 * Environment variables:
 * - MONGO_POOL_SIZE: Max pool size (default: 1500)
 * - MONGO_MIN_POOL_SIZE: Min pool size (default: 10)
 */
export const connectDatabase = async (): Promise<void> => {
  const mongoUri = process.env.MONGO_URI;

  if (!mongoUri) {
    throw new Error('MONGO_URI is not defined in environment variables');
  }

  // 🔥 FIX 8: Connection pool configuration
  const poolSize = parseInt(process.env.MONGO_POOL_SIZE || '1500', 10);
  const minPoolSize = parseInt(process.env.MONGO_MIN_POOL_SIZE || '10', 10);
  const maxIdleTimeMS = parseInt(process.env.MONGO_MAX_IDLE_TIME_MS || '30000', 10); // 30 seconds
  const serverSelectionTimeoutMS = parseInt(
    process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS || '5000',
    10
  ); // 5 seconds

  const connectionOptions: mongoose.ConnectOptions = {
    maxPoolSize: poolSize,
    minPoolSize: minPoolSize,
    maxIdleTimeMS: maxIdleTimeMS,
    serverSelectionTimeoutMS: serverSelectionTimeoutMS,
    // Additional optimizations
    socketTimeoutMS: 45000, // 45 seconds
    connectTimeoutMS: 30000, // 30 seconds
    // Retry configuration
    retryWrites: true,
    retryReads: true,
  };

  try {
    await mongoose.connect(mongoUri, connectionOptions);
    logInfo('MongoDB connected successfully', {
      poolSize: `${minPoolSize}-${poolSize}`,
      maxIdleTimeMS,
      serverSelectionTimeoutMS,
    });

    // Event-driven pool monitoring (no polling)
    mongoPoolMonitor.setMaxPoolSize(poolSize);
    mongoPoolMonitor.init();
  } catch (error) {
    logError('MongoDB connection error', error, {
      mongoUri: mongoUri ? 'configured' : 'missing',
    });
    process.exit(1);
  }
};
