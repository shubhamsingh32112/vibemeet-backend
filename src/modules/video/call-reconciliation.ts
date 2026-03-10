import { Server } from 'socket.io';
import axios from 'axios';
import { Call } from './call.model';
import { User } from '../user/user.model';
import { generateServerSideToken } from '../../config/stream-video';
import { transitionCallStatus } from './call-state.service';
import { setAvailability, getAvailability } from '../availability/availability.service';
import { emitCreatorStatus } from '../availability/availability.socket';
import { logInfo, logError } from '../../utils/logger';

let reconciliationTimer: NodeJS.Timeout | null = null;

const RECONCILIATION_INTERVAL_MS =
  parseInt(process.env.CALL_RECONCILIATION_INTERVAL_MS || '300000', 10) || // default 5 minutes
  300000;

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
  reconcileActiveCalls().catch((err) => {
    logError('Initial call reconciliation failed', err);
  });

  reconciliationTimer = setInterval(() => {
    reconcileActiveCalls().catch((err) => {
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
    const activeCalls = await Call.find({
      $or: [
        { status: { $in: ['ringing', 'accepted'] } },
        { isSettled: { $ne: true } },
      ],
    })
      .limit(200)
      .exec();

    if (!activeCalls.length) {
      return; // No active calls
    }

    // Mark each creator busy if they have an active call
    for (const call of activeCalls) {
      try {
        const creatorUser = await User.findById(call.creatorUserId);
        if (creatorUser?.firebaseUid) {
          // Check current status
          const currentStatus = await getAvailability(creatorUser.firebaseUid);
          
          if (currentStatus !== 'busy') {
            // Creator should be busy but isn't - fix it
            await setAvailability(creatorUser.firebaseUid, 'busy');
            emitCreatorStatus(creatorUser.firebaseUid, 'busy');
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
  } catch (err) {
    logError('Error in ensureCreatorsWithActiveCallsAreBusy', err);
  }
}

async function reconcileActiveCalls(): Promise<void> {
  try {
    // 🔥 FIX: First ensure creators with active calls are marked busy
    await ensureCreatorsWithActiveCallsAreBusy();

    const activeCalls = await Call.find({
      $or: [
        { status: { $in: ['ringing', 'accepted'] } },
        { isSettled: { $ne: true } },
      ],
    })
      .limit(200)
      .exec();

    if (!activeCalls.length) {
      logInfo('Call reconciliation: no active calls to check', {});
      return;
    }

    logInfo('Call reconciliation: checking active calls', {
      count: activeCalls.length,
    });

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

    for (const call of activeCalls) {
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
          continue;
        }

        // If Stream says ended but our Call is still not ended/settled, close it
        // via the centralised Call state helper so timestamps/durations and
        // metrics stay consistent with the rest of the system.
        if (call.status !== 'ended' || !call.isSettled) {
          logInfo('Reconciling ended call from Stream', {
            callId,
            currentStatus: call.status,
            isSettled: call.isSettled,
          });

          if (!call.endedAt && streamCall?.ended_at) {
            call.endedAt = new Date(streamCall.ended_at);
          }

          transitionCallStatus(call, 'ended', {
            source: 'call.reconciliation',
            eventType: 'stream_call_reconciled',
          });

          // We do not attempt to re‑run billing here; billing is already guarded
          // by Redis + settlement idempotency. We only mark the record consistent.
          await call.save();
        }
      } catch (err: any) {
        // 404 from Stream: call unknown → treat as ended and close locally
        const status = err?.response?.status;
        if (status === 404) {
          logInfo('Reconciling locally for call missing in Stream', { callId });
          if (call.status !== 'ended' || !call.isSettled) {
            if (!call.endedAt) {
              call.endedAt = new Date();
            }

            transitionCallStatus(call, 'ended', {
              source: 'call.reconciliation',
              eventType: 'stream_call_missing_404',
            });

            await call.save();
          }
        } else {
          logError('Error reconciling call with Stream', err, { callId });
        }
      }
    }
  } catch (err) {
    logError('Call reconciliation job failed', err);
  }
}

