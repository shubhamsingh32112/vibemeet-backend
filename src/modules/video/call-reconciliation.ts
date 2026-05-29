import { Server } from 'socket.io';
import axios from 'axios';
import mongoose from 'mongoose';
import { randomUUID } from 'crypto';
import { Call } from './call.model';
import { User } from '../user/user.model';
import { generateServerSideToken } from '../../config/stream-video';
import { getAvailability } from '../availability/availability.service';
import { transitionCreatorPresence } from '../availability/presence.service';
import {
  getRedis,
  CALL_RECONCILIATION_LOCK_KEY,
  RECONCILIATION_LOCK_TTL_MS,
  activeCallByUserKey,
  ACTIVE_CALL_BY_USER_TTL,
  callSessionKey,
} from '../../config/redis';
import { featureFlags } from '../../config/feature-flags';
import { logInfo, logError } from '../../utils/logger';
import { recordCallMetric } from '../../utils/monitoring';
import { finalizeCallEnd } from './call-finalization.service';
import { getIO } from '../../config/socket';

let reconciliationTimer: NodeJS.Timeout | null = null;

const RECONCILIATION_INTERVAL_MS =
  parseInt(process.env.CALL_RECONCILIATION_INTERVAL_MS || '300000', 10) || // default 5 minutes
  300000;

const RECON_BATCH_SIZE = 100;
/** Max time per tick to avoid blocking event loop on huge backlogs */
const RECON_MAX_MS_PER_TICK = 45_000;
const RECON_PARALLELISM =
  Math.min(20, Math.max(1, parseInt(process.env.CALL_RECONCILIATION_PARALLELISM || '6', 10))) || 6;
const RECON_BATCH_PAUSE_MS =
  Math.min(1000, Math.max(0, parseInt(process.env.CALL_RECONCILIATION_BATCH_PAUSE_MS || '100', 10))) || 100;
const RECON_SETTLED_RESTORE_AGE_MS =
  Math.max(30_000, parseInt(process.env.CALL_RECONCILIATION_SETTLED_RESTORE_AGE_MS || '30000', 10) || 30_000);
const RELEASE_LOCK_LUA = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0
`;

/** Limit scanning of ancient unsettled rows (ms). Active ringing/accepted always included. */
const RECON_UNSETTLED_LOOKBACK_MS =
  parseInt(process.env.CALL_RECON_UNSETTLED_LOOKBACK_MS || String(7 * 24 * 60 * 60 * 1000), 10) ||
  7 * 24 * 60 * 60 * 1000;

function activeCallFilterAfter(
  lastId: mongoose.Types.ObjectId | null
): mongoose.FilterQuery<typeof Call> {
  const recentCutoff = new Date(Date.now() - RECON_UNSETTLED_LOOKBACK_MS);
  const unsettledRecent = {
    isSettled: { $ne: true },
    updatedAt: { $gte: recentCutoff },
  };
  const base: mongoose.FilterQuery<typeof Call> = {
    $or: [{ status: { $in: ['ringing', 'accepted'] } }, unsettledRecent],
  };
  if (!lastId) {
    return base;
  }
  return { $and: [base, { _id: { $gt: lastId } }] };
}

async function fetchActiveCallBatch(
  lastId: mongoose.Types.ObjectId | null
): Promise<Array<InstanceType<typeof Call>>> {
  return Call.find(activeCallFilterAfter(lastId))
    .sort({ _id: 1 })
    .limit(RECON_BATCH_SIZE)
    .exec();
}

function settledCallFilterAfter(
  lastId: mongoose.Types.ObjectId | null
): mongoose.FilterQuery<typeof Call> {
  const settledBefore = new Date(Date.now() - RECON_SETTLED_RESTORE_AGE_MS);
  const lookbackCutoff = new Date(Date.now() - RECON_UNSETTLED_LOOKBACK_MS);
  const base: mongoose.FilterQuery<typeof Call> = {
    isSettled: true,
    status: 'ended',
    updatedAt: { $lte: settledBefore, $gte: lookbackCutoff },
  };
  if (!lastId) return base;
  return { $and: [base, { _id: { $gt: lastId } }] };
}

async function fetchSettledCallBatch(
  lastId: mongoose.Types.ObjectId | null
): Promise<Array<InstanceType<typeof Call>>> {
  return Call.find(settledCallFilterAfter(lastId))
    .sort({ _id: 1 })
    .limit(RECON_BATCH_SIZE)
    .exec();
}

async function cleanupSettledCreatorBusyDrift(): Promise<void> {
  try {
    const redis = getRedis();
    const passStarted = Date.now();
    let lastId: mongoose.Types.ObjectId | null = null;
    let scanned = 0;
    let fixed = 0;

    while (Date.now() - passStarted < RECON_MAX_MS_PER_TICK) {
      const settledCalls = await fetchSettledCallBatch(lastId);
      if (!settledCalls.length) {
        break;
      }

      for (const call of settledCalls) {
        try {
          const creatorUser = await User.findById(call.creatorUserId);
          if (!creatorUser?.firebaseUid) {
            continue;
          }
          const creatorFirebaseUid = creatorUser.firebaseUid;
          const slotKey = activeCallByUserKey(creatorFirebaseUid);
          const slotCallId = await redis.get(slotKey);
          const sessionForSlot = slotCallId ? await redis.get(callSessionKey(slotCallId)) : null;

          if (slotCallId === call.callId && !sessionForSlot) {
            await redis.del(slotKey).catch(() => {});
            const keyStillExists = Boolean(await redis.get(slotKey));
            logInfo('Reconciliation cleared stale active call slot for settled call', {
              callId: call.callId,
              creatorFirebaseUid,
              activeCallKeyDeleted: true,
              activeCallKeyExistsAfterDelete: keyStillExists,
            });
          }

          const activeCallAfterCleanup = await redis.get(slotKey);
          if (activeCallAfterCleanup) {
            continue;
          }

          const hasOtherLiveCall = await Call.exists({
            creatorUserId: call.creatorUserId,
            _id: { $ne: call._id },
            $or: [{ status: { $in: ['ringing', 'accepted'] } }, { isSettled: { $ne: true } }],
          });
          if (hasOtherLiveCall) {
            continue;
          }

          const currentStatus = await getAvailability(creatorFirebaseUid);
          if (currentStatus !== 'busy') {
            continue;
          }

          const settlementAgeMs = Math.max(
            0,
            Date.now() - (call.updatedAt ? new Date(call.updatedAt).getTime() : Date.now())
          );
          if (settlementAgeMs < RECON_SETTLED_RESTORE_AGE_MS) {
            continue;
          }

          await transitionCreatorPresence(
            getIO(),
            creatorFirebaseUid,
            'RECONCILED',
            'call-reconciliation.cleanupSettledCreatorBusyDrift'
          );
          fixed += 1;
          logInfo('Reconciliation restored creator online after settled call', {
            callId: call.callId,
            creatorFirebaseUid,
            settlementAgeMs,
            thresholdMs: RECON_SETTLED_RESTORE_AGE_MS,
          });
        } catch (err) {
          logError('Error reconciling settled creator busy drift', err, {
            callId: call.callId,
          });
        }
      }

      scanned += settledCalls.length;
      lastId = settledCalls[settledCalls.length - 1]._id as mongoose.Types.ObjectId;
      if (RECON_BATCH_PAUSE_MS > 0) {
        await new Promise((resolve) => setTimeout(resolve, RECON_BATCH_PAUSE_MS));
      }
      if (settledCalls.length < RECON_BATCH_SIZE) {
        break;
      }
    }

    recordCallMetric('call_reconciliation.settled_busy_scan', scanned, {});
    recordCallMetric('call_reconciliation.settled_busy_fixed', fixed, {});
  } catch (err) {
    logError('Error in cleanupSettledCreatorBusyDrift', err);
  }
}

/**
 * Simple call state reconciliation job.
 *
 * Goal:
 * - Detect obvious drifts between our Call records and Stream's truth.
 * - Auto‑close obviously stale calls to avoid infinite "accepted" state.
 *
 * Strategy:
 * - Look for calls that appear active in our DB:
 *   status in ['ringing', 'accepted'] OR (!isSettled)
 * - For each, query Stream's call by callId.
 * - If Stream reports the call/session ended, mark our Call as ended/settled.
 *
 * NOTE: This is intentionally conservative and only auto‑fixes the "clearly ended"
 *       case. It logs discrepancies for further investigation.
 */
export function startCallReconciliationJob(_io: Server): void {
  if (reconciliationTimer) {
    logInfo('Call reconciliation job already running', {});
    return;
  }

  logInfo('Starting call reconciliation job', {
    intervalMs: RECONCILIATION_INTERVAL_MS,
  });

  // Fire once on startup
  reconcileActiveCallsWithLock().catch((err) => {
    logError('Initial call reconciliation failed', err);
  });

  reconciliationTimer = setInterval(() => {
    reconcileActiveCallsWithLock().catch((err) => {
      logError('Scheduled call reconciliation failed', err);
    });
  }, RECONCILIATION_INTERVAL_MS);
}

export function stopCallReconciliationJob(): void {
  if (reconciliationTimer) {
    clearInterval(reconciliationTimer);
    reconciliationTimer = null;
    logInfo('Stopped call reconciliation job', {});
  }
}

/**
 * 🔥 FIX: Ensure creators with active calls are marked busy
 * This is a safety net to catch any cases where creators weren't marked busy
 */
async function ensureCreatorsWithActiveCallsAreBusy(): Promise<void> {
  try {
    const passStarted = Date.now();
    let lastId: mongoose.Types.ObjectId | null = null;
    let scanned = 0;

    while (Date.now() - passStarted < RECON_MAX_MS_PER_TICK) {
      const activeCalls = await fetchActiveCallBatch(lastId);
      if (!activeCalls.length) {
        break;
      }

      for (const call of activeCalls) {
        try {
          const creatorUser = await User.findById(call.creatorUserId);
          if (creatorUser?.firebaseUid) {
            const currentStatus = await getAvailability(creatorUser.firebaseUid);

            if (currentStatus !== 'busy') {
              if (featureFlags.creatorPresenceUserModelEnabled) {
                const redis = getRedis();
                await redis.set(
                  activeCallByUserKey(creatorUser.firebaseUid),
                  call.callId,
                  'EX',
                  ACTIVE_CALL_BY_USER_TTL
                );
              }
              await transitionCreatorPresence(
                getIO(),
                creatorUser.firebaseUid,
                'CALL_STARTED',
                'call-reconciliation.ensureCreatorsWithActiveCallsAreBusy'
              );
              logInfo('Reconciliation: Fixed creator busy status', {
                callId: call.callId,
                creatorFirebaseUid: creatorUser.firebaseUid,
                previousStatus: currentStatus,
              });
            }
          }
        } catch (err) {
          logError('Error ensuring creator busy status in reconciliation', err, {
            callId: call.callId,
          });
        }
      }

      scanned += activeCalls.length;
      lastId = activeCalls[activeCalls.length - 1]._id as mongoose.Types.ObjectId;
      if (RECON_BATCH_PAUSE_MS > 0) {
        await new Promise((resolve) => setTimeout(resolve, RECON_BATCH_PAUSE_MS));
      }
      if (activeCalls.length < RECON_BATCH_SIZE) {
        break;
      }
    }

    recordCallMetric('call_reconciliation.busy_scan', scanned, {});
  } catch (err) {
    logError('Error in ensureCreatorsWithActiveCallsAreBusy', err);
  }
}

async function releaseLock(lockKey: string, token: string): Promise<void> {
  const redis = getRedis();
  try {
    await redis.eval(RELEASE_LOCK_LUA, 1, lockKey, token);
  } catch {
    // ignore release failure
  }
}

async function reconcileActiveCallsWithLock(): Promise<void> {
  const redis = getRedis();
  const token = randomUUID();
  const lockResult = await redis.set(
    CALL_RECONCILIATION_LOCK_KEY,
    token,
    'PX',
    RECONCILIATION_LOCK_TTL_MS,
    'NX'
  );
  if (lockResult !== 'OK') {
    recordCallMetric('call_reconciliation.skipped_lock_busy', 1, {});
    return;
  }

  const heartbeat = setInterval(() => {
    redis
      .set(CALL_RECONCILIATION_LOCK_KEY, token, 'PX', RECONCILIATION_LOCK_TTL_MS, 'XX')
      .catch(() => {});
  }, Math.max(1000, Math.floor(RECONCILIATION_LOCK_TTL_MS / 3)));

  try {
    await reconcileActiveCalls();
  } finally {
    clearInterval(heartbeat);
    await releaseLock(CALL_RECONCILIATION_LOCK_KEY, token);
  }
}

async function reconcileActiveCalls(): Promise<void> {
  try {
    const runStartedAt = Date.now();
    await ensureCreatorsWithActiveCallsAreBusy();
    await cleanupSettledCreatorBusyDrift();

    const apiKey = process.env.STREAM_API_KEY;
    const baseUrl = 'https://video.stream-io-api.com';

    if (!apiKey) {
      logError(
        'Call reconciliation: STREAM_API_KEY not set, skipping Stream checks',
        new Error('Missing STREAM_API_KEY')
      );
      return;
    }

    const serverToken = generateServerSideToken();
    const passStarted = Date.now();
    let lastId: mongoose.Types.ObjectId | null = null;
    let totalChecked = 0;

    while (Date.now() - passStarted < RECON_MAX_MS_PER_TICK) {
      const activeCalls = await fetchActiveCallBatch(lastId);

      if (!activeCalls.length) {
        if (totalChecked === 0) {
          logInfo('Call reconciliation: no active calls to check', {});
        }
        break;
      }

      if (totalChecked === 0) {
        logInfo('Call reconciliation: checking active calls (paginated)', {
          firstBatchSize: activeCalls.length,
        });
      }

      for (let i = 0; i < activeCalls.length; i += RECON_PARALLELISM) {
        const batch = activeCalls.slice(i, i + RECON_PARALLELISM);
        await Promise.allSettled(
          batch.map(async (call) => {
            const callId = call.callId;
            try {
        // Query Stream Video for call state
        const url = `${baseUrl}/video/calls/default/${encodeURIComponent(
          callId
        )}?api_key=${apiKey}`;

        const resp = await axios.get(url, {
          headers: {
            Authorization: `Bearer ${serverToken}`,
          },
          timeout: 7000,
        });

        const streamCall = resp.data?.call;
        const ended =
          streamCall?.ended_at ||
          streamCall?.session?.ended_at ||
          streamCall?.state === 'ended';

        if (!ended) {
          // Stream still thinks call is active; nothing to do
          return;
        }

        // If Stream says ended but our Call is still not ended/settled, run the
        // same centralized end finalizer used by webhooks/socket handlers.
        if (call.status !== 'ended' || !call.isSettled) {
          logInfo('Reconciling ended call from Stream', {
            callId,
            currentStatus: call.status,
            isSettled: call.isSettled,
          });
          await finalizeCallEnd(getIO(), callId, 'reconciliation_stream_ended');
        }
      } catch (err: any) {
        // 404 from Stream: call unknown → treat as ended and close locally
        const status = err?.response?.status;
        if (status === 404) {
          logInfo('Reconciling locally for call missing in Stream', { callId });
          if (call.status !== 'ended' || !call.isSettled) {
            await finalizeCallEnd(getIO(), callId, 'reconciliation_stream_404');
          }
        } else {
          logError('Error reconciling call with Stream', err, { callId });
        }
      }})
        );
        if (RECON_BATCH_PAUSE_MS > 0 && i + RECON_PARALLELISM < activeCalls.length) {
          await new Promise((resolve) => setTimeout(resolve, RECON_BATCH_PAUSE_MS));
        }
      }

      totalChecked += activeCalls.length;
      lastId = activeCalls[activeCalls.length - 1]._id as mongoose.Types.ObjectId;
      if (activeCalls.length < RECON_BATCH_SIZE) {
        break;
      }
    }

    recordCallMetric('call_reconciliation.stream_checked', totalChecked, {});
    recordCallMetric('call_reconciliation.run_ms', Date.now() - runStartedAt, {
      checked: String(totalChecked),
    });
  } catch (err) {
    logError('Call reconciliation job failed', err);
  }
}

