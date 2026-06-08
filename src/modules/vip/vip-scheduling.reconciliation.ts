import { getIO } from '../../config/socket';
import { featureFlags } from '../../config/feature-flags';
import { logInfo } from '../../utils/logger';
import { ScheduledCall } from './models/scheduled-call.model';
import { expireStaleQueueEntries } from './vip-call-queue.service';

const DEFAULT_INTERVAL_MS = 60_000;

let timer: NodeJS.Timeout | null = null;

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
    const io = getIO();
    io.to(`user:${call.creatorFirebaseUid}`).emit('vip:scheduled_call:due', {
      scheduledCallId: call._id.toString(),
      callerUserId: call.callerUserId.toString(),
      scheduledAt: call.scheduledAt.toISOString(),
    });

    await ScheduledCall.updateOne(
      { _id: call._id },
      { $set: { reminderSentAt: now } },
    );

    logInfo('vip_scheduled_call_due', {
      scheduledCallId: call._id.toString(),
      creatorFirebaseUid: call.creatorFirebaseUid,
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

export function startVipReconciliationJob(): void {
  if (timer) return;
  const intervalMs = Math.max(
    15_000,
    Number.parseInt(process.env.VIP_RECONCILIATION_INTERVAL_MS || '', 10) ||
      DEFAULT_INTERVAL_MS,
  );
  timer = setInterval(() => {
    void tick();
  }, intervalMs);
  void tick();
}

export function stopVipReconciliationJob(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
