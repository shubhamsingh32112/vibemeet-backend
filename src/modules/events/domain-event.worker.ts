import { DOMAIN_EVENT_WORKER_LOCK_KEY } from '../../config/redis';
import { withDistributedLock } from '../../utils/distributed-lock';
import { getBillingInstanceId } from '../billing/billing-instance-id';
import { logError } from '../../utils/logger';
import { getDomainEventStats, processPendingDomainEvents } from './domain-event.service';

let timer: NodeJS.Timeout | null = null;
let lastProcessAt: Date | null = null;
let lastProcessedCount = 0;

export function startDomainEventWorker(): void {
  if (process.env.DOMAIN_EVENTS_ENABLED !== 'true') return;
  if (timer) return;

  const intervalMs = parseInt(process.env.DOMAIN_EVENT_WORKER_INTERVAL_MS ?? '5000', 10) || 5000;

  const lockTtlMs = Math.max(intervalMs * 3, 15_000);

  timer = setInterval(() => {
    withDistributedLock(
      {
        key: DOMAIN_EVENT_WORKER_LOCK_KEY,
        ttlMs: lockTtlMs,
        ownerId: getBillingInstanceId(),
        heartbeat: true,
      },
      async () => {
        const n = await processPendingDomainEvents(50);
        lastProcessedCount = n;
        lastProcessAt = new Date();
      }
    ).catch((e) =>
      logError('Domain event worker tick failed', e instanceof Error ? e : new Error(String(e)))
    );
  }, intervalMs);
}

export function stopDomainEventWorker(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

export function getDomainEventWorkerSnapshot(): {
  lastTickAt: string | null;
  lastProcessedBatchCount: number;
} {
  return {
    lastTickAt: lastProcessAt?.toISOString() ?? null,
    lastProcessedBatchCount: lastProcessedCount,
  };
}

export async function getDomainEventWorkerStatsExtended(): Promise<
  Awaited<ReturnType<typeof getDomainEventStats>> & {
    lastTickAt: string | null;
    lastProcessedBatchCount: number;
  }
> {
  const snap = getDomainEventWorkerSnapshot();
  const stats = await getDomainEventStats();
  return { ...stats, ...snap };
}
