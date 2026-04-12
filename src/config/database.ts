import mongoose from 'mongoose';
import { mongoPoolMonitor } from '../utils/mongo-pool-monitor';
import { bumpMongoConnectionError } from '../utils/driver-metrics';
import { logInfo, logError } from '../utils/logger';

/**
 * MongoDB connection pool — keep **per-process** maxPoolSize modest.
 *
 * A very large default (e.g. 1500) × N Railway replicas can exceed Atlas
 * connection limits and cause cascading failures (refused connections, churn).
 * Scale **out** replicas and/or raise Atlas limits; tune `MONGO_POOL_SIZE` per instance.
 *
 * Environment variables:
 * - MONGO_POOL_SIZE: Max pool size (default: 50)
 * - MONGO_MIN_POOL_SIZE: Min pool size (default: 5)
 */
export const connectDatabase = async (): Promise<void> => {
  const mongoUri = process.env.MONGO_URI;

  if (!mongoUri) {
    throw new Error('MONGO_URI is not defined in environment variables');
  }

  const poolSize = parseInt(process.env.MONGO_POOL_SIZE || '50', 10);
  const minPoolSize = parseInt(process.env.MONGO_MIN_POOL_SIZE || '5', 10);
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

    mongoose.connection.on('error', (err) => {
      bumpMongoConnectionError();
      logError('MongoDB connection error (driver event)', err, { alert: true });
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
