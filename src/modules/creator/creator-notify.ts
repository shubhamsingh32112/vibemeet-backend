import { getIO } from '../../config/socket';

/**
 * Emit `creator:data_updated` to a specific creator's socket room.
 */
export function emitCreatorDataUpdated(
  creatorFirebaseUid: string,
  payload: {
    reason: string;
    [key: string]: unknown;
  }
): void {
  try {
    const io = getIO();
    io.to(`user:${creatorFirebaseUid}`).emit('creator:data_updated', {
      ...payload,
      timestamp: new Date().toISOString(),
    });
    // eslint-disable-next-line no-console
    console.log(
      `📡 [CREATOR] Emitted creator:data_updated to ${creatorFirebaseUid} (reason: ${payload.reason})`
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('⚠️ [CREATOR] Failed to emit creator:data_updated:', err);
  }
}
