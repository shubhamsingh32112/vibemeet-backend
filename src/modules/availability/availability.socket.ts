/**
 * Creator & User Availability Socket.IO Handler
 * 
 * SINGLE SOURCE OF TRUTH for creator and user availability.
 * This replaces all Stream Chat presence logic.
 * 
 * 🔥 FIX 1: Socket connections are AUTHENTICATED
 * - Users/Creators must send Firebase token in handshake
 * - firebaseUid is extracted from verified token
 * - Never trust client-emitted IDs
 * 
 * Events (server → client):
 * - 'creator:status' - Single creator status update
 * - 'user:status' - Single user status update
 * - 'availability:batch' - Batch availability response (creators)
 * - 'user:availability:batch' - Batch availability response (users)
 * 
 * Events (client → server):
 * - 'creator:online' - Creator goes online (authenticated)
 * - 'creator:offline' - Creator goes offline (authenticated)
 * - 'user:online' - User goes online (authenticated)
 * - 'user:offline' - User goes offline (authenticated)
 * - 'availability:get' - Get availability for specific creators
 * - 'user:availability:get' - Get availability for specific users
 */

import { Server, Socket } from 'socket.io';
import { getFirebaseAdmin } from '../../config/firebase';
import { User } from '../user/user.model';
import {
  setAvailability,
  refreshAvailability,
  getBatchAvailability,
  CreatorAvailability,
} from './availability.service';
import {
  setUserAvailability,
  refreshUserAvailability,
  getBatchUserAvailability,
  UserAvailability,
} from './user-availability.service';

// Store Socket.IO server instance for external access
let ioInstance: Server | null = null;

// Track socket -> user mapping (for disconnect handling)
// Key: socket.id, Value: { firebaseUid, isCreator, isUser }
const socketUserMap = new Map<string, { firebaseUid: string; isCreator: boolean; isUser: boolean }>();

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
 * Emit a user status change to all connected clients
 * Can be called from webhooks or other parts of the backend
 */
export function emitUserStatus(firebaseUid: string, status: UserAvailability): void {
  if (ioInstance) {
    ioInstance.emit('user:status', { firebaseUid, status });
    console.log(`📤 [SOCKET] Emitted user:status - ${firebaseUid}: ${status}`);
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
 * Check if a user is a regular user (not creator/admin)
 */
async function isRegularUser(firebaseUid: string): Promise<boolean> {
  try {
    const user = await User.findOne({ firebaseUid });
    return user?.role === 'user' || !user?.role || user?.role === null;
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

    // Check if user is a creator or regular user
    const isCreator = await isUserCreator(decoded.firebaseUid);
    const isUser = await isRegularUser(decoded.firebaseUid);
    
    // Store authenticated data on socket
    socket.data.authenticated = true;
    socket.data.firebaseUid = decoded.firebaseUid;
    socket.data.email = decoded.email;
    socket.data.isCreator = isCreator;
    socket.data.isUser = isUser;
    
    console.log(`✅ [SOCKET AUTH] Authenticated: ${decoded.firebaseUid} (creator: ${isCreator}, user: ${isUser})`);
    next();
  });

  io.on('connection', async (socket: Socket) => {
    const { authenticated, firebaseUid, isCreator, isUser } = socket.data;
    
    console.log(`🔗 [SOCKET] Client connected: ${socket.id}`);
    console.log(`   Authenticated: ${authenticated}, Firebase UID: ${firebaseUid || 'N/A'}, Creator: ${isCreator}, User: ${isUser}`);

    // Heartbeat interval references (for cleanup)
    let creatorHeartbeatInterval: NodeJS.Timeout | null = null;
    let userHeartbeatInterval: NodeJS.Timeout | null = null;

    // If authenticated creator, store mapping and set online
    if (authenticated && isCreator && firebaseUid) {
      socketUserMap.set(socket.id, { firebaseUid, isCreator: true, isUser: false });
      
      // Join creator-specific room
      socket.join(`creator:${firebaseUid}`);
      
      // 🔥 AUTOMATIC ONLINE: Auto-set creator to online when they connect
      // Product requirement: creators are automatically online when app opens
      // No manual toggle - status is automatic based on app lifecycle
      await setAvailability(firebaseUid, 'online');
      
      // Broadcast to ALL clients instantly via Socket.IO (Railway Redis ensures persistence)
      io.emit('creator:status', { creatorId: firebaseUid, status: 'online' });
      
      console.log(`🟢 [SOCKET] Creator automatically set to online on connect: ${firebaseUid}`);
      
      // Send current status back to creator (confirmation)
      socket.emit('creator:status', { creatorId: firebaseUid, status: 'online' });
      
      // 🔥 SCALABILITY: Start heartbeat to refresh TTL (prevents auto-expire while connected)
      // Heartbeat runs every 60s, TTL is 120s - ensures status persists even with network hiccups
      creatorHeartbeatInterval = setInterval(async () => {
        try {
          await refreshAvailability(firebaseUid);
        } catch (err) {
          console.error(`❌ [SOCKET] Creator heartbeat failed for ${firebaseUid}:`, err);
        }
      }, HEARTBEAT_INTERVAL);
    }

    // If authenticated regular user, store mapping and set online
    if (authenticated && isUser && firebaseUid) {
      socketUserMap.set(socket.id, { firebaseUid, isCreator: false, isUser: true });
      
      // Join user-specific room
      socket.join(`user:${firebaseUid}`);
      
      // 🔥 AUTOMATIC ONLINE: Auto-set user to online when they connect
      // Product requirement: users are automatically online when app opens
      // No manual toggle - status is automatic based on app lifecycle
      await setUserAvailability(firebaseUid, 'online');
      
      // Broadcast to ALL clients instantly via Socket.IO (Railway Redis ensures persistence)
      io.emit('user:status', { firebaseUid, status: 'online' });
      
      console.log(`🟢 [SOCKET] User automatically set to online on connect: ${firebaseUid}`);
      
      // Send current status back to user (confirmation)
      socket.emit('user:status', { firebaseUid, status: 'online' });
      
      // 🔥 SCALABILITY: Start heartbeat to refresh TTL (prevents auto-expire while connected)
      // Heartbeat runs every 60s, TTL is 120s - ensures status persists even with network hiccups
      userHeartbeatInterval = setInterval(async () => {
        try {
          await refreshUserAvailability(firebaseUid);
        } catch (err) {
          console.error(`❌ [SOCKET] User heartbeat failed for ${firebaseUid}:`, err);
        }
      }, HEARTBEAT_INTERVAL);
    }

    // 🔥 AUTOMATIC ONLINE: Creator goes online (AUTHENTICATED ONLY)
    // Called automatically when socket connects (no manual toggle)
    // No creatorId parameter - uses authenticated ID from token
    socket.on('creator:online', async () => {
      if (!socket.data.authenticated || !socket.data.isCreator) {
        console.warn(`⚠️  [SOCKET] Unauthorized creator:online from ${socket.id}`);
        return;
      }

      const creatorId = socket.data.firebaseUid;
      if (!creatorId) return;

      await setAvailability(creatorId, 'online');
      
      // Broadcast to ALL clients instantly via Socket.IO
      io.emit('creator:status', { creatorId, status: 'online' });
      
      console.log(`🟢 [SOCKET] Creator automatically online: ${creatorId}`);
    });

    // 🔥 AUTOMATIC OFFLINE: Creator goes offline (AUTHENTICATED ONLY)
    // Called automatically when socket disconnects (no manual toggle)
    socket.on('creator:offline', async () => {
      if (!socket.data.authenticated || !socket.data.isCreator) {
        console.warn(`⚠️  [SOCKET] Unauthorized creator:offline from ${socket.id}`);
        return;
      }

      const creatorId = socket.data.firebaseUid;
      if (!creatorId) return;

      await setAvailability(creatorId, 'busy');
      
      // Broadcast to ALL clients instantly via Socket.IO
      io.emit('creator:status', { creatorId, status: 'busy' });
      
      console.log(`⚫ [SOCKET] Creator automatically offline: ${creatorId}`);
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

    // Client requests availability for specific users (batch)
    socket.on('user:availability:get', async (firebaseUids: string[]) => {
      if (!Array.isArray(firebaseUids)) {
        socket.emit('user:availability:batch', {});
        return;
      }
      
      const availability = await getBatchUserAvailability(firebaseUids);
      socket.emit('user:availability:batch', availability);
      console.log(`📋 [SOCKET] Sent batch user availability to ${socket.id} (${firebaseUids.length} users)`);
    });

    // 🔥 AUTOMATIC ONLINE: User goes online (AUTHENTICATED ONLY)
    // Called automatically when socket connects (no manual toggle)
    socket.on('user:online', async () => {
      if (!socket.data.authenticated || !socket.data.isUser) {
        console.warn(`⚠️  [SOCKET] Unauthorized user:online from ${socket.id}`);
        return;
      }

      const firebaseUid = socket.data.firebaseUid;
      if (!firebaseUid) return;

      await setUserAvailability(firebaseUid, 'online');
      
      // Broadcast to ALL clients instantly via Socket.IO
      io.emit('user:status', { firebaseUid, status: 'online' });
      
      console.log(`🟢 [SOCKET] User automatically online: ${firebaseUid}`);
    });

    // 🔥 AUTOMATIC OFFLINE: User goes offline (AUTHENTICATED ONLY)
    // Called automatically when socket disconnects (no manual toggle)
    socket.on('user:offline', async () => {
      if (!socket.data.authenticated || !socket.data.isUser) {
        console.warn(`⚠️  [SOCKET] Unauthorized user:offline from ${socket.id}`);
        return;
      }

      const firebaseUid = socket.data.firebaseUid;
      if (!firebaseUid) return;

      await setUserAvailability(firebaseUid, 'offline');
      
      // Broadcast to ALL clients instantly via Socket.IO
      io.emit('user:status', { firebaseUid, status: 'offline' });
      
      console.log(`⚫ [SOCKET] User automatically offline: ${firebaseUid}`);
    });

    // 🔥 AUTOMATIC OFFLINE: Handle disconnect - mark creator/user as offline automatically
    socket.on('disconnect', async (reason) => {
      console.log(`🔌 [SOCKET] Client disconnected: ${socket.id} (reason: ${reason})`);
      
      // Clear heartbeat intervals
      if (creatorHeartbeatInterval) {
        clearInterval(creatorHeartbeatInterval);
        creatorHeartbeatInterval = null;
      }
      if (userHeartbeatInterval) {
        clearInterval(userHeartbeatInterval);
        userHeartbeatInterval = null;
      }
      
      const mapping = socketUserMap.get(socket.id);
      
      if (mapping) {
        const { firebaseUid, isCreator, isUser } = mapping;
        
        if (isCreator) {
          // 🔥 AUTOMATIC OFFLINE: Mark creator as busy (offline) on disconnect
          // Product requirement: creators are automatically offline when app closes
          // No manual toggle - status is automatic based on app lifecycle
          await setAvailability(firebaseUid, 'busy');
          
          // Broadcast to ALL clients instantly via Socket.IO
          io.emit('creator:status', { creatorId: firebaseUid, status: 'busy' });
          
          console.log(`⚫ [SOCKET] Creator automatically set to offline on disconnect: ${firebaseUid}`);
        }
        
        if (isUser) {
          // 🔥 AUTOMATIC OFFLINE: Mark user as offline on disconnect
          // Product requirement: users are automatically offline when app closes
          // No manual toggle - status is automatic based on app lifecycle
          await setUserAvailability(firebaseUid, 'offline');
          
          // Broadcast to ALL clients instantly via Socket.IO
          io.emit('user:status', { firebaseUid, status: 'offline' });
          
          console.log(`⚫ [SOCKET] User automatically set to offline on disconnect: ${firebaseUid}`);
        }
        
        // Clean up mapping
        socketUserMap.delete(socket.id);
      }
    });

    // Handle errors
    socket.on('error', (error) => {
      console.error(`❌ [SOCKET] Socket error for ${socket.id}:`, error);
    });
  });

  console.log('✅ [SOCKET] Availability socket handlers registered');
}
