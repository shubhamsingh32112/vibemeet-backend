/**
 * MongoDB Connection Pool Monitor (Event-Driven, No Polling)
 *
 * Subscribes to MongoDB driver connection pool events to track:
 * - Checked-out connections (active)
 * - Check-out failures (pool exhaustion)
 * - Pool creation (max pool size)
 *
 * Uses Mongoose connection's underlying MongoClient events.
 * No setInterval or cron - purely event-driven.
 */

import mongoose from 'mongoose';
import { logWarning, logInfo } from './logger';
import { recordAPIMetric } from './monitoring';

export interface MongoPoolStats {
  checkedOut: number;
  checkOutFailedTotal: number;
  maxPoolSize: number;
  utilization: number; // 0-1, checkedOut/maxPoolSize
  lastCheckOutFailedAt?: number;
}

class MongoPoolMonitor {
  private checkedOut = 0;
  private checkOutFailedTotal = 0;
  private maxPoolSize = 1500; // default, updated from connectionPoolCreated
  private lastCheckOutFailedAt: number | undefined;
  private initialized = false;

  /**
   * Set max pool size (e.g. from connection config).
   * Call if connectionPoolCreated event was missed.
   */
  setMaxPoolSize(size: number): void {
    this.maxPoolSize = size;
  }

  /**
   * Initialize event listeners on the MongoClient.
   * Call after mongoose.connect() completes.
   */
  init(): void {
    if (this.initialized) return;

    const conn = mongoose.connection;
    if (conn.readyState !== 1) {
      logWarning('Mongo pool monitor: connection not ready, skipping init', {
        readyState: conn.readyState,
      });
      return;
    }

    const client = conn.getClient();
    if (!client) {
      logWarning('Mongo pool monitor: getClient() returned null');
      return;
    }

    client.on('connectionPoolCreated', (event: { options?: { maxPoolSize?: number } }) => {
      if (event?.options?.maxPoolSize != null) {
        this.maxPoolSize = event.options.maxPoolSize;
        logInfo('Mongo pool monitor initialized', {
          maxPoolSize: this.maxPoolSize,
        });
      }
    });

    client.on('connectionCheckedOut', () => {
      this.checkedOut++;
    });

    client.on('connectionCheckedIn', () => {
      if (this.checkedOut > 0) this.checkedOut--;
    });

    client.on('connectionCheckOutFailed', (event: { reason?: string; address?: string }) => {
      this.checkOutFailedTotal++;
      this.lastCheckOutFailedAt = Date.now();
      recordAPIMetric('mongo_pool_checkout_failed', 1, { reason: event?.reason || 'unknown' });
      logWarning('MongoDB connection pool checkout failed', {
        reason: event?.reason,
        address: event?.address,
        checkedOut: this.checkedOut,
        maxPoolSize: this.maxPoolSize,
        totalFailures: this.checkOutFailedTotal,
      });
    });

    client.on('close', () => {
      this.checkedOut = 0;
      this.initialized = false;
    });

    this.initialized = true;
    logInfo('Mongo pool monitor: event listeners attached');
  }

  /**
   * Get current pool stats (on-demand, no polling).
   */
  getStats(): MongoPoolStats {
    return {
      checkedOut: this.checkedOut,
      checkOutFailedTotal: this.checkOutFailedTotal,
      maxPoolSize: this.maxPoolSize,
      utilization: this.maxPoolSize > 0 ? this.checkedOut / this.maxPoolSize : 0,
      lastCheckOutFailedAt: this.lastCheckOutFailedAt,
    };
  }

  /**
   * Check if pool is under stress (utilization > 80%).
   */
  isUnderStress(): boolean {
    return this.maxPoolSize > 0 && this.checkedOut / this.maxPoolSize > 0.8;
  }

  /**
   * Check if pool is critical (utilization > 95%).
   */
  isCritical(): boolean {
    return this.maxPoolSize > 0 && this.checkedOut / this.maxPoolSize > 0.95;
  }
}

export const mongoPoolMonitor = new MongoPoolMonitor();
