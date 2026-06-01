//D:\zztherapy\backend\src\modules\billing\billing-emitter.service.ts
import { Server, Socket } from 'socket.io';
import { logInfo, logDebug } from '../../utils/logger';

type UserBillingStartedSnapshot = {
  callId: string;
  billingSequence: number;
  lifecycleState: string;
  coins: number;
  introCreditsRemainingApprox: number;
  introPromoActive: boolean;
  pricePerSecond: number;
  pricePerSecondMicros: number;
  maxSeconds?: number;
  elapsedSeconds: number;
  remainingSeconds: number;
  serverTimestamp: number;
  callStartTime: number;
  durationLimit?: number;
};

type CreatorBillingStartedSnapshot = {
  callId: string;
  billingSequence: number;
  lifecycleState: string;
  earnings: number;
  pricePerSecond: number;
  pricePerSecondMicros: number;
  creatorEarningsPerSecond: number;
  creatorSharePercentage: number;
  elapsedSeconds: number;
  serverTimestamp: number;
  callStartTime: number;
};

export function emitBillingStartedFromSnapshot(
  io: Server,
  userFirebaseUid: string,
  creatorFirebaseUid: string,
  userSnapshot: UserBillingStartedSnapshot,
  creatorSnapshot: CreatorBillingStartedSnapshot
): void {
  logInfo('billing_emit_started', {
    callId: userSnapshot.callId,
    userFirebaseUid,
    creatorFirebaseUid,
    billingSequence: userSnapshot.billingSequence,
    lifecycleState: userSnapshot.lifecycleState,
    elapsedSeconds: userSnapshot.elapsedSeconds,
    remainingSeconds: userSnapshot.remainingSeconds,
  });
  io.to(`user:${userFirebaseUid}`).emit('billing:started', userSnapshot);
  io.to(`user:${creatorFirebaseUid}`).emit('billing:started', creatorSnapshot);
}

type BillingUpdateUserSnapshot = {
  callId: string;
  billingSequence: number;
  lifecycleState: string;
  coins: number;
  coinsExact: number;
  elapsedSeconds: number;
  remainingSeconds: number;
  durationLimit: number;
  serverTimestamp: number;
  callStartTime: number;
  introPromoActive: boolean;
  pricePerSecondMicros: number;
};

type BillingUpdateCreatorSnapshot = {
  callId: string;
  billingSequence: number;
  lifecycleState: string;
  earnings: number;
  elapsedSeconds: number;
  durationLimit: number;
  serverTimestamp: number;
  callStartTime: number;
  pricePerSecondMicros: number;
};

export function emitBillingUpdateFromSnapshot(
  io: Server,
  userFirebaseUid: string,
  creatorFirebaseUid: string,
  userSnapshot: BillingUpdateUserSnapshot,
  creatorSnapshot: BillingUpdateCreatorSnapshot
): void {
  logDebug('billing_emit_update', {
    callId: userSnapshot.callId,
    userFirebaseUid,
    creatorFirebaseUid,
    billingSequence: userSnapshot.billingSequence,
    lifecycleState: userSnapshot.lifecycleState,
    elapsedSeconds: userSnapshot.elapsedSeconds,
    remainingSeconds: userSnapshot.remainingSeconds,
  });
  io.to(`user:${userFirebaseUid}`).emit('billing:update', userSnapshot);
  io.to(`user:${creatorFirebaseUid}`).emit('billing:update', creatorSnapshot);
}

export function emitBillingSettledFromSnapshot(
  io: Server,
  userFirebaseUid: string,
  creatorFirebaseUid: string,
  userSnapshot: Record<string, unknown>,
  creatorSnapshot: Record<string, unknown>
): void {
  logInfo('billing_emit_settled', {
    callId: String(userSnapshot.callId ?? creatorSnapshot.callId ?? ''),
    userFirebaseUid,
    creatorFirebaseUid,
  });
  io.to(`user:${userFirebaseUid}`).emit('billing:settled', userSnapshot);
  io.to(`user:${creatorFirebaseUid}`).emit('billing:settled', creatorSnapshot);
}

export function emitBillingRecoverStateFromSnapshot(
  socket: Socket,
  activeCalls: Record<string, unknown>[],
  metadata?: {
    recoveryRequestId?: number;
    clientRecoveryRequestId?: string;
    generatedAtMs?: number;
    runtimeSource?: string;
    status?: string;
    reason?: string;
    recoveryOutcome?: string;
  }
): void {
  emitBillingRecoverStateResponse(socket, {
    success: true,
    activeCalls,
    ...(metadata ?? {}),
  });
}

export function emitBillingRecoverStateResponse(
  socket: Socket,
  payload: {
    success: boolean;
    activeCalls: Record<string, unknown>[];
    error?: string;
    recoveryRequestId?: number;
    clientRecoveryRequestId?: string;
    generatedAtMs?: number;
    runtimeSource?: string;
    status?: string;
    reason?: string;
    recoveryOutcome?: string;
  }
): void {
  logInfo('📡 billing_emit_recover_state', {
    success: payload.success,
    activeCallCount: payload.activeCalls.length,
    callId:
      payload.activeCalls.length > 0
        ? String((payload.activeCalls[0] as { callId?: string }).callId ?? '')
        : undefined,
    recoveryRequestId: payload.recoveryRequestId,
    clientRecoveryRequestId: payload.clientRecoveryRequestId,
    runtimeSource: payload.runtimeSource,
    status: payload.status,
    reason: payload.reason,
    recoveryOutcome: payload.recoveryOutcome,
    error: payload.error,
  });
  socket.emit('billing:recover-state:response', {
    success: payload.success,
    activeCalls: payload.activeCalls,
    ...(payload.error ? { error: payload.error } : {}),
    ...(payload.recoveryRequestId !== undefined
      ? { recoveryRequestId: payload.recoveryRequestId }
      : {}),
    ...(payload.clientRecoveryRequestId
      ? { clientRecoveryRequestId: payload.clientRecoveryRequestId }
      : {}),
    ...(payload.generatedAtMs !== undefined ? { generatedAtMs: payload.generatedAtMs } : {}),
    ...(payload.runtimeSource ? { runtimeSource: payload.runtimeSource } : {}),
    ...(payload.status ? { status: payload.status } : {}),
    ...(payload.reason ? { reason: payload.reason } : {}),
    ...(payload.recoveryOutcome ? { recoveryOutcome: payload.recoveryOutcome } : {}),
  });
}

