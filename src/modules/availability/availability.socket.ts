/**
 * Creator Availability Socket.IO Handler
 * 
 * SINGLE SOURCE OF TRUTH for creator availability.
 * This replaces all Stream Chat presence logic.
 * 
 * 🔥 FIX 1: Socket connections are AUTHENTICATED
 * - Creators must send Firebase token in handshake
 * - creatorId is extracted from verified token
 * - Never trust client-emitted creatorId
 * 
 * Events (server → client):
 * - 'creator:status' - Single creator status update
 * - 'availability:batch' - Batch availability response
 * 
 * Events (client → server):
 * - 'creator:online' - Creator goes online (authenticated)
 * - 'creator:offline' - Creator goes offline (authenticated)
 * - 'availability:get' - Get availability for specific creators
 */

import { Server, Socket } from 'socket.io';
import { getFirebaseAdmin } from '../../config/firebase';
import { User } from '../user/user.model';
import {
  setAvailability,
  getAvailability,
  refreshAvailability,
  getBatchAvailability,
  CreatorAvailability,
} from './availability.service';

// Store Socket.IO server instance for external access
let ioInstance: Server | null = null;

// Track socket -> creatorId mapping (for disconnect handling)
// Key: socket.id, Value: { creatorId, isCreator }
const socketCreatorMap = new Map<string, { creatorId: string; isCreator: boolean }>();

// Heartbeat interval (in ms) - must be less than TTL (120s)
const HEARTBEAT_INTERVAL = 60000; // 60 seconds

/**
 * Get the Socket.IO server instance
 * Used by webhooks to emit events
 */
export function getIO(): Server | null {
  return ioInstance;
}

/**
 * Emit a creator status change to all connected clients
 * Can be called from webhooks or other parts of the backend
 */
export function emitCreatorStatus(creatorId: string, status: CreatorAvailability): void {
  if (ioInstance) {
    ioInstance.emit('creator:status', { creatorId, status });
    console.log(`📤 [SOCKET] Emitted creator:status - ${creatorId}: ${status}`);
  } else {
    console.warn('⚠️  [SOCKET] Cannot emit: Socket.IO not initialized');
  }
}

/**
 * 🔥 FIX 1: Verify Firebase token from socket handshake
 * Returns the decoded token or null if invalid
 */
async function verifySocketToken(token: string): Promise<{
  firebaseUid: string;
  email?: string;
  phone?: string;
} | null> {
  try {
    const admin = getFirebaseAdmin();
    const decodedToken = await admin.auth().verifyIdToken(token);
    return {
      firebaseUid: decodedToken.uid,
      email: decodedToken.email,
      phone: decodedToken.phone_number,
    };
  } catch (error) {
    console.error('❌ [SOCKET AUTH] Token verification failed:', error);
    return null;
  }
}

/**
 * Check if a user is a creator
 */
async function isUserCreator(firebaseUid: string): Promise<boolean> {
  try {
    const user = await User.findOne({ firebaseUid });
    return user?.role === 'creator' || user?.role === 'admin';
  } catch (error) {
    console.error('❌ [SOCKET] Error checking user role:', error);
    return false;
  }
}

/**
 * Register Socket.IO handlers for availability
 */
export function registerAvailabilitySocket(io: Server): void {
  ioInstance = io;
  
  console.log('🔌 [SOCKET] Registering availability socket handlers');

  // 🔥 FIX 1: Authentication middleware
  // Verifies Firebase token before allowing connection
  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token;
    
    if (!token) {
      // Allow connection without token (for users/guests)
      // But they can't emit creator status
      console.log(`🔗 [SOCKET AUTH] Unauthenticated connection: ${socket.id}`);
      socket.data.authenticated = false;
      socket.data.isCreator = false;
      return next();
    }

    // Verify the token
    const decoded = await verifySocketToken(token);
    
    if (!decoded) {
      console.log(`❌ [SOCKET AUTH] Invalid token for ${socket.id}`);
      return next(new Error('Unauthorized: Invalid token'));
    }

    // Check if user is a creator
    const isCreator = await isUserCreator(decoded.firebaseUid);
    
    // Store authenticated data on socket
    socket.data.authenticated = true;
    socket.data.firebaseUid = decoded.firebaseUid;
    socket.data.email = decoded.email;
    socket.data.isCreator = isCreator;
    
    console.log(`✅ [SOCKET AUTH] Authenticated: ${decoded.firebaseUid} (creator: ${isCreator})`);
    next();
  });

  io.on('connection', async (socket: Socket) => {
    const { authenticated, firebaseUid, isCreator } = socket.data;
    
    console.log(`🔗 [SOCKET] Client connected: ${socket.id}`);
    console.log(`   Authenticated: ${authenticated}, Firebase UID: ${firebaseUid || 'N/A'}, Creator: ${isCreator}`);

    // Heartbeat interval reference (for cleanup)
    let heartbeatInterval: NodeJS.Timeout | null = null;

    // If authenticated creator, store mapping for disconnect handling
    if (authenticated && isCreator && firebaseUid) {
      socketCreatorMap.set(socket.id, { creatorId: firebaseUid, isCreator: true });
      
      // Join creator-specific room
      socket.join(`creator:${firebaseUid}`);
      
      // Send current status back
      const currentStatus = await getAvailability(firebaseUid);
      socket.emit('creator:status', { creatorId: firebaseUid, status: currentStatus });
      
      // 🔥 Start heartbeat to refresh TTL (prevents auto-expire while connected)
      heartbeatInterval = setInterval(async () => {
        await refreshAvailability(firebaseUid);
      }, HEARTBEAT_INTERVAL);
    }

    // 🔥 Creator goes online (AUTHENTICATED ONLY)
    // No creatorId parameter - uses authenticated ID from token
    socket.on('creator:online', async () => {
      if (!socket.data.authenticated || !socket.data.isCreator) {
        console.warn(`⚠️  [SOCKET] Unauthorized creator:online from ${socket.id}`);
        return;
      }

      const creatorId = socket.data.firebaseUid;
      if (!creatorId) return;

      await setAvailability(creatorId, 'online');
      
      // Broadcast to ALL clients
      io.emit('creator:status', { creatorId, status: 'online' });
      
      console.log(`🟢 [SOCKET] Creator online: ${creatorId}`);
    });

    // 🔥 Creator goes offline (AUTHENTICATED ONLY)
    socket.on('creator:offline', async () => {
      if (!socket.data.authenticated || !socket.data.isCreator) {
        console.warn(`⚠️  [SOCKET] Unauthorized creator:offline from ${socket.id}`);
        return;
      }

      const creatorId = socket.data.firebaseUid;
      if (!creatorId) return;

      await setAvailability(creatorId, 'busy');
      
      // Broadcast to ALL clients
      io.emit('creator:status', { creatorId, status: 'busy' });
      
      console.log(`⚫ [SOCKET] Creator offline: ${creatorId}`);
    });

    // Client requests availability for specific creators (batch)
    socket.on('availability:get', async (creatorIds: string[]) => {
      if (!Array.isArray(creatorIds)) {
        socket.emit('availability:batch', {});
        return;
      }
      
      const availability = await getBatchAvailability(creatorIds);
      socket.emit('availability:batch', availability);
      console.log(`📋 [SOCKET] Sent batch availability to ${socket.id} (${creatorIds.length} creators)`);
    });

    // 🔥 FIX 5: Handle disconnect - mark creator as busy
    socket.on('disconnect', async (reason) => {
      console.log(`🔌 [SOCKET] Client disconnected: ${socket.id} (reason: ${reason})`);
      
      // Clear heartbeat interval
      if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
      }
      
      const mapping = socketCreatorMap.get(socket.id);
      
      if (mapping && mapping.isCreator) {
        const { creatorId } = mapping;
        
        // Mark creator as busy on disconnect
        await setAvailability(creatorId, 'busy');
        
        // Broadcast to ALL clients
        io.emit('creator:status', { creatorId, status: 'busy' });
        
        // Clean up mapping
        socketCreatorMap.delete(socket.id);
        
        console.log(`⚫ [SOCKET] Creator disconnected → busy: ${creatorId}`);
      } else {
        // Clean up anyway
        socketCreatorMap.delete(socket.id);
      }
    });

    // Handle errors
    socket.on('error', (error) => {
      console.error(`❌ [SOCKET] Socket error for ${socket.id}:`, error);
    });
  });

  console.log('✅ [SOCKET] Availability socket handlers registered');
}
