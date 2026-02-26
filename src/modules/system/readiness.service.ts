import mongoose from 'mongoose';
import { getRedis, isRedisConfigured } from '../../config/redis';
import { getRazorpayInstance, isRazorpayConfigured } from '../../config/razorpay';
import { getStreamClient } from '../../config/stream';

type ReadinessState = 'ready' | 'not_ready';

interface DependencyReadiness {
  status: ReadinessState;
  message?: string;
}

export interface ReadinessReport {
  status: ReadinessState;
  timestamp: string;
  dependencies: {
    mongo: DependencyReadiness;
    redis: DependencyReadiness;
    stream: DependencyReadiness;
    razorpay: DependencyReadiness;
  };
}

const asFailure = (error: unknown): DependencyReadiness => ({
  status: 'not_ready',
  message: error instanceof Error ? error.message : 'Unknown error',
});

const checkMongo = async (): Promise<DependencyReadiness> => {
  try {
    if (mongoose.connection.readyState !== 1 || !mongoose.connection.db) {
      return { status: 'not_ready', message: 'MongoDB is not connected' };
    }
    await mongoose.connection.db.admin().ping();
    return { status: 'ready' };
  } catch (error) {
    return asFailure(error);
  }
};

const checkRedis = async (): Promise<DependencyReadiness> => {
  try {
    if (!isRedisConfigured()) {
      return { status: 'not_ready', message: 'Redis env is not configured' };
    }
    const redis = getRedis();
    await redis.ping();
    return { status: 'ready' };
  } catch (error) {
    return asFailure(error);
  }
};

const checkStream = async (): Promise<DependencyReadiness> => {
  try {
    if (!process.env.STREAM_API_KEY || !process.env.STREAM_API_SECRET) {
      return { status: 'not_ready', message: 'Stream env is not configured' };
    }
    const stream = getStreamClient();
    await stream.queryUsers({ id: { $in: [] } }, { id: 1 }, { limit: 1 });
    return { status: 'ready' };
  } catch (error) {
    return asFailure(error);
  }
};

const checkRazorpay = async (): Promise<DependencyReadiness> => {
  try {
    if (!isRazorpayConfigured()) {
      return { status: 'not_ready', message: 'Razorpay env is not configured' };
    }
    const razorpay = getRazorpayInstance();
    await razorpay.orders.all({ count: 1 });
    return { status: 'ready' };
  } catch (error) {
    return asFailure(error);
  }
};

export const getReadinessReport = async (): Promise<ReadinessReport> => {
  const [mongo, redis, stream, razorpay] = await Promise.all([
    checkMongo(),
    checkRedis(),
    checkStream(),
    checkRazorpay(),
  ]);

  const allReady = [mongo, redis, stream, razorpay].every((dependency) => dependency.status === 'ready');

  return {
    status: allReady ? 'ready' : 'not_ready',
    timestamp: new Date().toISOString(),
    dependencies: {
      mongo,
      redis,
      stream,
      razorpay,
    },
  };
};

