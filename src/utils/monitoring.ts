/**
 * 🔥 FIX 15: Basic Monitoring and Error Tracking
 * 
 * Provides basic metrics collection and error tracking infrastructure.
 * Can be extended with external services (Sentry, DataDog, etc.)
 */

import logger from './logger';
import { getRedis, metricsKey, ERRORS_RECENT_KEY, ERRORS_RECENT_TTL, METRICS_PERSIST_INTERVAL_MS, METRICS_RETENTION_COUNT } from '../config/redis';

interface Metric {
  name: string;
  value: number;
  tags?: Record<string, string>;
  timestamp: number;
}

interface ErrorLog {
  message: string;
  stack?: string;
  context?: Record<string, any>;
  timestamp: number;
  severity: 'error' | 'warning' | 'info';
}

class MonitoringService {
  private metrics: Metric[] = [];
  private errors: ErrorLog[] = [];
  private readonly maxMetrics = 1000;
  private readonly maxErrors = 500;
  private persistInterval: NodeJS.Timeout | null = null;

  /**
   * Record a metric
   */
  recordMetric(name: string, value: number, tags?: Record<string, string>): void {
    const metric: Metric = {
      name,
      value,
      tags,
      timestamp: Date.now(),
    };

    this.metrics.push(metric);

    // Keep only last N metrics
    if (this.metrics.length > this.maxMetrics) {
      this.metrics = this.metrics.slice(-this.maxMetrics);
    }

    // Log important metrics
    if (name.includes('billing') || name.includes('error') || name.includes('timeout')) {
      logger.debug('Metric recorded', { name, value, tags });
    }
  }

  /**
   * Record an error
   */
  recordError(
    message: string,
    error?: Error | unknown,
    context?: Record<string, any>,
    severity: 'error' | 'warning' | 'info' = 'error'
  ): void {
    const errorLog: ErrorLog = {
      message,
      stack: error instanceof Error ? error.stack : undefined,
      context,
      timestamp: Date.now(),
      severity,
    };

    this.errors.push(errorLog);

    // Keep only last N errors
    if (this.errors.length > this.maxErrors) {
      this.errors = this.errors.slice(-this.maxErrors);
    }

    // Log errors using structured logger
    if (severity === 'error') {
      logger.error(message, {
        error: error instanceof Error ? error.message : error,
        stack: error instanceof Error ? error.stack : undefined,
        ...context,
      });
    } else if (severity === 'warning') {
      logger.warn(message, context);
    } else {
      logger.info(message, context);
    }

    // TODO: Send to external service (Sentry, DataDog, etc.)
    // if (process.env.SENTRY_DSN) {
    //   Sentry.captureException(error, { extra: context });
    // }
  }

  /**
   * Get metrics summary
   */
  getMetricsSummary(): {
    total: number;
    byName: Record<string, { count: number; sum: number; avg: number }>;
  } {
    const byName: Record<string, { count: number; sum: number; values: number[] }> = {};

    for (const metric of this.metrics) {
      if (!byName[metric.name]) {
        byName[metric.name] = { count: 0, sum: 0, values: [] };
      }
      byName[metric.name].count++;
      byName[metric.name].sum += metric.value;
      byName[metric.name].values.push(metric.value);
    }

    const summary: Record<string, { count: number; sum: number; avg: number }> = {};
    for (const [name, data] of Object.entries(byName)) {
      summary[name] = {
        count: data.count,
        sum: data.sum,
        avg: data.sum / data.count,
      };
    }

    return {
      total: this.metrics.length,
      byName: summary,
    };
  }

  /**
   * Get recent errors
   */
  getRecentErrors(limit: number = 50): ErrorLog[] {
    return this.errors.slice(-limit);
  }

  /**
   * Get error count by severity
   */
  getErrorCounts(): { error: number; warning: number; info: number } {
    return {
      error: this.errors.filter((e) => e.severity === 'error').length,
      warning: this.errors.filter((e) => e.severity === 'warning').length,
      info: this.errors.filter((e) => e.severity === 'info').length,
    };
  }

  /**
   * Clear all metrics and errors
   */
  clear(): void {
    this.metrics = [];
    this.errors = [];
  }

  /**
   * 🔥 FIX 6: Start persisting metrics to Redis periodically
   */
  startPersistence(): void {
    if (this.persistInterval) {
      return; // Already started
    }

    // Persist immediately
    this.persistToRedis().catch((err) => {
      logger.error('Error in initial metrics persistence', err);
    });

    // Then persist every 30 seconds
    this.persistInterval = setInterval(() => {
      this.persistToRedis().catch((err) => {
        logger.error('Error in scheduled metrics persistence', err);
      });
    }, METRICS_PERSIST_INTERVAL_MS);

    logger.info('Started metrics persistence to Redis', {
      interval: METRICS_PERSIST_INTERVAL_MS,
    });
  }

  /**
   * 🔥 FIX 6: Stop persisting metrics to Redis
   */
  stopPersistence(): void {
    if (this.persistInterval) {
      clearInterval(this.persistInterval);
      this.persistInterval = null;
      logger.info('Stopped metrics persistence to Redis', {});
    }
  }

  /**
   * 🔥 FIX 6: Persist metrics and errors to Redis
   */
  private async persistToRedis(): Promise<void> {
    try {
      const redis = getRedis();
      const now = Date.now();

      // Persist metrics by name (sorted set - score = timestamp)
      const metricsByName: Record<string, Metric[]> = {};
      for (const metric of this.metrics) {
        if (!metricsByName[metric.name]) {
          metricsByName[metric.name] = [];
        }
        metricsByName[metric.name].push(metric);
      }

      // Persist each metric type
      for (const [metricName, metrics] of Object.entries(metricsByName)) {
        const redisKey = metricsKey(metricName);
        
        // Add recent metrics to sorted set
        for (const metric of metrics.slice(-METRICS_RETENTION_COUNT)) {
          await redis.zadd(redisKey, {
            score: metric.timestamp,
            member: JSON.stringify({
              value: metric.value,
              tags: metric.tags,
            }),
          });
        }

        // Keep only last N metrics (remove old ones)
        const count = await redis.zcard(redisKey);
        if (count > METRICS_RETENTION_COUNT) {
          const removeCount = count - METRICS_RETENTION_COUNT;
          await redis.zremrangebyrank(redisKey, 0, removeCount - 1);
        }
      }

      // Persist recent errors to Redis list
      const recentErrors = this.errors.slice(-500); // Last 500 errors
      if (recentErrors.length > 0) {
        const errorsJson = JSON.stringify(recentErrors);
        await redis.set(ERRORS_RECENT_KEY, errorsJson, {
          ex: ERRORS_RECENT_TTL,
        });
      }

      logger.debug('Persisted metrics to Redis', {
        metricTypes: Object.keys(metricsByName).length,
        errorCount: recentErrors.length,
      });
    } catch (error) {
      // Don't throw - persistence failure shouldn't break monitoring
      logger.error('Failed to persist metrics to Redis', error);
    }
  }
}

// Global monitoring instance
export const monitoring = new MonitoringService();

// 🔥 FIX 6: Start persistence on module load (if in production)
if (process.env.NODE_ENV === 'production') {
  monitoring.startPersistence();
}

/**
 * Helper function to record billing metrics
 */
export function recordBillingMetric(metric: string, value: number, tags?: Record<string, string>): void {
  monitoring.recordMetric(`billing.${metric}`, value, tags);
}

/**
 * Helper function to record call metrics
 */
export function recordCallMetric(metric: string, value: number, tags?: Record<string, string>): void {
  monitoring.recordMetric(`call.${metric}`, value, tags);
}

/**
 * Helper function to record API metrics
 */
export function recordAPIMetric(metric: string, value: number, tags?: Record<string, string>): void {
  monitoring.recordMetric(`api.${metric}`, value, tags);
}
