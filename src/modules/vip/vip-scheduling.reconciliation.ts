import { getIO } from '../../config/socket';
import { featureFlags } from '../../config/feature-flags';
import { VIP_RECONCILIATION_LOCK_KEY } from '../../config/redis';
import { logInfo } from '../../utils/logger';
import { withDistributedLock } from '../../utils/distributed-lock';
import { getBillingInstanceId } from '../billing/billing-instance-id';
import { ScheduledCall } from './models/scheduled-call.model';
import { expireStaleQueueEntries } from './vip-call-queue.service';

const DEFAULT_INTERVAL_MS = 60_000;

let timer: NodeJS.Timeout | null = null;

function getVipReconciliationLockTtlMs(intervalMs: number): number {
  return Math.max(intervalMs * 2, 30_000);
}

async function processDueScheduledCalls(): Promise<void> {
  if (!featureFlags.vipSchedulingEnabled) return;

  const now = new Date();
  const dueCalls = await ScheduledCall.find({
    status: 'confirmed',
    scheduledAt: { $lte: now },
    reminderSentAt: null,
  })
    .limit(20)
    .lean();

  for (const call of dueCalls) {
    const claimed = await ScheduledCall.findOneAndUpdate(
      { _id: call._id, reminderSentAt: null },
      { $set: { reminderSentAt: now } },
      { new: true }
    ).lean();
    if (!claimed) continue;

    const io = getIO();
    io.to(`user:${claimed.creatorFirebaseUid}`).emit('vip:scheduled_call:due', {
      scheduledCallId: claimed._id.toString(),
      callerUserId: claimed.callerUserId.toString(),
      scheduledAt: claimed.scheduledAt.toISOString(),
    });

    logInfo('vip_scheduled_call_due', {
      scheduledCallId: claimed._id.toString(),
      creatorFirebaseUid: claimed.creatorFirebaseUid,
    });
  }
}

async function tick(): Promise<void> {
  try {
    await expireStaleQueueEntries();
    await processDueScheduledCalls();
  } catch (error) {
    logInfo('vip_reconciliation_tick_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function tickWithLock(intervalMs: number): Promise<void> {
  await withDistributedLock(
    {
      key: VIP_RECONCILIATION_LOCK_KEY,
      ttlMs: getVipReconciliationLockTtlMs(intervalMs),
      ownerId: getBillingInstanceId(),
      heartbeat: true,
    },
    tick
  );
}

export function startVipReconciliationJob(): void {
  if (timer) return;
  const intervalMs = Math.max(
    15_000,
    Number.parseInt(process.env.VIP_RECONCILIATION_INTERVAL_MS || '', 10) ||
      DEFAULT_INTERVAL_MS,
  );
  timer = setInterval(() => {
    void tickWithLock(intervalMs);
  }, intervalMs);
  void tickWithLock(intervalMs);
}

export function stopVipReconciliationJob(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
