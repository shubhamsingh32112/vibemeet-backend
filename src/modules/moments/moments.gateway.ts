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

export function emitMomentPurchased(momentId: string, purchaseCount: number): void {
  ioRef?.emit('moment:purchased', { momentId, purchaseCount });
}

export function emitCreatorFollowed(creatorId: string, followerCount?: number): void {
  ioRef?.emit('creator:followed', { creatorId, followerCount });
}

export function emitMediaReady(firebaseUid: string, sessionId: string): void {
  ioRef?.to(`user:${firebaseUid}`).emit('media:ready', { sessionId });
}
