import { Server } from 'socket.io';
import { withDistributedLock } from '../../utils/distributed-lock';
import { getBillingInstanceId } from './billing-instance-id';
import { processSettlementRetryQueue } from './billing-session-finalization.service';
import { recordBillingMetric } from '../../utils/monitoring';
import { logError, logInfo } from '../../utils/logger';
import { getBillingBackpressureStage } from './billing-backpressure';

const BILLING_SETTLEMENT_FAST_RETRY_LOCK_KEY = 'billing:settlement-fast-retry:lock';
const FAST_RETRY_LOCK_TTL_MS = 5000;

function readFastRetryIntervalMs(): number {
  const n = parseInt(process.env.BILLING_SETTLEMENT_FAST_RETRY_INTERVAL_MS || '1500', 10);
  if (!Number.isFinite(n)) return 1500;
  return Math.min(10_000, Math.max(500, n));
}

function isFastRetryEnabled(): boolean {
  return process.env.BILLING_SETTLEMENT_FAST_RETRY_ENABLED !== 'false';
}

function readFastRetryBatchSize(): number {
  const stage = getBillingBackpressureStage();
  if (stage >= 3) {
    recordBillingMetric('billing_settlement_fast_retry_paused_backpressure', 1, {
      stage: String(stage),
    });
    return 0;
  }
  if (stage >= 2) {
    return 3;
  }
  return 10;
}

let fastRetryTimer: NodeJS.Timeout | null = null;

export function startSettlementFastRetryWorker(io: Server): void {
  if (!isFastRetryEnabled()) {
    logInfo('Settlement fast retry worker disabled', {});
    return;
  }
  if (fastRetryTimer) {
    return;
  }

  const intervalMs = readFastRetryIntervalMs();
  logInfo('Starting settlement fast retry worker', { intervalMs });

  const run = (): void => {
    void withDistributedLock(
      {
        key: BILLING_SETTLEMENT_FAST_RETRY_LOCK_KEY,
        ttlMs: FAST_RETRY_LOCK_TTL_MS,
        ownerId: getBillingInstanceId(),
        onSkipped: () =>
          recordBillingMetric('billing_settlement_fast_retry_skipped_lock_busy', 1, {}),
      },
      async () => {
        const batchSize = readFastRetryBatchSize();
        if (batchSize <= 0) {
          return;
        }
        await processSettlementRetryQueue(io, batchSize);
      }
    ).catch((err) => {
      logError('Settlement fast retry worker failed', err);
    });
  };

  run();
  fastRetryTimer = setInterval(run, intervalMs);
}

export function stopSettlementFastRetryWorker(): void {
  if (fastRetryTimer) {
    clearInterval(fastRetryTimer);
    fastRetryTimer = null;
    logInfo('Stopped settlement fast retry worker', {});
  }
}
