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
import { billingService, ensureBillingStartedReplayFreshness, waitForBillingSessionReady } from './billing.service';
import {
  isCallActiveForParticipant,
  isNonTerminalLifecycle,
} from './billing-active-call.service';
import { logError, logInfo, logDebug, logWarning } from '../../utils/logger';
import { checkCallRateLimit } from '../../utils/rate-limit.service';
import { assertBillingRestCallStartedAccess } from './billing-rest-access';
import { COIN_MICROS, BILLING_SESSION_SCHEMA_VERSION, microsToWholeCoinsFloor } from './billing.constants';
import {
  assertNotShuttingDown,
  ShutdownAdmissionRejectedError,
} from './billing-shutdown.service';
import {
  bumpReconnectGeneration,
  getDurableCallSession,
} from './call-session.service';
import { isBillingOwnershipV2Enabled } from './billing-phase-flags';
import { flushBillingPersist, flushBillingPersistForCallId } from './billing-persist.service';
import { recordReconnectGenerationMismatch } from './billing-phase-metrics';
import {
  releaseRecoveryGate,
  tryAcquireRecoveryGate,
  isRecoveryEmptyCached,
  markRecoveryEmptyOutcome,
} from './billing-recovery-gate.service';
import {
  finalizeCallEnd,
  restoreCreatorPresenceForEndedCall,
  markCallEndingForDeferredEnd,
  delegateCallEndSettlementToRetry,
} from '../video/call-finalization.service';
import { billingInstanceIdsMatch, getBillingInstanceId } from './billing-instance-id';
import {
  resolveActiveRuntimeStateForUser,
  resolveBillingRuntimeState,
  type BillingTerminalSnapshot,
  type ResolvedBillingRuntime,
} from './billing-runtime-resolver.service';
import {
  emitBillingRecoverStateFromSnapshot,
  emitBillingRecoverStateResponse,
} from './billing-emitter.service';
import {
  healActiveCallBillingLight,
  isBillingSequenceStalledOnSession,
} from './billing-heal.service';
import { needsBillingCycleReschedule } from './billing.queue';
import { logBillingHealth, logBillingHealthWarn } from './billing-health-log';
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
const SYNC_WARNING_CONNECTED_AUTOHEAL_THRESHOLD = Math.min(
  3,
  Math.max(
    1,
    parseInt(process.env.BILLING_SYNC_WARNING_CONNECTED_AUTOHEAL_THRESHOLD || '1', 10) || 1
  )
);

function buildRecoverSnapshot(
  session: BillingRecoverSession,
  runtime: ResolvedBillingRuntime,
  serverTimestamp: number
):
  | {
      kind: 'bootstrapping' | 'ok';
      payload: Record<string, unknown>;
      reason: string;
      recoveryOutcome: RecoveryOutcome;
    }
  | null {
  const pps =
    session.pricePerSecondMicros ??
    Math.max(1, Math.round((session.pricePerSecond ?? 0) * COIN_MICROS));
  const billingSequence = Math.max(0, Number(session.billingSequence) || 0);
  const lifecycleState = String(session.lifecycleState || 'ACTIVE');
  const balanceMicros = runtime.balanceMicros;
  if (
    (lifecycleState === 'STARTING' || lifecycleState === 'RECOVERING') &&
    Number(session.startTime) > 0 &&
    billingSequence <= 0
  ) {
    return {
      kind: 'bootstrapping',
      reason: 'seeded_or_promoting',
      recoveryOutcome: 'recover_bootstrapping',
      payload: {
        callId: session.callId,
        lifecycleState,
        bootstrapping: true,
        billingSequence: 0,
        elapsedSeconds: Math.max(0, Number(session.elapsedSeconds) || 0),
        remainingSeconds: pps > 0 ? Math.floor(balanceMicros / pps) : 0,
        serverTimestamp,
        callStartTime: Number(session.startTime),
      },
    };
  }
  if (billingSequence <= 0 || Number(session.startTime) <= 0 || serverTimestamp <= 0) {
    return null;
  }

  let earningsMicros = runtime.earningsMicros;
  if ((session.schemaVersion ?? 0) < BILLING_SESSION_SCHEMA_VERSION) {
    earningsMicros = Math.round((earningsMicros * COIN_MICROS) / 10000);
  }

  return {
    kind: 'ok',
    reason: 'snapshot',
    recoveryOutcome: 'recover_success',
    payload: {
      callId: session.callId,
      coins: microsToWholeCoinsFloor(balanceMicros),
      coinsExact: balanceMicros / COIN_MICROS,
      billingSequence,
      lifecycleState,
      pricePerSecond: pps / COIN_MICROS,
      pricePerSecondMicros: pps,
      elapsedSeconds: session.elapsedSeconds,
      remainingSeconds: pps > 0 ? Math.floor(balanceMicros / pps) : 0,
      earnings: Math.round((earningsMicros / COIN_MICROS) * 100) / 100,
      serverTimestamp,
      callStartTime: session.startTime,
    },
  };
}

function buildTerminalRecoverEntry(snapshot: BillingTerminalSnapshot): Record<string, unknown> {
  return {
    callId: snapshot.callId,
    billingSequence: Math.max(0, Number(snapshot.billingSequence) || 0),
    lifecycleState: 'SETTLED',
    elapsedSeconds: Math.max(0, Number(snapshot.elapsedSeconds) || 0),
    durationSeconds: Math.max(0, Number(snapshot.durationSeconds) || 0),
    finalCoins: Math.max(0, Number(snapshot.finalCoins) || 0),
    totalDeducted: Math.max(0, Number(snapshot.totalDeducted) || 0),
    totalEarned: Math.max(0, Number(snapshot.totalEarned) || 0),
    settledAt: Math.max(0, Number(snapshot.settledAt) || Date.now()),
    serverTimestamp: Date.now(),
  };
}

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
          assertNotShuttingDown('call:started');

          const initiatedByFirebaseUid = firebaseUid;
          const initiatedByRole = socket.data.isCreator ? 'creator' : 'user';
          const startCorrelationId = randomUUID();

          const access = assertBillingRestCallStartedAccess(
            firebaseUid,
            data.callId,
            data.creatorFirebaseUid,
            data.creatorMongoId,
            data.userFirebaseUid
          );
          if (!access.ok) {
            socket.emit('billing:error', {
              callId: data.callId,
              error: 'UNAUTHORIZED',
              message: access.error,
              status: access.status,
            });
            return;
          }
          const payerFirebaseUid = access.payerFirebaseUid;

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
        } catch (err) {
          if (err instanceof ShutdownAdmissionRejectedError) {
            socket.emit('billing:error', {
              callId: data.callId,
              error: 'SERVER_DRAINING',
              message: 'Server is shutting down. Please retry on another node.',
            });
            return;
          }
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

    socket.on('call:ended', async (data: { callId: string; reconnectGeneration?: number }) => {
      try {
        assertNotShuttingDown('call:ended');
        logInfo('call:ended received', { callId: data.callId, firebaseUid });

        if (isBillingOwnershipV2Enabled()) {
          const durable = await getDurableCallSession(data.callId);
          if (
            durable &&
            data.reconnectGeneration != null &&
            data.reconnectGeneration < (durable.reconnectGeneration ?? 0)
          ) {
            recordReconnectGenerationMismatch(data.callId);
            logInfo('call:ended_stale_generation_ignored', {
              callId: data.callId,
              eventGeneration: data.reconnectGeneration,
              currentGeneration: durable.reconnectGeneration,
            });
            return;
          }
        }

        const redis = getRedis();
        let sessionForEnd = (await resolveBillingRuntimeState(data.callId)).session;
        if (!sessionForEnd) {
          const waited = await waitForBillingSessionReady(data.callId, { timeoutMs: 2000 });
          if (waited) {
            sessionForEnd = waited;
          }
        }

        const active = sessionForEnd
          ? isNonTerminalLifecycle(sessionForEnd.lifecycleState) &&
            (sessionForEnd.userFirebaseUid === firebaseUid ||
              sessionForEnd.creatorFirebaseUid === firebaseUid)
          : await isCallActiveForParticipant(redis, {
              callId: data.callId,
              participantFirebaseUid: firebaseUid,
            });

        if (!active) {
          await markCallEndingForDeferredEnd(data.callId, 'socket_call_ended');
          await redis.setex(
            pendingCallEndKey(data.callId),
            PENDING_CALL_END_TTL,
            JSON.stringify({
              requestedAtMs: Date.now(),
              source: 'socket_call_ended',
              participantFirebaseUid: firebaseUid,
            })
          );
          recordBillingMetric('deferred_call_end_queued', 1, {
            callId: data.callId,
            source: 'socket_call_ended',
          });
          logInfo('Deferring call:ended (session not ready)', {
            callId: data.callId,
            source: 'socket_call_ended',
          });
          try {
            await restoreCreatorPresenceForEndedCall(
              io,
              data.callId,
              'socket_call_ended.deferred_presence'
            );
          } catch (presenceErr) {
            logError('Deferred call:ended presence restore failed', presenceErr, {
              callId: data.callId,
              firebaseUid,
            });
          }
          return;
        }

        const workerInstanceId = getBillingInstanceId();
        if (
          sessionForEnd &&
          isNonTerminalLifecycle(sessionForEnd.lifecycleState) &&
          sessionForEnd.instanceId &&
          !billingInstanceIdsMatch(sessionForEnd.instanceId, workerInstanceId)
        ) {
          await delegateCallEndSettlementToRetry(
            io,
            data.callId,
            'socket_call_ended',
            'socket_call_ended'
          );
          return;
        }

        await finalizeCallEnd(io, data.callId, 'socket_call_ended');
      } catch (err) {
        logError('Error in call:ended', err, { callId: data.callId, firebaseUid });
      }
    });

    socket.on(
      'billing:recover-state',
      async (payload?: { clientRecoveryRequestId?: string; callId?: string }) => {
      const now = Date.now();
      const recoveryRequestId = ++recoveryRequestSeq;
      const clientRecoveryRequestId =
        typeof payload?.clientRecoveryRequestId === 'string'
          ? payload.clientRecoveryRequestId.trim().slice(0, 128)
          : undefined;
      const requestedCallId =
        typeof payload?.callId === 'string' && payload.callId.trim().length > 0
          ? payload.callId.trim()
          : undefined;
      const emitSuppressedRecoverySnapshot = async (reason: 'in_flight' | 'debounce') => {
        const activeRuntime = await resolveActiveRuntimeStateForUser(firebaseUid, {
          allowScan: false,
        });
        const callId = activeRuntime.callId;
        const recoverySession = activeRuntime.runtime.session;
        const terminalSnapshot = activeRuntime.runtime.terminalSnapshot;
        if (callId && terminalSnapshot) {
          emitBillingRecoverStateResponse(socket, {
            success: true,
            activeCalls: [buildTerminalRecoverEntry(terminalSnapshot)],
            recoveryRequestId,
            clientRecoveryRequestId,
            generatedAtMs: now,
            status: 'terminal_settled',
            reason,
            recoveryOutcome: 'recover_success',
            runtimeSource: activeRuntime.runtime.source,
          });
          return;
        }
        if (!callId || !recoverySession) {
          emitBillingRecoverStateResponse(socket, {
            success: true,
            activeCalls: [],
            recoveryRequestId,
            clientRecoveryRequestId,
            generatedAtMs: now,
            status: 'suppressed',
            reason,
            recoveryOutcome: 'recover_suppressed',
            runtimeSource: activeRuntime.runtime.source,
          });
          return;
        }

        const redis = getRedis();
        const lifecycleState = String(recoverySession.lifecycleState || 'ACTIVE');
        const isSessionParticipant =
          recoverySession.userFirebaseUid === firebaseUid ||
          recoverySession.creatorFirebaseUid === firebaseUid;
        const active =
          isNonTerminalLifecycle(lifecycleState) &&
          (isSessionParticipant ||
            (await isCallActiveForParticipant(redis, {
              callId,
              participantFirebaseUid: firebaseUid,
            })));
        if (!active) {
          emitBillingRecoverStateResponse(socket, {
            success: true,
            activeCalls: [],
            recoveryRequestId,
            clientRecoveryRequestId,
            generatedAtMs: now,
            status: 'suppressed',
            reason,
            recoveryOutcome: 'recover_suppressed',
            runtimeSource: activeRuntime.runtime.source,
          });
          return;
        }

        const serverTimestamp = Date.now();
        const snapshot = buildRecoverSnapshot(recoverySession, activeRuntime.runtime, serverTimestamp);
        if (!snapshot) {
          emitBillingRecoverStateResponse(socket, {
            success: true,
            activeCalls: [],
            recoveryRequestId,
            clientRecoveryRequestId,
            generatedAtMs: serverTimestamp,
            status: 'suppressed',
            reason,
            recoveryOutcome: 'recover_suppressed',
            runtimeSource: activeRuntime.runtime.source,
          });
          return;
        }
        emitBillingRecoverStateFromSnapshot(
          socket,
          [snapshot.payload],
          {
            recoveryRequestId,
            clientRecoveryRequestId,
            generatedAtMs: serverTimestamp,
            runtimeSource: activeRuntime.runtime.source,
            status: 'suppressed',
            reason,
            recoveryOutcome: 'recover_suppressed',
          }
        );
      };

      const gateStatus = await tryAcquireRecoveryGate(firebaseUid, RECOVERY_DEBOUNCE_MS);

      if (gateStatus === 'in_flight') {
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
        await emitSuppressedRecoverySnapshot('in_flight');
        return;
      }
      if (gateStatus === 'debounce') {
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
        await emitSuppressedRecoverySnapshot('debounce');
        return;
      }
      try {
        assertNotShuttingDown('billing:recover-state');

        logInfo('State recovery requested', {
          firebaseUid,
          recoveryRequestId,
          clientRecoveryRequestId,
        });
        const redis = getRedis();

        if (await isRecoveryEmptyCached(firebaseUid)) {
          logInfo('billing_state_recovery_empty', {
            firebaseUid,
            recoveryRequestId,
            clientRecoveryRequestId,
            lookupSource: 'empty_cache',
            runtimeSource: 'missing',
            reason: 'runtime_missing_cached',
            requestedCallId,
          });
          recordRecoveryOutcome(firebaseUid, 'recover_runtime_missing', {
            reason: 'runtime_missing_cached',
          });
          recordBillingMetric('recovery_runtime_missing', 1, {
            firebaseUid,
            reason: 'runtime_missing_cached',
          });
          emitBillingRecoverStateResponse(socket, {
            success: true,
            activeCalls: [],
            recoveryRequestId,
            clientRecoveryRequestId,
            generatedAtMs: Date.now(),
            runtimeSource: 'missing',
            status: 'no_active_call',
            reason: 'runtime_missing_cached',
            recoveryOutcome: 'recover_runtime_missing',
          });
          return;
        }

        const activeRuntime = await resolveActiveRuntimeStateForUser(firebaseUid, {
          allowScan: false,
        });
        const fallbackRuntime =
          !activeRuntime.callId && requestedCallId
            ? await resolveBillingRuntimeState(requestedCallId)
            : null;
        const callId = activeRuntime.callId || requestedCallId || null;
        const resolvedRuntime = activeRuntime.callId ? activeRuntime.runtime : fallbackRuntime;
        if (!callId || (!resolvedRuntime?.session && !resolvedRuntime?.terminalSnapshot)) {
          logInfo('billing_state_recovery_empty', {
            firebaseUid,
            recoveryRequestId,
            clientRecoveryRequestId,
            lookupSource: activeRuntime.source,
            runtimeSource: resolvedRuntime?.source ?? activeRuntime.runtime.source,
            reason: 'runtime_missing',
            requestedCallId,
          });
          recordRecoveryOutcome(firebaseUid, 'recover_runtime_missing', {
            reason: 'runtime_missing',
          });
          recordBillingMetric('recovery_runtime_missing', 1, {
            firebaseUid,
            reason: 'runtime_missing',
          });
          recordBillingMetric('runtime_missing_rate', 1, {
            firebaseUid,
            reason: 'runtime_missing',
          });
          await markRecoveryEmptyOutcome(firebaseUid);
          emitBillingRecoverStateResponse(socket, {
            success: true,
            activeCalls: [],
            recoveryRequestId,
            clientRecoveryRequestId,
            generatedAtMs: Date.now(),
            runtimeSource: resolvedRuntime?.source ?? activeRuntime.runtime.source,
            status: 'no_active_call',
            reason: 'runtime_missing',
            recoveryOutcome: 'recover_runtime_missing',
          });
          return;
        }

        const runtimeForRecovery = resolvedRuntime as ResolvedBillingRuntime;
        let runtimeToEmit = runtimeForRecovery;

        if (runtimeToEmit.terminalSnapshot) {
          const slotStillActive =
            activeRuntime.source === 'slot' && activeRuntime.callId === callId;
          let participantStillInCall = false;
          if (callId) {
            participantStillInCall = await isCallActiveForParticipant(redis, {
              callId,
              participantFirebaseUid: firebaseUid,
            });
          }
          if (slotStillActive || participantStillInCall) {
            logBillingHealthWarn('TERMINAL_BLOCKED_ACTIVE_SLOT', {
              callId,
              firebaseUid,
              recoveryRequestId,
              slotStillActive,
              participantStillInCall,
            });
            await healActiveCallBillingLight(io, callId, 'recovery_terminal_active_call');
            runtimeToEmit = await resolveBillingRuntimeState(callId);
          }
        }

        if (runtimeToEmit.terminalSnapshot) {
          const terminalEntry = buildTerminalRecoverEntry(runtimeToEmit.terminalSnapshot);
          logInfo('billing_state_recovery_terminal', {
            firebaseUid,
            recoveryRequestId,
            clientRecoveryRequestId,
            callId,
            runtimeSource: runtimeToEmit.source,
          });
          emitBillingRecoverStateResponse(socket, {
            success: true,
            activeCalls: [terminalEntry],
            recoveryRequestId,
            clientRecoveryRequestId,
            generatedAtMs: Date.now(),
            runtimeSource: runtimeToEmit.source,
            status: 'terminal_settled',
            reason: 'resolved_from_terminal_tombstone',
            recoveryOutcome: 'recover_success',
          });
          return;
        }

        const recoverySession = runtimeToEmit.session;
        const recoveryLifecycleState = String(recoverySession?.lifecycleState || 'ACTIVE');
        const isSessionParticipant =
          recoverySession != null &&
          (recoverySession.userFirebaseUid === firebaseUid ||
            recoverySession.creatorFirebaseUid === firebaseUid);
        const active =
          recoverySession != null &&
          isNonTerminalLifecycle(recoveryLifecycleState) &&
          (isSessionParticipant ||
            (await isCallActiveForParticipant(redis, {
              callId,
              participantFirebaseUid: firebaseUid,
            })));

        if (!active) {
          const reason =
            recoverySession && isNonTerminalLifecycle(recoveryLifecycleState)
              ? 'participant_mismatch'
              : 'call_inactive';
          const logFn =
            recoverySession && isNonTerminalLifecycle(recoveryLifecycleState)
              ? logWarning
              : logInfo;
          logFn('billing_state_recovery_inactive_call', {
            firebaseUid,
            recoveryRequestId,
            clientRecoveryRequestId,
            callId,
            lookupSource: activeRuntime.source,
            runtimeSource: runtimeToEmit.source,
            lifecycleState: recoveryLifecycleState,
            reason,
          });
          recordRecoveryOutcome(firebaseUid, 'recover_empty', {
            reason,
          });
          emitBillingRecoverStateResponse(socket, {
            success: true,
            activeCalls: [],
            recoveryRequestId,
            clientRecoveryRequestId,
            generatedAtMs: Date.now(),
            runtimeSource: runtimeToEmit.source,
            status: 'no_active_call',
            reason,
            recoveryOutcome: 'recover_empty',
          });
          return;
        }

        const recoverySessionForHeal = runtimeToEmit.session;
        const shouldHealBeforeEmit =
          recoverySessionForHeal != null &&
          (isBillingSequenceStalledOnSession(recoverySessionForHeal) ||
            (await needsBillingCycleReschedule(callId)));

        if (shouldHealBeforeEmit) {
          logBillingHealth('RECOVERY_HEAL_START', {
            callId,
            firebaseUid,
            recoveryRequestId,
            source: 'recovery_pre_emit',
          });
          await healActiveCallBillingLight(io, callId, 'recovery_pre_emit');
        }

        const runtime = await resolveBillingRuntimeState(callId);
        if (!runtime.session) {
          recordRecoveryOutcome(firebaseUid, 'recover_runtime_missing', {
            reason: 'runtime_missing_after_resolve',
          });
          recordBillingMetric('recovery_runtime_missing', 1, {
            firebaseUid,
            reason: 'runtime_missing_after_resolve',
          });
          recordBillingMetric('runtime_missing_rate', 1, {
            firebaseUid,
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

        const serverTimestamp = Date.now();
        const snapshot = buildRecoverSnapshot(session, runtime, serverTimestamp);
        if (!snapshot) {
          const billingSequence = Math.max(0, Number(session.billingSequence) || 0);
          const lifecycleState = String(session.lifecycleState || 'ACTIVE');
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

        if (snapshot.kind === 'bootstrapping') {
          recordRecoveryOutcome(firebaseUid, 'recover_bootstrapping', {
            reason: snapshot.reason,
          });
          emitBillingRecoverStateFromSnapshot(
            socket,
            [snapshot.payload],
            {
              recoveryRequestId,
              clientRecoveryRequestId,
              generatedAtMs: serverTimestamp,
              runtimeSource: runtime.source,
              status: 'bootstrapping',
              reason: snapshot.reason,
              recoveryOutcome: snapshot.recoveryOutcome,
            }
          );
          return;
        }

        recordRecoveryOutcome(firebaseUid, 'recover_success');
        const newGeneration = callId ? await bumpReconnectGeneration(callId) : null;
        if (callId && runtime.session) {
          await flushBillingPersist(
            callId,
            runtime.session as import('./billing.service').CallSession,
            'reconnect'
          ).catch(() => {});
        }
        const payloadWithGeneration = {
          ...snapshot.payload,
          ...(newGeneration != null ? { reconnectGeneration: newGeneration } : {}),
        };
        emitBillingRecoverStateFromSnapshot(
          socket,
          [payloadWithGeneration],
          {
            recoveryRequestId,
            clientRecoveryRequestId,
            generatedAtMs: serverTimestamp,
            runtimeSource: runtime.source,
            status: 'ok',
            reason: snapshot.reason,
            recoveryOutcome: snapshot.recoveryOutcome,
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
        if (err instanceof ShutdownAdmissionRejectedError) {
          emitBillingRecoverStateResponse(socket, {
            success: false,
            error: 'Server draining',
            activeCalls: [],
            recoveryRequestId,
            clientRecoveryRequestId,
            generatedAtMs: Date.now(),
            status: 'error',
            reason: 'server_draining',
            recoveryOutcome: 'recover_emit_skipped',
          });
          return;
        }
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
        await releaseRecoveryGate(firebaseUid).catch(() => {});
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
          const connectedPhase = phase === 'connected';
          const liveLifecycle =
            lifecycleState === 'ACTIVE' ||
            lifecycleState === 'RECOVERING' ||
            lifecycleState === 'STARTING';
          const autohealThreshold = connectedPhase && liveLifecycle
            ? SYNC_WARNING_CONNECTED_AUTOHEAL_THRESHOLD
            : SYNC_WARNING_AUTOHEAL_THRESHOLD;
          const willAutoheal = hasSession && warningCount >= autohealThreshold;
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
            autohealThreshold,
            willAutoheal,
          });
          recordBillingMetric('client_billing_sync_warning', 1, {
            callId,
            firebaseUid,
            phase,
            hasSession: hasSession ? '1' : '0',
          });
          if (willAutoheal) {
            recordBillingMetric('billing_sync_autoheal_triggered', 1, {
              callId,
              firebaseUid,
              phase,
            });
            const healResult = await healActiveCallBillingLight(io, callId, `sync_warning_${phase}`).catch(
              (healErr) => {
                logError('billing_sync_autoheal heal failed', healErr, { callId });
                return { healed: false, hadSession: false };
              }
            );
            const replayed = healResult.hadSession
              ? await ensureBillingStartedReplayFreshness(io, callId, 'sync_warning_autoheal', {
                  force: true,
                  startIngress: 'socket',
                  replayReason: `sync_warning_${phase}`,
                })
              : false;
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
      try {
        const activeRuntime = await resolveActiveRuntimeStateForUser(firebaseUid);
        const callId = activeRuntime.callId;
        const session = activeRuntime.runtime.session;
        if (!callId || !session) return;
        const flushReason =
          session.creatorFirebaseUid === firebaseUid ? 'creator_disconnect' : 'disconnect';
        await flushBillingPersistForCallId(
          callId,
          flushReason,
          session as import('./billing.service').CallSession
        );
      } catch {
        // best-effort billing persist on disconnect
      }
    });
  });
}
