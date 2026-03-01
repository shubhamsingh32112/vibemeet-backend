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

      const acquired = await redis.set(idKey, '1', {
        nx: true,
        ex: WEBHOOK_IDEMPOTENCY_TTL,
      });

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
   * - Ensure creator marked busy
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

    const call = await Call.findOne({ callId });
    if (!call) {
      logInfo('Call record not found for session_started', { callId });
      return;
    }

    const redis = getRedis();
    const existingSession = await redis.get(callSessionKey(callId));
    if (existingSession) {
      logInfo('Billing already started for call (idempotent)', { callId });
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

    const creatorUser = await User.findById(call.creatorUserId);
    if (creatorUser?.firebaseUid) {
      await this.markCreatorBusy(creatorUser.firebaseUid);
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
        {}
      );
      return;
    }

    logInfo('Call ringing (webhook)', { callId });

    const creatorFirebaseUid = await this.extractCreatorFirebaseUid(payload, callId);
    if (!creatorFirebaseUid) {
      logError(
        'Could not extract creator Firebase UID from ringing payload',
        new Error('Missing creator uid'),
        { callId }
      );
      return;
    }

    await this.markCreatorBusy(creatorFirebaseUid);
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
        {}
      );
      return;
    }

    logInfo('Call accepted (webhook)', { callId });

    const creatorFirebaseUid = await this.extractCreatorFirebaseUid(payload, callId);
    if (!creatorFirebaseUid) {
      logError(
        'Could not extract creator Firebase UID from accepted payload',
        new Error('Missing creator uid'),
        { callId }
      );
      return;
    }

    await this.markCreatorBusy(creatorFirebaseUid);
  }

  private async markCreatorBusy(creatorFirebaseUid: string): Promise<boolean> {
    try {
      // For now we keep this helper focused on legacy Stream Chat busy semantics,
      // and rely on acquireCreatorCallLock for locking + availability.
      const streamClient = getStreamClient();
      const currentUser = await streamClient.queryUsers({
        filter: { id: { $eq: creatorFirebaseUid } },
      });

      if (currentUser.users.length > 0 && currentUser.users[0].busy === true) {
        logInfo('Creator already busy in Stream Chat, skipping update', {
          creatorFirebaseUid,
        });
        return false;
      }

      await streamClient.partialUpdateUser({
        id: creatorFirebaseUid,
        set: {
          busy: true,
        },
      });
      logInfo('Creator marked busy in Stream Chat', { creatorFirebaseUid });
      return true;
    } catch (error) {
      logError('Failed to set creator busy state in Stream Chat', error, {
        creatorFirebaseUid,
      });
      return false;
    }
  }

  private async extractCreatorFirebaseUid(
    payload: StreamVideoWebhookPayload,
    callId: string
  ): Promise<string | null> {
    if (payload.call?.members) {
      const creatorMember = payload.call.members.find((m) => m.role === 'call_member');
      if (creatorMember?.user_id) {
        return creatorMember.user_id;
      }
    }

    const call = await Call.findOne({ callId });
    if (call) {
      const creatorUser = await User.findById(call.creatorUserId);
      if (creatorUser?.firebaseUid) {
        return creatorUser.firebaseUid;
      }
    }

    const parts = callId.split('_');
    if (parts.length >= 2) {
      const creatorMongoId = parts[parts.length - 1];
      const creator = await Creator.findById(creatorMongoId);
      if (creator) {
        const creatorUser = await User.findById(creator.userId);
        if (creatorUser?.firebaseUid) {
          return creatorUser.firebaseUid;
        }
      }
    }

    return null;
  }

  // Lock release & availability updates are now delegated to creator-call-lock.service.ts
}

export const callLifecycleService = new CallLifecycleService();

