import { Server } from 'socket.io';
import {
  getRedis,
  callSessionKey,
  pendingCallEndKey,
  PENDING_CALL_END_TTL,
} from '../../config/redis';
import { recordBillingMetric } from '../../utils/monitoring';
import { billingService } from './billing.service';
import { finalizeCallSession } from './billing-session-finalization.service';
import { isCallActive } from './billing-active-call.service';
import { logError, logInfo, logDebug, logWarning } from '../../utils/logger';
import { checkCallRateLimit } from '../../utils/rate-limit.service';
import { COIN_MICROS, BILLING_SESSION_SCHEMA_VERSION, microsToWholeCoinsFloor } from './billing.constants';
import { finalizeCallEnd } from '../video/call-finalization.service';
import {
  resolveActiveRuntimeStateForUser,
  resolveBillingRuntimeState,
} from './billing-runtime-resolver.service';
import {
  emitBillingRecoverStateFromSnapshot,
  emitBillingRecoverStateResponse,
} from './billing-emitter.service';

/** Shape of Redis billing session JSON (recover-state handler). */
interface BillingRecoverSession {
  schemaVersion?: number;
  callId: string;
  userFirebaseUid: string;
  creatorFirebaseUid: string;
  userMongoId: string;
  creatorMongoId: string;
  pricePerMinute: number;
  pricePerSecondMicros?: number;
  pricePerSecond?: number;
  creatorEarningsPerSecondMicros?: number;
  creatorEarningsPerSecond?: number;
  creatorShareAtCallTime?: number;
  startTime: number;
  lastProcessedAt?: number;
  totalDeductedMicros?: number;
  totalEarnedMicros?: number;
  billingSequence?: number;
  lifecycleState?: string;
  elapsedSeconds: number;
  effectiveDurationLimitSeconds?: number;
}

/**
 * Attach billing-related socket events.
 * Called AFTER `setupAvailabilityGateway` (which installs the auth middleware).
 */
export function setupBillingGateway(io: Server): void {
  io.on('connection', (socket) => {
    const firebaseUid: string | undefined = socket.data.firebaseUid;
    if (!firebaseUid) return;

    socket.join(`user:${firebaseUid}`);
    logDebug('User joined billing room', { firebaseUid, room: `user:${firebaseUid}` });

    socket.on(
      'call:started',
      async (data: {
        callId: string;
        creatorFirebaseUid: string;
        creatorMongoId: string;
        userFirebaseUid?: string;
      }) => {
        const callStartedRequestAt = Date.now();
        try {
          const payerFirebaseUid = data.userFirebaseUid || firebaseUid;
          const initiatedByFirebaseUid = firebaseUid;
          const initiatedByRole = socket.data.isCreator ? 'creator' : 'user';

          logInfo('call:started received', {
            callId: data.callId,
            source: 'client_socket',
            socketFirebaseUid: firebaseUid,
            initiatedByFirebaseUid,
            initiatedByRole,
            payerFirebaseUid,
            creatorFirebaseUid: data.creatorFirebaseUid,
            isCreatorInitiated: !!data.userFirebaseUid,
          });
          logInfo('billing_lifecycle_start_received', {
            callId: data.callId,
            source: 'client_socket',
            initiatedByFirebaseUid,
            initiatedByRole,
            payerFirebaseUid,
            creatorFirebaseUid: data.creatorFirebaseUid,
          });

          const rateLimitCheck = await checkCallRateLimit(payerFirebaseUid);
          if (!rateLimitCheck.allowed) {
            logWarning('Call rate limit exceeded', {
              payerFirebaseUid,
              callId: data.callId,
              count: rateLimitCheck.limit - rateLimitCheck.remaining,
              limit: rateLimitCheck.limit,
              resetAt: new Date(rateLimitCheck.resetAt).toISOString(),
            });
            recordBillingMetric('rate_limit_exceeded', 1, {
              firebaseUid: payerFirebaseUid,
              callId: data.callId,
            });

            io.to(`user:${payerFirebaseUid}`).emit('billing:error', {
              callId: data.callId,
              error: 'RATE_LIMIT_EXCEEDED',
              message: `Too many call attempts. Please wait before trying again.`,
              rateLimit: {
                limit: rateLimitCheck.limit,
                remaining: rateLimitCheck.remaining,
                resetAt: rateLimitCheck.resetAt,
                windowSeconds: rateLimitCheck.windowSeconds,
              },
            });
            return;
          }

          logDebug('Rate limit check passed', {
            payerFirebaseUid,
            callId: data.callId,
            remaining: rateLimitCheck.remaining,
            limit: rateLimitCheck.limit,
          });

          await billingService.startBillingSession(io, payerFirebaseUid, data, {
            source: 'client_socket',
            requestReceivedAtMs: callStartedRequestAt,
            initiatedByFirebaseUid,
            initiatedByRole,
          });

          const redis = getRedis();
          const pendingEndKey = pendingCallEndKey(data.callId);
          const hasPendingEnd = await redis.get(pendingEndKey);
          if (hasPendingEnd) {
            await redis.del(pendingEndKey);
            logInfo('Deferred settlement for call', { callId: data.callId });
            await finalizeCallSession(io, {
              callId: data.callId,
              reason: 'explicit_end',
              source: 'deferred_pending_end',
            });
          }
        } catch (err) {
          logError('Error in call:started', err, { callId: data.callId, firebaseUid });
          const redis = getRedis();
          await redis.del(pendingCallEndKey(data.callId)).catch(() => {});
          socket.emit('billing:error', {
            callId: data.callId,
            message: 'Failed to start billing',
          });
        }
      }
    );

    socket.on('call:ended', async (data: { callId: string }) => {
      try {
        logInfo('call:ended received', { callId: data.callId, firebaseUid });

        const redis = getRedis();
        const active = await isCallActive(redis, {
          callId: data.callId,
          userFirebaseUid: firebaseUid,
        });

        if (!active) {
          await redis.setex(pendingCallEndKey(data.callId), PENDING_CALL_END_TTL, '1');
          logInfo('Deferring call:ended (session not ready)', { callId: data.callId });
          return;
        }

        await finalizeCallEnd(io, data.callId, 'socket_call_ended');
      } catch (err) {
        logError('Error in call:ended', err, { callId: data.callId, firebaseUid });
      }
    });

    socket.on('billing:recover-state', async () => {
      try {
        logInfo('State recovery requested', { firebaseUid });
        const redis = getRedis();

        const activeRuntime = await resolveActiveRuntimeStateForUser(firebaseUid);
        const callId = activeRuntime.callId;
        if (!callId || !activeRuntime.runtime.session) {
          emitBillingRecoverStateResponse(socket, {
            success: true,
            activeCalls: [],
          });
          return;
        }

        const active = await isCallActive(redis, {
          callId,
          userFirebaseUid: firebaseUid,
        });
        if (!active) {
          emitBillingRecoverStateResponse(socket, {
            success: true,
            activeCalls: [],
          });
          return;
        }

        const runtime = activeRuntime.runtime.session
          ? activeRuntime.runtime
          : await resolveBillingRuntimeState(callId);
        if (!runtime.session) {
          emitBillingRecoverStateResponse(socket, {
            success: true,
            activeCalls: [],
          });
          return;
        }

        const session = runtime.session as BillingRecoverSession;
        const balanceMicros = runtime.balanceMicros;
        let earningsMicros = runtime.earningsMicros;
        if ((session.schemaVersion ?? 0) < BILLING_SESSION_SCHEMA_VERSION) {
          earningsMicros = Math.round((earningsMicros * COIN_MICROS) / 10000);
        }
        const earningsDisplay = Math.round((earningsMicros / COIN_MICROS) * 100) / 100;

        const pps =
          session.pricePerSecondMicros ??
          Math.max(1, Math.round((session.pricePerSecond ?? 0) * COIN_MICROS));
        const remainingSeconds = pps > 0 ? Math.floor(balanceMicros / pps) : 0;

        const serverTimestamp = Date.now();

        emitBillingRecoverStateFromSnapshot(socket, [
          {
            callId: session.callId,
            coins: microsToWholeCoinsFloor(balanceMicros),
            coinsExact: balanceMicros / COIN_MICROS,
            billingSequence: Math.max(0, Number(session.billingSequence) || 0),
            lifecycleState: String(session.lifecycleState || 'ACTIVE'),
            pricePerSecond: pps / COIN_MICROS,
            pricePerSecondMicros: pps,
            elapsedSeconds: session.elapsedSeconds,
            remainingSeconds,
            earnings: earningsDisplay,
            serverTimestamp,
            callStartTime: session.startTime,
          },
        ]);

        logInfo('State recovery completed', {
          firebaseUid,
          callId,
          elapsedSeconds: session.elapsedSeconds,
          source: runtime.source,
        });

        recordBillingMetric('state_recovery', 1, { callId, firebaseUid });
      } catch (err) {
        logError('State recovery failed', err, { firebaseUid });
        emitBillingRecoverStateResponse(socket, {
          success: false,
          error: 'Failed to recover state',
          activeCalls: [],
        });
      }
    });

    socket.on(
      'billing:sync-warning',
      async (data: { callId?: string; stuckSeconds?: number; phase?: string; reportedAt?: string }) => {
        const callId = String(data?.callId || '').trim();
        if (!callId) return;
        try {
          const redis = getRedis();
          const hasSession = (await redis.exists(callSessionKey(callId))) === 1;
          logWarning('billing_sync_warning_client', {
            callId,
            firebaseUid,
            phase: data?.phase || 'unknown',
            stuckSeconds: Number(data?.stuckSeconds || 0),
            reportedAt: data?.reportedAt,
            hasSession,
          });
          recordBillingMetric('client_billing_sync_warning', 1, {
            callId,
            firebaseUid,
            phase: String(data?.phase || 'unknown'),
            hasSession: hasSession ? '1' : '0',
          });
        } catch (err) {
          logError('Failed to process billing:sync-warning', err, { callId, firebaseUid });
        }
      }
    );

    socket.on('disconnect', async (reason) => {
      logInfo('Socket disconnected', { firebaseUid, reason });
      // Do NOT settle active calls on transient socket disconnects.
      // Calls continue over Stream/WebRTC even if Socket.IO drops briefly; settling
      // here truncates billed duration and causes timer/UI desync on clients.
      // Settlement is handled by explicit `call:ended` and Stream webhooks.
    });
  });
}
