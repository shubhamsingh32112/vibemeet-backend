import { Server } from 'socket.io';
import {
  getRedis,
  callSessionKey,
  pendingCallEndKey,
  PENDING_CALL_END_TTL,
  billingSyncWarningDedupKey,
  billingSyncWarningCountKey,
} from '../../config/redis';
import { recordBillingMetric } from '../../utils/monitoring';
import { billingService, ensureBillingStartedReplayFreshness } from './billing.service';
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
import { randomUUID } from 'crypto';

const RECOVERY_DEBOUNCE_MS = Math.min(
  5000,
  Math.max(100, parseInt(process.env.BILLING_RECOVERY_DEBOUNCE_MS || '750', 10) || 750)
);
const SYNC_WARNING_DEDUP_SECONDS = Math.min(
  120,
  Math.max(5, parseInt(process.env.BILLING_SYNC_WARNING_DEDUP_SECONDS || '15', 10) || 15)
);
const SYNC_WARNING_AUTOHEAL_THRESHOLD = Math.min(
  10,
  Math.max(2, parseInt(process.env.BILLING_SYNC_WARNING_AUTOHEAL_THRESHOLD || '3', 10) || 3)
);

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
    let recoveryInFlight = false;
    let lastRecoveryAtMs = 0;
    let recoveryRequestSeq = 0;

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
          const startCorrelationId = randomUUID();

          logInfo('call:started received', {
            callId: data.callId,
            source: 'client_socket',
            startIngress: 'socket',
            startCorrelationId,
            socketFirebaseUid: firebaseUid,
            initiatedByFirebaseUid,
            initiatedByRole,
            payerFirebaseUid,
            creatorFirebaseUid: data.creatorFirebaseUid,
            isCreatorInitiated: !!data.userFirebaseUid,
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
            startIngress: 'socket',
            startCorrelationId,
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
      const now = Date.now();
      const recoveryRequestId = ++recoveryRequestSeq;
      if (recoveryInFlight) {
        recordBillingMetric('state_recovery_suppressed', 1, {
          firebaseUid,
          reason: 'in_flight',
        });
        return;
      }
      if (now - lastRecoveryAtMs < RECOVERY_DEBOUNCE_MS) {
        recordBillingMetric('state_recovery_suppressed', 1, {
          firebaseUid,
          reason: 'debounce',
        });
        return;
      }
      recoveryInFlight = true;
      lastRecoveryAtMs = now;
      try {
        logInfo('State recovery requested', { firebaseUid, recoveryRequestId });
        const redis = getRedis();

        const activeRuntime = await resolveActiveRuntimeStateForUser(firebaseUid);
        const callId = activeRuntime.callId;
        if (!callId || !activeRuntime.runtime.session) {
          emitBillingRecoverStateResponse(socket, {
            success: true,
            activeCalls: [],
            recoveryRequestId,
            generatedAtMs: Date.now(),
            runtimeSource: activeRuntime.runtime.source,
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
            recoveryRequestId,
            generatedAtMs: Date.now(),
            runtimeSource: activeRuntime.runtime.source,
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
            recoveryRequestId,
            generatedAtMs: Date.now(),
            runtimeSource: runtime.source,
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
        const billingSequence = Math.max(0, Number(session.billingSequence) || 0);
        if (billingSequence <= 0 || Number(session.startTime) <= 0 || serverTimestamp <= 0) {
          logWarning('state_recovery_emit_skipped_invalid_tuple', {
            firebaseUid,
            callId,
            billingSequence,
            callStartTime: session.startTime,
            serverTimestamp,
            recoveryRequestId,
          });
          recordBillingMetric('state_recovery_invalid_tuple', 1, { callId, firebaseUid });
          emitBillingRecoverStateResponse(socket, {
            success: true,
            activeCalls: [],
            recoveryRequestId,
            generatedAtMs: serverTimestamp,
            runtimeSource: runtime.source,
          });
          return;
        }

        emitBillingRecoverStateFromSnapshot(
          socket,
          [
          {
            callId: session.callId,
            coins: microsToWholeCoinsFloor(balanceMicros),
            coinsExact: balanceMicros / COIN_MICROS,
            billingSequence,
            lifecycleState: String(session.lifecycleState || 'ACTIVE'),
            pricePerSecond: pps / COIN_MICROS,
            pricePerSecondMicros: pps,
            elapsedSeconds: session.elapsedSeconds,
            remainingSeconds,
            earnings: earningsDisplay,
            serverTimestamp,
            callStartTime: session.startTime,
          },
          ],
          {
            recoveryRequestId,
            generatedAtMs: serverTimestamp,
            runtimeSource: runtime.source,
          }
        );

        logInfo('State recovery completed', {
          firebaseUid,
          recoveryRequestId,
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
          recoveryRequestId,
          generatedAtMs: Date.now(),
        });
      } finally {
        recoveryInFlight = false;
      }
    });

    socket.on(
      'billing:sync-warning',
      async (data: { callId?: string; stuckSeconds?: number; phase?: string; reportedAt?: string }) => {
        const callId = String(data?.callId || '').trim();
        if (!callId) return;
        try {
          const redis = getRedis();
          const phase = String(data?.phase || 'unknown');
          const dedupeKey = billingSyncWarningDedupKey(callId, phase);
          const dedupe = await redis.set(dedupeKey, String(Date.now()), 'EX', SYNC_WARNING_DEDUP_SECONDS, 'NX');
          if (dedupe !== 'OK') {
            recordBillingMetric('billing_sync_warning_deduped', 1, {
              callId,
              firebaseUid,
              phase,
            });
            return;
          }
          const warningCountKey = billingSyncWarningCountKey(callId, phase);
          const warningCount = await redis.incr(warningCountKey);
          await redis.expire(warningCountKey, 120).catch(() => 0);
          const hasSession = (await redis.exists(callSessionKey(callId))) === 1;
          logWarning('billing_sync_warning_client', {
            callId,
            firebaseUid,
            phase,
            stuckSeconds: Number(data?.stuckSeconds || 0),
            reportedAt: data?.reportedAt,
            hasSession,
            warningCount,
          });
          recordBillingMetric('client_billing_sync_warning', 1, {
            callId,
            firebaseUid,
            phase,
            hasSession: hasSession ? '1' : '0',
          });
          if (hasSession && warningCount >= SYNC_WARNING_AUTOHEAL_THRESHOLD) {
            recordBillingMetric('billing_sync_autoheal_triggered', 1, {
              callId,
              firebaseUid,
              phase,
            });
            const replayed = await ensureBillingStartedReplayFreshness(io, callId, 'sync_warning_autoheal', {
              force: true,
              startIngress: 'socket',
              replayReason: `sync_warning_${phase}`,
            });
            if (replayed) {
              recordBillingMetric('billing_sync_autoheal_success', 1, {
                callId,
                firebaseUid,
                phase,
              });
            } else {
              const runtime = await resolveBillingRuntimeState(callId);
              const session = runtime.session as BillingRecoverSession | null;
              if (session) {
                const pps =
                  session.pricePerSecondMicros ??
                  Math.max(1, Math.round((session.pricePerSecond ?? 0) * COIN_MICROS));
                const remainingSeconds = pps > 0 ? Math.floor(runtime.balanceMicros / pps) : 0;
                emitBillingRecoverStateFromSnapshot(
                  socket,
                  [
                    {
                      callId: session.callId,
                      coins: microsToWholeCoinsFloor(runtime.balanceMicros),
                      coinsExact: runtime.balanceMicros / COIN_MICROS,
                      billingSequence: Math.max(0, Number(session.billingSequence) || 0),
                      lifecycleState: String(session.lifecycleState || 'ACTIVE'),
                      pricePerSecond: pps / COIN_MICROS,
                      pricePerSecondMicros: pps,
                      elapsedSeconds: session.elapsedSeconds,
                      remainingSeconds,
                      earnings: Math.round((runtime.earningsMicros / COIN_MICROS) * 100) / 100,
                      serverTimestamp: Date.now(),
                      callStartTime: session.startTime,
                    },
                  ],
                  {
                    generatedAtMs: Date.now(),
                    runtimeSource: runtime.source,
                  }
                );
              }
            }
          }
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
