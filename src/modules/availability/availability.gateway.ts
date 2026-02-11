import { Server, Socket } from 'socket.io';
import { getRedis, availabilityKey } from '../../config/redis';
import { getFirebaseAdmin } from '../../config/firebase';

/**
 * Set up Socket.IO gateway for creator availability.
 *
 * Events:
 *   Client → Server:
 *     availability:get  { creatorIds: string[] }   – batch-fetch current statuses
 *
 *   Server → Client:
 *     availability:batch  { [firebaseUid]: "online"|"busy" }  – response to availability:get
 *     creator:status       { creatorId, status }               – real-time incremental update
 */
export function setupAvailabilityGateway(io: Server): void {
  // ── Auth middleware ─────────────────────────────────────────────────────
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (!token) {
        return next(new Error('Authentication error: No token provided'));
      }

      const admin = getFirebaseAdmin();
      const decodedToken = await admin.auth().verifyIdToken(token);
      socket.data.firebaseUid = decodedToken.uid;
      socket.data.email = decodedToken.email;
      console.log(`🔌 [SOCKET] Authenticated: ${decodedToken.uid}`);
      next();
    } catch (err) {
      console.error('❌ [SOCKET] Authentication failed:', err);
      next(new Error('Authentication error: Invalid token'));
    }
  });

  // ── Connection handler ──────────────────────────────────────────────────
  io.on('connection', (socket: Socket) => {
    console.log(
      `🔌 [SOCKET] Client connected: ${socket.id} (uid: ${socket.data.firebaseUid})`
    );

    // ── availability:get ────────────────────────────────────────────────
    socket.on(
      'availability:get',
      async (data: { creatorIds: string[] }) => {
        try {
          if (!data?.creatorIds || !Array.isArray(data.creatorIds)) {
            console.warn('⚠️  [SOCKET] Invalid availability:get payload');
            socket.emit('availability:batch', {});
            return;
          }

          const result: Record<string, string> = {};

          if (data.creatorIds.length === 0) {
            socket.emit('availability:batch', result);
            return;
          }

          const redis = getRedis();

          // Build keys array for batch fetch
          const keys = data.creatorIds.map((id) => availabilityKey(id));

          // MGET: one round-trip for all keys
          const values = await redis.mget<(string | null)[]>(...keys);

          // Map results — null / missing → "busy", "online" → "online"
          for (let i = 0; i < data.creatorIds.length; i++) {
            const val = values[i];
            result[data.creatorIds[i]] = val === 'online' ? 'online' : 'busy';
          }

          console.log(
            `📡 [SOCKET] availability:batch → ${Object.keys(result).length} creator(s)`
          );
          socket.emit('availability:batch', result);
        } catch (err) {
          console.error('❌ [SOCKET] Error handling availability:get:', err);
          socket.emit('availability:batch', {});
        }
      }
    );

    socket.on('disconnect', (reason) => {
      console.log(
        `🔌 [SOCKET] Client disconnected: ${socket.id} (reason: ${reason})`
      );
    });
  });
}

/**
 * Set creator availability in Redis and broadcast to all connected clients.
 * Called from the REST endpoint when a creator toggles their status.
 *
 * Redis contract:
 *   key exists  → value is "online"
 *   key absent  → creator is busy (default)
 */
export async function setCreatorAvailability(
  io: Server,
  creatorFirebaseUid: string,
  status: 'online' | 'busy'
): Promise<void> {
  const redis = getRedis();

  if (status === 'online') {
    await redis.set(availabilityKey(creatorFirebaseUid), 'online');
  } else {
    // Delete key — absence = busy (the universal default)
    await redis.del(availabilityKey(creatorFirebaseUid));
  }

  // Broadcast to ALL connected clients instantly
  io.emit('creator:status', {
    creatorId: creatorFirebaseUid,
    status,
  });

  console.log(
    `📡 [AVAILABILITY] Broadcast creator:status → ${creatorFirebaseUid}: ${status}`
  );
}
