import type { Server } from 'socket.io';
import { logDebug } from '../../utils/logger';

let ioRef: Server | null = null;

export function setupMomentsGateway(io: Server): void {
  ioRef = io;
  logDebug('Moments Socket.IO gateway registered');
}

export function emitMomentUploaded(creatorId: string, momentId: string): void {
  ioRef?.emit('moment:uploaded', { creatorId, momentId });
}

export function emitStoryUploaded(creatorId: string): void {
  ioRef?.emit('story:uploaded', { creatorId });
}

export function emitMomentPurchased(
  buyerFirebaseUid: string,
  payload: {
    momentId: string;
    buyerUserId: string;
    purchaseCount: number;
    item: Record<string, unknown>;
  },
): void {
  ioRef?.to(`user:${buyerFirebaseUid}`).emit('moment:purchased', payload);
}

export function emitMomentPurchaseCountToCreator(
  creatorFirebaseUid: string,
  payload: {
    momentId: string;
    purchaseCount: number;
  },
): void {
  ioRef?.to(`user:${creatorFirebaseUid}`).emit('moment:purchase_count', payload);
}

export function emitCreatorFollowed(
  firebaseUid: string,
  payload: {
    followerUserId: string;
    creatorId: string;
    followerCount: number;
    isFollowing: boolean;
  },
): void {
  ioRef?.to(`user:${firebaseUid}`).emit('creator:followed', payload);
}

export function emitMediaReady(firebaseUid: string, sessionId: string): void {
  ioRef?.to(`user:${firebaseUid}`).emit('media:ready', { sessionId });
}
