import { Server as SocketIOServer } from 'socket.io';
import type { Server as HTTPServer } from 'http';
import type { Socket } from 'socket.io';
import { getAuth } from 'firebase-admin/auth';
import { getFirebaseAdmin } from './config/firebase';
import { User } from './modules/user/user.model';
import { Call } from './modules/call/call.model';
import { normalizeId } from './utils/id-utils';

let io: SocketIOServer | null = null;

/**
 * Initialize Socket.IO server
 */
export const initSocket = (server: HTTPServer): SocketIOServer => {
  io = new SocketIOServer(server, {
    cors: {
      origin: '*', // Allow all origins for development
      methods: ['GET', 'POST'],
      credentials: true,
    },
    transports: ['websocket', 'polling'],
  });

  // Authentication middleware
  io.use(async (socket: Socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      
      if (!token) {
        console.error('❌ [SOCKET] No token provided');
        return next(new Error('Unauthorized: No token provided'));
      }

      // Verify Firebase token
      const decoded = await getAuth(getFirebaseAdmin()).verifyIdToken(token);
      
      // Get user from database
      const user = await User.findOne({ firebaseUid: decoded.uid });
      if (!user) {
        console.error('❌ [SOCKET] User not found in database');
        return next(new Error('Unauthorized: User not found'));
      }

      // Attach user info to socket
      socket.data.user = {
        firebaseUid: decoded.uid,
        userId: user._id.toString(),
        email: user.email,
        phone: user.phone,
        role: user.role,
      };

      console.log(`✅ [SOCKET] Authenticated: ${socket.data.user.firebaseUid} (${socket.data.user.role})`);
      next();
    } catch (error: any) {
      console.error('❌ [SOCKET] Authentication error:', error.message);
      next(new Error('Unauthorized: Invalid token'));
    }
  });

  // Connection handler
  io.on('connection', async (socket: Socket) => {
    const user = socket.data.user;
    const firebaseUid = user.firebaseUid;
    
    console.log(`🔌 [SOCKET] Client connected: ${socket.id}`);
    console.log(`   User: ${firebaseUid} (${user.role})`);

    // Join user-specific room (using Firebase UID as room name)
    socket.join(firebaseUid);
    console.log(`   📍 Joined room: ${firebaseUid}`);

    // 🔥 CRITICAL FIX: Replay missed incoming_call events on connect
    // This handles the case where creator was offline when call was initiated
    // Timeline: Caller initiates → creator offline → incoming_call lost → creator logs in → THIS CODE RUNS
    // HTTP = truth, Socket.IO = notification, Database = memory
    // Sockets do NOT queue - replays must be manual
    if (user.role === 'creator' || user.role === 'admin') {
      try {
        // user.userId is already the MongoDB ObjectId string from auth middleware
        // Find the user document to get the ObjectId reference
        const creatorUser = await User.findById(user.userId);
        if (creatorUser) {
          // Query for pending ringing calls for this creator
          const pendingCalls = await Call.find({
            creatorUserId: creatorUser._id,
            status: 'ringing',
          })
            .populate('callerUserId', 'username avatar')
            .sort({ createdAt: 1 }) // Oldest first (FIFO - first missed call first)
            .limit(10); // Limit to most recent 10 calls

          if (pendingCalls.length > 0) {
            console.log(`📞 [SOCKET] 🔥 CRITICAL: Found ${pendingCalls.length} pending call(s) for creator ${firebaseUid}`);
            console.log(`   💡 Replaying missed incoming_call events (creator was offline when calls were initiated)`);
            console.log(`   📋 Sockets do NOT queue - this is manual replay from database`);
            
            // Emit incoming_call events for each pending call
            for (const call of pendingCalls) {
              try {
                socket.emit('incoming_call', {
                  callId: call.callId,
                  channelName: call.channelName,
                  caller: {
                    id: normalizeId(call.callerUserId),
                    username: (call.callerUserId as any).username,
                    avatar: (call.callerUserId as any).avatar,
                  },
                  createdAt: call.createdAt,
                });
                console.log(`   ✅ Replayed incoming_call: ${call.callId} (created at ${call.createdAt.toISOString()})`);
              } catch (error) {
                console.error(`   ❌ Failed to replay call ${call.callId}:`, error);
              }
            }
          } else {
            console.log(`   ✅ No pending calls for creator ${firebaseUid}`);
          }
        } else {
          console.log(`   ⚠️  Creator user document not found for userId: ${user.userId}`);
        }
      } catch (error) {
        console.error(`❌ [SOCKET] Error checking pending calls for creator ${firebaseUid}:`, error);
        // Don't fail connection if this check fails - socket connection should succeed
      }
    }

    // Handle disconnection
    socket.on('disconnect', async (reason) => {
      console.log(`❌ [SOCKET] Client disconnected: ${socket.id}`);
      console.log(`   User: ${firebaseUid}`);
      console.log(`   Reason: ${reason}`);
      
      // 🔥 FIX #1: Auto-mark ringing calls as missed when creator disconnects
      // If creator disappears → the call is over. Telecom rule #1.
      if (user.role === 'creator' || user.role === 'admin') {
        try {
          const creatorUser = await User.findById(user.userId);
          if (creatorUser) {
            // Find all ringing calls for this creator
            const ringingCalls = await Call.find({
              creatorUserId: creatorUser._id,
              status: 'ringing',
            }).populate('callerUserId');
            
            if (ringingCalls.length > 0) {
              console.log(`🚨 [SOCKET] Creator disconnected with ${ringingCalls.length} ringing call(s) - marking as missed`);
              
              const io = getIO();
              
              for (const call of ringingCalls) {
                // Update call to missed
                call.status = 'missed';
                call.endedAt = new Date();
                await call.save();
                
                console.log(`   ✅ Marked call ${call.callId} as missed`);
                
                // Notify caller that call was missed
                const caller = await User.findById(call.callerUserId);
                if (caller?.firebaseUid) {
                  io.to(caller.firebaseUid).emit('call_ended', {
                    callId: call.callId,
                    status: 'missed',
                    endedBy: 'system',
                    reason: 'creator_disconnected',
                  });
                  console.log(`   📡 Emitted call_ended (missed) to caller: ${caller.firebaseUid}`);
                }
              }
            }
          }
        } catch (error) {
          console.error(`❌ [SOCKET] Error handling creator disconnect cleanup:`, error);
          // Don't fail disconnect if cleanup fails
        }
      }
    });

    // Handle errors
    socket.on('error', (error) => {
      console.error(`❌ [SOCKET] Error for ${firebaseUid}:`, error);
    });
  });

  console.log('✅ [SOCKET] Socket.IO initialized');
  return io;
};

/**
 * Get Socket.IO instance
 */
export const getIO = (): SocketIOServer => {
  if (!io) {
    throw new Error('Socket.IO not initialized. Call initSocket() first.');
  }
  return io;
};
