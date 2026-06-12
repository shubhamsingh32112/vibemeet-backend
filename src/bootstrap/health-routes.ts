import type { Express } from 'express';
import mongoose from 'mongoose';
import { isRedisConfigured } from '../config/redis';
import { getServiceRole } from '../config/service-role';
import { isShuttingDown } from '../modules/billing/billing-shutdown.service';

export function registerHealthRoutes(app: Express): void {
  app.get('/health', (_req, res) => {
    res.status(200).json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      server: 'Eazy Talks Backend',
      version: '1.0.0',
      uptime: process.uptime(),
      environment: process.env.NODE_ENV || 'development',
      serviceRole: getServiceRole(),
      redis: {
        configured: isRedisConfigured(),
        note: 'Use GET /ready for write/read probe',
      },
    });
  });

  app.get('/live', (_req, res) => {
    res.status(200).json({
      status: 'live',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      serviceRole: getServiceRole(),
    });
  });

  app.get('/ready', async (_req, res) => {
    const checks: Record<string, { ok: boolean; error?: string }> = {};

    if (isShuttingDown()) {
      checks.shutdown = { ok: false, error: 'draining' };
    }

    try {
      if (!mongoose.connection || mongoose.connection.readyState === undefined) {
        checks.mongo = { ok: false, error: 'mongoose_not_initialized' };
      } else {
        const state = mongoose.connection.readyState;
        checks.mongo = {
          ok: state === 1,
          error: state === 1 ? undefined : `mongo_state_${state}`,
        };
      }
    } catch (err: unknown) {
      checks.mongo = {
        ok: false,
        error: err instanceof Error ? err.message : 'mongo_check_failed',
      };
    }

    try {
      if (!isRedisConfigured()) {
        checks.redis = { ok: false, error: 'not_configured' };
      } else {
        const { getRedis } = await import('../config/redis');
        const redis = getRedis();
        const testKey = `healthcheck:ready:${Date.now()}`;
        await redis.setex(testKey, 10, 'test');
        const value = await redis.get(testKey);
        await redis.del(testKey);
        checks.redis = {
          ok: value === 'test',
          error: value === 'test' ? undefined : 'read_write_test_failed',
        };
      }
    } catch (err: unknown) {
      checks.redis = {
        ok: false,
        error: err instanceof Error ? err.message : 'redis_check_failed',
      };
    }

    const allOk = Object.values(checks).every((c) => c.ok);
    res.status(allOk ? 200 : 503).json({
      status: allOk ? 'ready' : 'degraded',
      timestamp: new Date().toISOString(),
      serviceRole: getServiceRole(),
      checks,
    });
  });
}
