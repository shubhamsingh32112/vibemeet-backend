import { Call } from './call.model';
import { WebhookEvent } from './webhook-event.model';
import { User } from '../user/user.model';
import { Creator } from '../creator/creator.model';
import { getStreamClient } from '../../config/stream';
import { getIO } from '../../config/socket';
import { handleCallStartedHttp, settleCallHttp } from '../billing/billing.gateway';
import { getRedis, callSessionKey, webhookIdKey, WEBHOOK_IDEMPOTENCY_TTL } from '../../config/redis';
import { logError, logInfo } from '../../utils/logger';
import { transitionCallStatus } from './call-state.service';
import { releaseCreatorCallLock, updateCreatorAvailabilityAfterCall } from './creator-call-lock.service';
import { recordCallMetric } from '../../utils/monitoring';
import { setAvailability, getAvailability } from '../availability/availability.service';
import { emitCreatorStatus } from '../availability/availability.socket';

export interface StreamVideoWebhookPayload {
  type: string;
  call?: {
    id: string;
    type: string;
    cid: string;
    created_by?: {
      id: string;
    };
    settings?: {
      max_participants?: number;
    };
    members?: Array<{
      user_id: string;
      role?: string;
    }>;
  };
  call_cid?: string;
  session_id?: string;
  session?: {
    id: string;
    started_at?: string;
    ended_at?: string;
    participants?: Array<{
      user_id: string;
      role?: string;
    }>;
  };
  created_at?: string;
}

/**
 * Narrow domain service responsible for interpreting Stream webhook payloads
 * into call lifecycle transitions, billing orchestration hooks, availability,
 * and chat side-effects.
 *
 * Transport-specific concerns (Express, HTTP responses, signature verification)
 * must live in controllers / middlewares, not here.
 */
export class CallLifecycleService {
  /**
   * Persist the raw webhook event and apply idempotency (Mongo + Redis).
   * Returns `false` if this exact event has already been processed.
   */
  async persistAndApplyIdempotency(payload: StreamVideoWebhookPayload): Promise<boolean> {
    const eventIdParts = [
      payload.type || 'unknown',
      payload.call_cid || payload.call?.id || 'no-call',
      payload.session_id || payload.session?.id || 'no-session',
      payload.created_at || '',
    ];
    const eventId = eventIdParts.join(':');

    const startedAtMs = Date.now();

    try {
      await WebhookEvent.create({
        eventId,
        type: payload.type,
        callCid: payload.call_cid,
        callId: payload.call?.id,
        sessionId: payload.session_id || payload.session?.id,
        rawPayload: payload,
      });
    } catch (dbErr: any) {
      if (dbErr?.code === 11000) {
        logInfo('Skipping duplicate webhook (Mongo idempotent)', {
          type: payload.type,
          eventId,
        });
        recordCallMetric('webhook.duplicate_mongo', 1, {
          type: payload.type || 'unknown',
        });
        return false;
      }
      logError('Failed to persist webhook event', dbErr, {
        webhookType: payload.type,
        eventId,
      });
      recordCallMetric('webhook.persist_error', 1, {
        type: payload.type || 'unknown',
      });
    }

    try {
      const redis = getRedis();
      const idKey = webhookIdKey(eventId);

      const lockResult = await redis.set(idKey, '1', 'EX', WEBHOOK_IDEMPOTENCY_TTL, 'NX');
      const acquired = lockResult === 'OK';

      if (!acquired) {
        logInfo('Skipping duplicate webhook (Redis idempotent)', {
          type: payload.type,
          eventId,
        });
        recordCallMetric('webhook.duplicate_redis', 1, {
          type: payload.type || 'unknown',
        });
        return false;
      }
    } catch (idErr) {
      logError('Failed to apply webhook idempotency', idErr, {
        webhookType: payload.type,
      });
      recordCallMetric('webhook.idempotency_error', 1, {
        type: payload.type || 'unknown',
      });
    }

    const latencyMs = startedAtMs - (payload.created_at ? Date.parse(payload.created_at) || startedAtMs : startedAtMs);
    recordCallMetric('webhook.persisted', latencyMs, {
      type: payload.type || 'unknown',
    });

    return true;
  }

  /**
   * Entry point for routing a validated, idempotent webhook payload.
   * Keeps the branching logic out of the HTTP layer.
   */
  async routeEvent(payload: StreamVideoWebhookPayload): Promise<void> {
    const callId = this.getCallIdFromPayload(payload) ?? undefined;

    logInfo('Routing Stream Video webhook', {
      type: payload.type,
      callId,
      sessionId: payload.session_id || payload.session?.id,
    });

    recordCallMetric('webhook.routed', 1, {
      type: payload.type || 'unknown',
    });

    switch (payload.type) {
      case 'call.ended':
        await this.handleCallEnded(payload);
        return;
      case 'call.session_started':
        await this.handleSessionStarted(payload);
        return;
      case 'call.session_ended':
        await this.handleSessionEnded(payload);
        return;
      case 'call.ringing':
      case 'call.created':
        await this.handleCallRinging(payload);
        return;
      case 'call.accepted':
        await this.handleCallAccepted(payload);
        return;
      default:
        logInfo('Unhandled webhook type', { type: payload.type });
        recordCallMetric('webhook.unhandled', 1, {
          type: payload.type || 'unknown',
        });
    }
  }

  private getCallIdFromPayload(payload: StreamVideoWebhookPayload): string | null {
    return payload.call?.id || payload.call_cid?.split(':')[1] || null;
  }

  /**
   * Handle call.ended event:
   * - Settle billing (Redis-based)
   * - Ensure Call document exists & mark ended
   * - Release creator lock & update availability
   */
  private async handleCallEnded(payload: StreamVideoWebhookPayload): Promise<void> {
    const callId = this.getCallIdFromPayload(payload);

    if (!callId) {
      logError('call.ended missing call ID', new Error('Missing callId'), {});
      return;
    }

    logInfo('Call ended (webhook)', { callId });

    try {
      const io = getIO();
      await settleCallHttp(io, callId);
      logInfo('Redis billing settled for call', { callId });
    } catch (error) {
      logError('Failed to settle billing for call.ended', error, { callId });
    }

    let call = await Call.findOne({ callId });
    if (!call) {
      logInfo('Call record not found, creating from webhook payload', { callId });

      const members = payload.call?.members || payload.session?.participants || [];
      const callerMember = members.find((m) => m.role === 'admin') || members[0];
      const creatorMember =
        members.find((m) => m.role === 'call_member') ||
        members.find((m) => m.user_id && callerMember && m.user_id !== callerMember.user_id);

      if (!callerMember?.user_id || !creatorMember?.user_id) {
        logError(
          'Unable to infer caller/creator from payload for call.ended',
          new Error('Missing members'),
          { callId }
        );
        return;
      }

      const callerUser = await User.findOne({ firebaseUid: callerMember.user_id });
      const creatorUser = await User.findOne({ firebaseUid: creatorMember.user_id });

      if (!callerUser || !creatorUser) {
        logError(
          'Unable to resolve caller/creator users for call.ended',
          new Error('Missing users'),
          { callId }
        );
        return;
      }

      call = await Call.create({
        callId,
        callerUserId: callerUser._id,
        creatorUserId: creatorUser._id,
        status: 'accepted',
        billedSeconds: 0,
        userCoinsSpent: 0,
        creatorCoinsEarned: 0,
        isForceEnded: false,
        isSettled: false,
      });
    }

    transitionCallStatus(call, 'ended', {
      source: 'webhook.call.ended',
      eventType: payload.type,
    });

    if (!call.isSettled) {
      call.isSettled = true;
    }

    // Delegate lock release & availability updates to creator-call-lock.service
    await releaseCreatorCallLock(call.creatorUserId.toString());
    await updateCreatorAvailabilityAfterCall(call.creatorUserId.toString());

    await call.save();
    logInfo('Call marked as ended (call.ended)', { callId });
  }

  /**
   * Handle call.session_started:
   * - Ensure Call exists and startedAt is set
   * - Idempotently start Redis billing via billing gateway
   * - Ensure creator marked busy (CRITICAL - this is the most reliable webhook)
   */
  private async handleSessionStarted(payload: StreamVideoWebhookPayload): Promise<void> {
    const callId = this.getCallIdFromPayload(payload);
    const sessionId = payload.session_id || payload.session?.id;

    if (!callId) {
      logError(
        'call.session_started missing call ID',
        new Error('Missing callId'),
        {}
      );
      return;
    }

    logInfo('Session started (webhook)', { callId, sessionId });

    // 🔥 FIX: Create call record if it doesn't exist (for SDK-created calls)
    // This ensures we can extract creator UID even if call wasn't created via REST API
    await this.ensureCallRecordExists(payload, callId);

    const call = await Call.findOne({ callId });
    if (!call) {
      logError(
        'Call record not found for session_started after ensureCallRecordExists',
        new Error('Call missing'),
        { callId, payloadMembers: payload.call?.members, sessionParticipants: payload.session?.participants }
      );
      
      // 🔥 FALLBACK: Try to mark creator busy even without call record
      // Extract creator UID directly from payload
      const creatorFirebaseUid = await this.extractCreatorFirebaseUid(payload, callId);
      if (creatorFirebaseUid) {
        logInfo('Marking creator busy from session_started (fallback, no call record)', {
          callId,
          creatorFirebaseUid,
        });
        await this.markCreatorBusy(creatorFirebaseUid);
      }
      return;
    }

    const redis = getRedis();
    const existingSession = await redis.get(callSessionKey(callId));
    if (existingSession) {
      logInfo('Billing already started for call (idempotent)', { callId });
      
      // 🔥 FIX: Still mark creator busy even if billing already started
      // This ensures status is correct even if webhook fires multiple times
      const creatorUser = await User.findById(call.creatorUserId);
      if (creatorUser?.firebaseUid) {
        logInfo('Marking creator busy (session_started, billing already started)', {
          callId,
          creatorFirebaseUid: creatorUser.firebaseUid,
        });
        await this.markCreatorBusy(creatorUser.firebaseUid);
      }
      return;
    }

    call.startedAt = payload.session?.started_at
      ? new Date(payload.session.started_at)
      : new Date();

    if (call.status === 'ringing') {
      transitionCallStatus(call, 'accepted', {
        source: 'webhook.call.session_started',
        eventType: payload.type,
      });
    }

    call.billedSeconds = 0;
    call.userCoinsSpent = 0;
    call.creatorCoinsEarned = 0;
    call.isSettled = false;
    call.isForceEnded = false;

    await call.save();
    logInfo('Call session start persisted', { callId, startedAt: call.startedAt });

    // 🔥 CRITICAL: Mark creator busy when session starts (most reliable webhook)
    // This ensures creator is marked busy even if call.ringing webhook didn't fire
    const creatorUser = await User.findById(call.creatorUserId);
    if (creatorUser?.firebaseUid) {
      logInfo('Marking creator busy (session_started)', {
        callId,
        creatorFirebaseUid: creatorUser.firebaseUid,
      });
      const success = await this.markCreatorBusy(creatorUser.firebaseUid);
      if (!success) {
        logError(
          'Failed to mark creator busy on session_started',
          new Error('markCreatorBusy returned false'),
          { callId, creatorFirebaseUid: creatorUser.firebaseUid }
        );
      }
    } else {
      logError(
        'Cannot mark creator busy: creator user missing firebaseUid',
        new Error('Missing firebaseUid'),
        { callId, creatorUserId: call.creatorUserId }
      );
    }

    const callerUser = await User.findById(call.callerUserId);
    if (!callerUser || !callerUser.firebaseUid) {
      logError(
        'Caller user not found for session_started',
        new Error('Missing caller'),
        { callId }
      );
      return;
    }

    const creator = await Creator.findOne({ userId: call.creatorUserId });
    if (!creator) {
      logError(
        'Creator not found for session_started',
        new Error('Missing creator'),
        { callId }
      );
      return;
    }

    if (!creatorUser?.firebaseUid) {
      logError(
        'Creator user missing firebaseUid for session_started',
        new Error('Missing creator firebaseUid'),
        { callId }
      );
      return;
    }

    try {
      const io = getIO();
      await handleCallStartedHttp(io, callerUser.firebaseUid, {
        callId,
        creatorFirebaseUid: creatorUser.firebaseUid,
        creatorMongoId: creator._id.toString(),
      });
      logInfo('Redis billing started for call', { callId });
    } catch (error) {
      logError('Failed to start Redis billing for call', error, { callId });
    }
  }

  /**
   * Handle call.session_ended:
   * - Settle Redis billing
   * - Finalize Call document
   * - Release creator lock & update availability
   * - Post chat activity
   */
  private async handleSessionEnded(payload: StreamVideoWebhookPayload): Promise<void> {
    const callId = this.getCallIdFromPayload(payload);
    const sessionId = payload.session_id || payload.session?.id;

    if (!callId) {
      logError(
        'call.session_ended missing call ID',
        new Error('Missing callId'),
        {}
      );
      return;
    }

    logInfo('Session ended (webhook)', { callId, sessionId });

    try {
      const io = getIO();
      await settleCallHttp(io, callId);
      logInfo('Redis billing settled for call (session_ended)', { callId });
    } catch (error) {
      logError('Failed to settle billing for session_ended', error, { callId });
    }

    const call = await Call.findOne({ callId });
    if (!call) {
      logInfo('Call record not found for session_ended', { callId });
      return;
    }

    if (call.isSettled) {
      logInfo('Call already settled, just releasing creator lock', { callId });
      await releaseCreatorCallLock(call.creatorUserId.toString());
      return;
    }

    if (!call.endedAt && payload.session?.ended_at) {
      call.endedAt = new Date(payload.session.ended_at);
    } else if (!call.endedAt) {
      call.endedAt = new Date();
    }

    if (call.startedAt && call.endedAt) {
      call.durationSeconds = Math.floor(
        (call.endedAt.getTime() - call.startedAt.getTime()) / 1000
      );
    }

    if (call.status !== 'ended') {
      transitionCallStatus(call, 'ended', {
        source: 'webhook.call.session_ended',
        eventType: payload.type,
      });
    }

    call.isSettled = true;

    await releaseCreatorCallLock(call.creatorUserId.toString());
    await updateCreatorAvailabilityAfterCall(call.creatorUserId.toString());
    await call.save();

    // Note: Chat activity message is posted by settleCall() in billing.gateway.ts
    // to avoid duplicates. No need to post here.
  }

  /**
   * Mark creator busy when call is ringing / created.
   */
  private async handleCallRinging(payload: StreamVideoWebhookPayload): Promise<void> {
    const callId = this.getCallIdFromPayload(payload);

    if (!callId) {
      logError(
        'call.ringing missing call ID',
        new Error('Missing callId'),
        { payloadType: payload.type, payloadCall: payload.call }
      );
      return;
    }

    logInfo('Call ringing (webhook)', { callId, payloadType: payload.type });

    // 🔥 FIX: Create call record if it doesn't exist (for SDK-created calls)
    // This ensures we can extract creator UID even if call wasn't created via REST API
    await this.ensureCallRecordExists(payload, callId);

    const creatorFirebaseUid = await this.extractCreatorFirebaseUid(payload, callId);
    if (!creatorFirebaseUid) {
      logError(
        'Could not extract creator Firebase UID from ringing payload',
        new Error('Missing creator uid'),
        { 
          callId,
          payloadMembers: payload.call?.members,
          payloadCallId: payload.call?.id,
        }
      );
      return;
    }

    logInfo('Marking creator busy (call ringing)', { callId, creatorFirebaseUid });
    const success = await this.markCreatorBusy(creatorFirebaseUid);
    if (!success) {
      logError(
        'Failed to mark creator busy on call ringing',
        new Error('markCreatorBusy returned false'),
        { callId, creatorFirebaseUid }
      );
    }
  }

  /**
    * Fallback busy-marking when call is accepted.
    */
  private async handleCallAccepted(payload: StreamVideoWebhookPayload): Promise<void> {
    const callId = this.getCallIdFromPayload(payload);

    if (!callId) {
      logError(
        'call.accepted missing call ID',
        new Error('Missing callId'),
        { payloadType: payload.type, payloadCall: payload.call }
      );
      return;
    }

    logInfo('Call accepted (webhook)', { callId, payloadType: payload.type });

    // 🔥 FIX: Create call record if it doesn't exist (for SDK-created calls)
    await this.ensureCallRecordExists(payload, callId);

    const creatorFirebaseUid = await this.extractCreatorFirebaseUid(payload, callId);
    if (!creatorFirebaseUid) {
      logError(
        'Could not extract creator Firebase UID from accepted payload',
        new Error('Missing creator uid'),
        { 
          callId,
          payloadMembers: payload.call?.members,
          payloadCallId: payload.call?.id,
        }
      );
      return;
    }

    logInfo('Marking creator busy (call accepted)', { callId, creatorFirebaseUid });
    const success = await this.markCreatorBusy(creatorFirebaseUid);
    if (!success) {
      logError(
        'Failed to mark creator busy on call accepted',
        new Error('markCreatorBusy returned false'),
        { callId, creatorFirebaseUid }
      );
    }
  }

  /**
   * Mark creator as busy when on a call.
   * 
   * 🔥 CRITICAL FIX: Updates ALL availability systems:
   * 1. Redis (backend-authoritative availability)
   * 2. Socket.IO (real-time updates to all clients)
   * 3. Stream Chat (legacy compatibility)
   * 
   * 🔥 SCALABILITY OPTIMIZATION: Idempotency checks prevent unnecessary operations
   * - Checks Redis status before updating (avoids redundant SET operations)
   * - Only broadcasts Socket.IO if status actually changed
   * - Handles race conditions gracefully
   * 
   * This ensures users on the homepage see creators as busy immediately.
   * 
   * @param creatorFirebaseUid - The creator's Firebase UID
   * @returns true if update was successful, false otherwise
   */
  private async markCreatorBusy(creatorFirebaseUid: string): Promise<boolean> {
    try {
      // 🔥 SCALABILITY: Idempotency check - avoid unnecessary Redis operations
      // For 1000 users/day + 200 creators, this saves ~50-100 redundant operations/day
      const currentStatus = await getAvailability(creatorFirebaseUid);
      
      // Only update if not already busy (optimization for scalability)
      const shouldUpdate = currentStatus !== 'busy';
      
      if (shouldUpdate) {
        // 🔥 FIX: Update Redis (backend-authoritative availability)
        // This is what the user homepage reads from
        await setAvailability(creatorFirebaseUid, 'busy');
        logInfo('Creator marked busy in Redis', { creatorFirebaseUid });

        // 🔥 FIX: Emit Socket.IO event (real-time updates to all clients)
        // This ensures users on homepage see status change instantly
        emitCreatorStatus(creatorFirebaseUid, 'busy');
        logInfo('Creator busy status broadcast via Socket.IO', { creatorFirebaseUid });
      } else {
        // Already busy - skip Redis/Socket.IO update (idempotency optimization)
        logInfo('Creator already busy in Redis, skipping update (idempotent)', {
          creatorFirebaseUid,
        });
      }

      // Legacy: Update Stream Chat (for backwards compatibility)
      // Stream Chat updates are separate and don't block the main flow
      try {
        const streamClient = getStreamClient();
        const currentUser = await streamClient.queryUsers({
          filter: { id: { $eq: creatorFirebaseUid } },
        });

        if (currentUser.users.length > 0 && currentUser.users[0].busy === true) {
          logInfo('Creator already busy in Stream Chat, skipping Stream Chat update', {
            creatorFirebaseUid,
          });
        } else {
          await streamClient.partialUpdateUser({
            id: creatorFirebaseUid,
            set: {
              busy: true,
            },
          });
          logInfo('Creator marked busy in Stream Chat', { creatorFirebaseUid });
        }
      } catch (streamError) {
        // Non-critical: Stream Chat update failure shouldn't block the main flow
        logError('Failed to set creator busy state in Stream Chat (non-critical)', streamError, {
          creatorFirebaseUid,
        });
      }

      return true;
    } catch (error) {
      // 🔥 ERROR HANDLING: Even if idempotency check fails, try to update
      // This ensures eventual consistency
      try {
        await setAvailability(creatorFirebaseUid, 'busy');
        emitCreatorStatus(creatorFirebaseUid, 'busy');
        logInfo('Creator marked busy (fallback after error)', { creatorFirebaseUid });
      } catch (fallbackError) {
        logError('Failed to mark creator as busy (fallback also failed)', fallbackError, {
          creatorFirebaseUid,
        });
        return false;
      }
      return true;
    }
  }

  /**
   * 🔥 FIX: Ensure call record exists in DB (for SDK-created calls)
   * Creates call record if it doesn't exist, using webhook payload data
   */
  private async ensureCallRecordExists(
    payload: StreamVideoWebhookPayload,
    callId: string
  ): Promise<void> {
    const existingCall = await Call.findOne({ callId });
    if (existingCall) {
      return; // Call record already exists
    }

    logInfo('Call record not found, creating from webhook payload', { callId });

    // Extract members from payload
    const members = payload.call?.members || payload.session?.participants || [];
    const callerMember = members.find((m) => m.role === 'admin') || members[0];
    const creatorMember =
      members.find((m) => m.role === 'call_member') ||
      members.find((m) => m.user_id && callerMember && m.user_id !== callerMember.user_id);

    if (!callerMember?.user_id || !creatorMember?.user_id) {
      logError(
        'Cannot create call record: missing members in payload',
        new Error('Missing members'),
        { callId, members }
      );
      return;
    }

    // Find users by Firebase UID
    const callerUser = await User.findOne({ firebaseUid: callerMember.user_id });
    const creatorUser = await User.findOne({ firebaseUid: creatorMember.user_id });

    if (!callerUser || !creatorUser) {
      logError(
        'Cannot create call record: users not found',
        new Error('Users missing'),
        { callId, callerUid: callerMember.user_id, creatorUid: creatorMember.user_id }
      );
      return;
    }

    // Create call record
    try {
      const newCall = await Call.create({
        callId,
        callerUserId: callerUser._id,
        creatorUserId: creatorUser._id,
        status: 'ringing',
        billedSeconds: 0,
        userCoinsSpent: 0,
        creatorCoinsEarned: 0,
        isForceEnded: false,
        isSettled: false,
      });
      logInfo('Call record created from webhook', { callId });
      
      // 🔥 FIX: Mark creator busy immediately when call record is created
      // The post-save hook will also mark busy, but this ensures it happens even if hook fails
      if (creatorUser.firebaseUid) {
        await this.markCreatorBusy(creatorUser.firebaseUid);
        logInfo('Creator marked busy after call record creation', {
          callId,
          creatorFirebaseUid: creatorUser.firebaseUid,
        });
      }
    } catch (error) {
      // Race condition: another webhook might have created it
      logInfo('Call record creation failed (may already exist)', { callId, error });
      
      // 🔥 FIX: Even if call record creation failed, try to mark creator busy
      // This handles the case where call record exists but creator wasn't marked busy
      if (creatorUser.firebaseUid) {
        await this.markCreatorBusy(creatorUser.firebaseUid);
        logInfo('Creator marked busy after call record creation failure (fallback)', {
          callId,
          creatorFirebaseUid: creatorUser.firebaseUid,
        });
      }
    }
  }

  private async extractCreatorFirebaseUid(
    payload: StreamVideoWebhookPayload,
    callId: string
  ): Promise<string | null> {
    // Method 1: Extract from call members in payload (most reliable)
    if (payload.call?.members) {
      const creatorMember = payload.call.members.find((m) => m.role === 'call_member');
      if (creatorMember?.user_id) {
        logInfo('Extracted creator Firebase UID from webhook payload members', {
          callId,
          creatorFirebaseUid: creatorMember.user_id,
        });
        return creatorMember.user_id;
      }
    }

    // Also check session participants
    if (payload.session?.participants) {
      const creatorParticipant = payload.session.participants.find((m) => m.role === 'call_member');
      if (creatorParticipant?.user_id) {
        logInfo('Extracted creator Firebase UID from session participants', {
          callId,
          creatorFirebaseUid: creatorParticipant.user_id,
        });
        return creatorParticipant.user_id;
      }
    }

    // Method 2: Find from call record in DB
    const call = await Call.findOne({ callId });
    if (call) {
      const creatorUser = await User.findById(call.creatorUserId);
      if (creatorUser?.firebaseUid) {
        logInfo('Extracted creator Firebase UID from call record', {
          callId,
          creatorFirebaseUid: creatorUser.firebaseUid,
        });
        return creatorUser.firebaseUid;
      }
    }

    // Method 3: Parse from call ID format
    // Call ID format: userId_creatorMongoId_timestamp (from Flutter SDK)
    // OR: userId_creatorMongoId (from REST API)
    const parts = callId.split('_');
    if (parts.length >= 2) {
      // Creator Mongo ID is the second-to-last part (not the last, which is timestamp)
      // For format: userId_creatorMongoId_timestamp, creator ID is at index length-2
      // For format: userId_creatorMongoId, creator ID is at index length-1
      const creatorMongoId = parts.length >= 3 ? parts[parts.length - 2] : parts[parts.length - 1];
      
      const creator = await Creator.findById(creatorMongoId);
      if (creator) {
        const creatorUser = await User.findById(creator.userId);
        if (creatorUser?.firebaseUid) {
          logInfo('Extracted creator Firebase UID from callId parsing', {
            callId,
            creatorMongoId,
            creatorFirebaseUid: creatorUser.firebaseUid,
          });
          return creatorUser.firebaseUid;
        }
      }
    }

    logError(
      'Could not extract creator Firebase UID from webhook',
      new Error('Creator UID extraction failed'),
      { callId, payloadMembers: payload.call?.members, sessionParticipants: payload.session?.participants }
    );
    return null;
  }

  // Lock release & availability updates are now delegated to creator-call-lock.service.ts
}

export const callLifecycleService = new CallLifecycleService();

