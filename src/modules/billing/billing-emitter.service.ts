import { Server, Socket } from 'socket.io';

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
  io.to(`user:${userFirebaseUid}`).emit('billing:settled', userSnapshot);
  io.to(`user:${creatorFirebaseUid}`).emit('billing:settled', creatorSnapshot);
}

export function emitBillingRecoverStateFromSnapshot(
  socket: Socket,
  activeCalls: Record<string, unknown>[]
): void {
  emitBillingRecoverStateResponse(socket, {
    success: true,
    activeCalls,
  });
}

export function emitBillingRecoverStateResponse(
  socket: Socket,
  payload: { success: boolean; activeCalls: Record<string, unknown>[]; error?: string }
): void {
  socket.emit('billing:recover-state:response', {
    success: payload.success,
    activeCalls: payload.activeCalls,
    ...(payload.error ? { error: payload.error } : {}),
  });
}

