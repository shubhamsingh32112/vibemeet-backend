import { Server } from 'socket.io';
import { recordBillingMetric } from '../../utils/monitoring';
import { logError, logWarning, logInfo } from '../../utils/logger';
import {
  isBullmqBillingEnabled,
  startBillingBullWorker,
} from './billing.queue';

let globalBillingProcessor: NodeJS.Timeout | null = null;

/**
 * Single global billing processor that processes all active calls in batches.
 * Multi-instance safe: each call is processed under a short per-call Redis lock
 * inside BillingService.
 */
export async function processBillingBatch(io: Server): Promise<void> {
  void io;
  // ZSET batch mode retired: BullMQ worker is authoritative.
  recordBillingMetric('batch_processor_noop', 1, { reason: 'bullmq_only' });
}

export function startGlobalBillingProcessor(io: Server): void {
  if (isBullmqBillingEnabled()) {
    try {
      const worker = startBillingBullWorker();
      if (worker) {
        logInfo('Global billing processor delegated to BullMQ worker', {
          driver: 'bullmq',
        });
      }
    } catch (err) {
      logError('Failed to start BullMQ billing worker', err, { driver: 'bullmq' });
      throw err;
    }
    return;
  }

  if (globalBillingProcessor) {
    logWarning('Global billing processor already running', {});
    return;
  }

  logInfo('Starting global billing batch processor', {
    interval: 'retired',
    batchSize: 'retired',
    adaptiveLagPolicyEnabled: false,
  });
  void io;
}

export function stopGlobalBillingProcessor(): void {
  if (globalBillingProcessor) {
    clearInterval(globalBillingProcessor);
    globalBillingProcessor = null;
    logInfo('Stopped global billing batch processor', {});
  }
}
