//D:\zztherapy\backend\src\modules\billing\billing-socket.gateway.ts
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

type RecoveryOutcome =
  | 'recover_success'
  | 'recover_bootstrapping'
  | 'recover_suppressed'
  | 'recover_runtime_missing'
  | 'recover_tuple_invalid'
  | 'recover_stale_sequence'
  | 'recover_empty'
  | 'recover_emit_skipped';

function recordRecoveryOutcome(
  firebaseUid: string,
  outcome: RecoveryOutcome,
  extra?: Record<string, string>
): void {
  recordBillingMetric('recovery_outcome', 1, {
    firebaseUid,
    recoveryOutcome: outcome,
    ...(extra ?? {}),
  });
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

    socket.on('billing:recover-state', async (payload?: { clientRecoveryRequestId?: string }) => {
      const now = Date.now();
      const recoveryRequestId = ++recoveryRequestSeq;
      const clientRecoveryRequestId =
        typeof payload?.clientRecoveryRequestId === 'string'
          ? payload.clientRecoveryRequestId.trim().slice(0, 128)
          : undefined;
      if (recoveryInFlight) {
        logInfo('billing_state_recovery_suppressed', {
          firebaseUid,
          recoveryRequestId,
          clientRecoveryRequestId,
          reason: 'in_flight',
        });
        recordBillingMetric('state_recovery_suppressed', 1, {
          firebaseUid,
          reason: 'in_flight',
        });
        recordRecoveryOutcome(firebaseUid, 'recover_suppressed', { reason: 'in_flight' });
        emitBillingRecoverStateResponse(socket, {
          success: true,
          activeCalls: [],
          recoveryRequestId,
          clientRecoveryRequestId,
          generatedAtMs: now,
          status: 'suppressed',
          reason: 'in_flight',
          recoveryOutcome: 'recover_suppressed',
        });
        return;
      }
      if (now - lastRecoveryAtMs < RECOVERY_DEBOUNCE_MS) {
        logInfo('billing_state_recovery_suppressed', {
          firebaseUid,
          recoveryRequestId,
          clientRecoveryRequestId,
          reason: 'debounce',
          debounceMs: RECOVERY_DEBOUNCE_MS,
        });
        recordBillingMetric('state_recovery_suppressed', 1, {
          firebaseUid,
          reason: 'debounce',
        });
        recordRecoveryOutcome(firebaseUid, 'recover_suppressed', { reason: 'debounce' });
        emitBillingRecoverStateResponse(socket, {
          success: true,
          activeCalls: [],
          recoveryRequestId,
          clientRecoveryRequestId,
          generatedAtMs: now,
          status: 'suppressed',
          reason: 'debounce',
          recoveryOutcome: 'recover_suppressed',
        });
        return;
      }
      recoveryInFlight = true;
      lastRecoveryAtMs = now;
      try {
        logInfo('State recovery requested', {
          firebaseUid,
          recoveryRequestId,
          clientRecoveryRequestId,
        });
        const redis = getRedis();

        const activeRuntime = await resolveActiveRuntimeStateForUser(firebaseUid);
        const callId = activeRuntime.callId;
        if (!callId || !activeRuntime.runtime.session) {
          logInfo('billing_state_recovery_empty', {
            firebaseUid,
            recoveryRequestId,
            clientRecoveryRequestId,
            lookupSource: activeRuntime.source,
            runtimeSource: activeRuntime.runtime.source,
            reason: 'runtime_missing',
          });
          recordRecoveryOutcome(firebaseUid, 'recover_runtime_missing', {
            reason: 'runtime_missing',
          });
          emitBillingRecoverStateResponse(socket, {
            success: true,
            activeCalls: [],
            recoveryRequestId,
            clientRecoveryRequestId,
            generatedAtMs: Date.now(),
            runtimeSource: activeRuntime.runtime.source,
            status: 'no_active_call',
            reason: 'runtime_missing',
            recoveryOutcome: 'recover_runtime_missing',
          });
          return;
        }

        const active = await isCallActive(redis, {
          callId,
          userFirebaseUid: firebaseUid,
        });
        if (!active) {
          logWarning('billing_state_recovery_inactive_call', {
            firebaseUid,
            recoveryRequestId,
            clientRecoveryRequestId,
            callId,
            lookupSource: activeRuntime.source,
            runtimeSource: activeRuntime.runtime.source,
            reason: 'call_inactive',
          });
          recordRecoveryOutcome(firebaseUid, 'recover_empty', {
            reason: 'call_inactive',
          });
          emitBillingRecoverStateResponse(socket, {
            success: true,
            activeCalls: [],
            recoveryRequestId,
            clientRecoveryRequestId,
            generatedAtMs: Date.now(),
            runtimeSource: activeRuntime.runtime.source,
            status: 'no_active_call',
            reason: 'call_inactive',
            recoveryOutcome: 'recover_empty',
          });
          return;
        }

        const runtime = activeRuntime.runtime.session
          ? activeRuntime.runtime
          : await resolveBillingRuntimeState(callId);
        if (!runtime.session) {
          recordRecoveryOutcome(firebaseUid, 'recover_runtime_missing', {
            reason: 'runtime_missing_after_resolve',
          });
          emitBillingRecoverStateResponse(socket, {
            success: true,
            activeCalls: [],
            recoveryRequestId,
            clientRecoveryRequestId,
            generatedAtMs: Date.now(),
            runtimeSource: runtime.source,
            status: 'no_active_call',
            reason: 'runtime_missing_after_resolve',
            recoveryOutcome: 'recover_runtime_missing',
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
        const lifecycleState = String(session.lifecycleState || 'ACTIVE');
        if (
          (lifecycleState === 'STARTING' || lifecycleState === 'RECOVERING') &&
          Number(session.startTime) > 0 &&
          billingSequence <= 0
        ) {
          const bootPayload = {
            callId: session.callId,
            lifecycleState,
            bootstrapping: true,
            billingSequence: 0,
            elapsedSeconds: Math.max(0, Number(session.elapsedSeconds) || 0),
            remainingSeconds: pps > 0 ? Math.floor(balanceMicros / pps) : 0,
            serverTimestamp,
            callStartTime: Number(session.startTime),
          };
          recordRecoveryOutcome(firebaseUid, 'recover_bootstrapping', {
            reason: 'seeded_or_promoting',
          });
          emitBillingRecoverStateFromSnapshot(
            socket,
            [bootPayload],
            {
              recoveryRequestId,
              clientRecoveryRequestId,
              generatedAtMs: serverTimestamp,
              runtimeSource: runtime.source,
              status: 'bootstrapping',
              reason: 'seeded_or_promoting',
              recoveryOutcome: 'recover_bootstrapping',
            }
          );
          return;
        }
        if (billingSequence <= 0 || Number(session.startTime) <= 0 || serverTimestamp <= 0) {
          logWarning('state_recovery_emit_skipped_invalid_tuple', {
            firebaseUid,
            callId,
            billingSequence,
            callStartTime: Number(session.startTime),
            serverTimestamp,
            recoveryRequestId,
            clientRecoveryRequestId,
            lifecycleState,
          });
          recordBillingMetric('state_recovery_invalid_tuple', 1, { callId, firebaseUid });
          recordRecoveryOutcome(firebaseUid, 'recover_tuple_invalid', {
            reason: 'invalid_tuple',
          });
          emitBillingRecoverStateResponse(socket, {
            success: true,
            activeCalls: [],
            recoveryRequestId,
            clientRecoveryRequestId,
            generatedAtMs: serverTimestamp,
            runtimeSource: runtime.source,
            status: 'invalid_tuple',
            reason: 'invalid_tuple',
            recoveryOutcome: 'recover_tuple_invalid',
          });
          return;
        }

        recordRecoveryOutcome(firebaseUid, 'recover_success');
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
            clientRecoveryRequestId,
            generatedAtMs: serverTimestamp,
            runtimeSource: runtime.source,
            status: 'ok',
            reason: 'snapshot',
            recoveryOutcome: 'recover_success',
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
        recordRecoveryOutcome(firebaseUid, 'recover_emit_skipped', { reason: 'exception' });
        emitBillingRecoverStateResponse(socket, {
          success: false,
          error: 'Failed to recover state',
          activeCalls: [],
          recoveryRequestId,
          clientRecoveryRequestId,
          generatedAtMs: Date.now(),
          status: 'error',
          reason: 'exception',
          recoveryOutcome: 'recover_emit_skipped',
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
            logDebug('billing_sync_autoheal_outcome', {
              callId,
              firebaseUid,
              phase,
              outcome: 'deduped',
              dedupeSeconds: SYNC_WARNING_DEDUP_SECONDS,
            });
            return;
          }
          const warningCountKey = billingSyncWarningCountKey(callId, phase);
          const warningCount = await redis.incr(warningCountKey);
          await redis.expire(warningCountKey, 120).catch(() => 0);
          const hasSession = (await redis.exists(callSessionKey(callId))) === 1;
          let lifecycleState: string | undefined;
          let billingSequence: number | undefined;
          if (hasSession) {
            try {
              const sessionRaw = await redis.get(callSessionKey(callId));
              if (sessionRaw) {
                const parsed = JSON.parse(sessionRaw) as {
                  lifecycleState?: string;
                  billingSequence?: number;
                };
                lifecycleState = parsed.lifecycleState;
                billingSequence = Number(parsed.billingSequence) || 0;
              }
            } catch {
              // Non-fatal: sync-warning logging still proceeds.
            }
          }
          logWarning('billing_sync_warning_client', {
            callId,
            firebaseUid,
            phase,
            stuckSeconds: Number(data?.stuckSeconds || 0),
            reportedAt: data?.reportedAt,
            hasSession,
            warningCount,
            lifecycleState,
            billingSequence,
            autohealThreshold: SYNC_WARNING_AUTOHEAL_THRESHOLD,
            willAutoheal: hasSession && warningCount >= SYNC_WARNING_AUTOHEAL_THRESHOLD,
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
              logInfo('billing_sync_autoheal_outcome', {
                callId,
                firebaseUid,
                phase,
                outcome: 'replay_success',
                warningCount,
                lifecycleState,
                billingSequence,
              });
            } else {
              recordBillingMetric('billing_sync_autoheal_replay_miss', 1, {
                callId,
                firebaseUid,
                phase,
              });
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
                recordBillingMetric('billing_sync_autoheal_fallback_snapshot', 1, {
                  callId,
                  firebaseUid,
                  phase,
                });
                logInfo('billing_sync_autoheal_outcome', {
                  callId,
                  firebaseUid,
                  phase,
                  outcome: 'fallback_snapshot',
                  runtimeSource: runtime.source,
                  warningCount,
                  lifecycleState: String(session.lifecycleState || 'ACTIVE'),
                  billingSequence: Math.max(0, Number(session.billingSequence) || 0),
                  balanceMicros: runtime.balanceMicros,
                });
              } else {
                recordBillingMetric('billing_sync_autoheal_fallback_empty', 1, {
                  callId,
                  firebaseUid,
                  phase,
                });
                logWarning('billing_sync_autoheal_outcome', {
                  callId,
                  firebaseUid,
                  phase,
                  outcome: 'fallback_empty',
                  runtimeSource: runtime.source,
                  warningCount,
                  hasSession,
                });
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
