import { Server } from 'socket.io';
import { CreatorAvailability } from './availability.service';
import { UserAvailability } from './user-availability.service';
import { logWarning } from '../../utils/logger';

let ioInstance: Server | null = null;

export function getIO(): Server | null {
  return ioInstance;
}

export function emitCreatorStatus(_creatorId: string, _status: CreatorAvailability): void {
  throw new Error(
    'emitCreatorStatus is disabled. Presence emits must originate from transitionCreatorPresence in presence.service.ts'
  );
}

export function emitUserStatus(firebaseUid: string, status: UserAvailability): void {
  if (!ioInstance) {
    return;
  }
  ioInstance.to('creators').emit('user:status', { firebaseUid, status });
}

export function registerAvailabilitySocket(io: Server): void {
  ioInstance = io;
  if (process.env.ENABLE_LEGACY_AVAILABILITY_SOCKET === 'true') {
    throw new Error(
      'ENABLE_LEGACY_AVAILABILITY_SOCKET=true is not supported. availability.gateway.ts is the only authoritative presence path.'
    );
  }
  logWarning(
    'registerAvailabilitySocket remains intentionally disabled; availability.gateway.ts is authoritative.',
    {}
  );
}

