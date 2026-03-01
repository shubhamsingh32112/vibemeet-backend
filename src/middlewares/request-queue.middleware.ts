/**
 * Request Queuing & Backpressure Middleware
 *
 * Limits concurrent API requests to prevent overload.
 * When limit is reached, new requests wait (with timeout) instead of being rejected immediately.
 * Health/live/ready endpoints bypass the queue.
 *
 * No polling - uses in-memory semaphore with async wait.
 */

import { Request, Response, NextFunction } from 'express';
import { logWarning } from '../utils/logger';
import { recordAPIMetric } from '../utils/monitoring';

const DEFAULT_MAX_CONCURRENT = parseInt(process.env.REQUEST_QUEUE_MAX_CONCURRENT || '500', 10);
const DEFAULT_WAIT_TIMEOUT_MS = parseInt(process.env.REQUEST_QUEUE_WAIT_TIMEOUT_MS || '30000', 10);

/** Paths that bypass the queue (always processed immediately) */
const BYPASS_PATHS = ['/health', '/live', '/ready', '/metrics'];

function shouldBypass(req: Request): boolean {
  const path = req.originalUrl?.split('?')[0] ?? req.path;
  return BYPASS_PATHS.some((p) => path === p || path.endsWith(p));
}

interface WaitEntry {
  resolve: () => void;
  timeoutId: NodeJS.Timeout;
}

class RequestQueue {
  private activeCount = 0;
  private waitQueue: WaitEntry[] = [];
  private readonly maxConcurrent: number;
  private readonly waitTimeoutMs: number;
  private rejectedCount = 0;

  constructor(maxConcurrent: number, waitTimeoutMs: number) {
    this.maxConcurrent = maxConcurrent;
    this.waitTimeoutMs = waitTimeoutMs;
  }

  async acquire(req: Request): Promise<boolean> {
    if (shouldBypass(req)) return true;

    if (this.activeCount < this.maxConcurrent) {
      this.activeCount++;
      return true;
    }

    return new Promise<boolean>((resolve) => {
      const timeoutId = setTimeout(() => {
        const idx = this.waitQueue.findIndex((e) => e.timeoutId === timeoutId);
        if (idx >= 0) {
          this.waitQueue.splice(idx, 1);
        }
        this.rejectedCount++;
        recordAPIMetric('request_queue_timeout', 1);
        resolve(false);
      }, this.waitTimeoutMs);

      this.waitQueue.push({
        resolve: () => {
          clearTimeout(timeoutId);
          this.activeCount++;
          resolve(true);
        },
        timeoutId,
      });
    });
  }

  release(req: Request): void {
    if (shouldBypass(req)) return;

    this.activeCount--;
    if (this.activeCount < 0) this.activeCount = 0;

    if (this.waitQueue.length > 0 && this.activeCount < this.maxConcurrent) {
      const next = this.waitQueue.shift()!;
      next.resolve();
    }
  }

  getStats(): { active: number; waiting: number; rejected: number } {
    return {
      active: this.activeCount,
      waiting: this.waitQueue.length,
      rejected: this.rejectedCount,
    };
  }
}

const requestQueue = new RequestQueue(DEFAULT_MAX_CONCURRENT, DEFAULT_WAIT_TIMEOUT_MS);

/**
 * Middleware: Queue requests with backpressure.
 * Returns 503 if wait timeout is exceeded.
 */
export function requestQueueMiddleware(req: Request, res: Response, next: NextFunction): void {
  requestQueue.acquire(req).then((acquired) => {
    if (!acquired) {
      logWarning('Request queue timeout - rejecting', {
        path: req.originalUrl,
        method: req.method,
      });
      res.status(503).json({
        success: false,
        error: 'Service temporarily overloaded. Please try again.',
      });
      return;
    }

    let released = false;
    const release = () => {
      if (!released) {
        released = true;
        requestQueue.release(req);
      }
    };
    res.on('finish', release);
    res.on('close', release);

    next();
  });
}

export function getRequestQueueStats() {
  return requestQueue.getStats();
}
