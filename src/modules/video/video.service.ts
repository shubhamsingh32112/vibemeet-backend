import axios from 'axios';
import { User } from '../user/user.model';
import { Creator } from '../creator/creator.model';
import { Call } from './call.model';
import {
  generateCallId,
  generateServerSideToken,
} from '../../config/stream-video';
import { MIN_COINS_TO_CALL } from '../../config/pricing.config';
import { checkCallRateLimit } from '../../utils/rate-limit.service';
import { logWarning, logInfo } from '../../utils/logger';
import { acquireCreatorCallLock } from './creator-call-lock.service';
import { pricingService } from './pricing.service';
import { shouldRejectNewCallsDueToBackpressure } from './backpressure.service';

export class VideoCallError extends Error {
  public readonly status: number;
  public readonly code: string;
  public readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export interface InitiateCallResult {
  callId: string;
  callType: string;
}

export interface AcceptCallResult {
  callId: string;
  priceAtCallTime: number;
  creatorShareAtCallTime: number;
}

export class VideoCallService {
  /**
   * Core business logic for initiating a call.
   * Controllers should delegate here instead of talking to models/Stream directly.
   */
  async initiateCallForUser(
    firebaseUid: string,
    creatorId: string
  ): Promise<InitiateCallResult> {
    if (!creatorId) {
      throw new VideoCallError(
        400,
        'CREATOR_ID_REQUIRED',
        'creatorId is required'
      );
    }

    // Back-pressure guard: if the system is currently experiencing a high rate
    // of billing/webhook/infra errors, temporarily reject new billable calls
    // instead of half-processing them.
    if (shouldRejectNewCallsDueToBackpressure()) {
      throw new VideoCallError(
        503,
        'TEMPORARILY_UNAVAILABLE',
        'Video calls are temporarily unavailable due to system load. Please try again in a moment.'
      );
    }

    // Get current user
    const user = await User.findOne({ firebaseUid });
    if (!user) {
      throw new VideoCallError(404, 'USER_NOT_FOUND', 'User not found');
    }

    // Only regular users can initiate calls
    if (user.role !== 'user') {
      throw new VideoCallError(
        403,
        'CALLER_NOT_USER',
        'Only users can initiate calls. Creators cannot call other creators.'
      );
    }

    // Minimum coins check
    if (user.coins < MIN_COINS_TO_CALL) {
      throw new VideoCallError(403, 'INSUFFICIENT_COINS_MIN_10', 'Insufficient coins', {
        coinsRequired: MIN_COINS_TO_CALL,
        coinsAvailable: user.coins,
      });
    }

    // Per-user rate limit
    const rateLimitCheck = await checkCallRateLimit(firebaseUid);
    if (!rateLimitCheck.allowed) {
      logWarning('Call rate limit exceeded in service', {
        firebaseUid,
        creatorId,
        count: rateLimitCheck.limit - rateLimitCheck.remaining,
        limit: rateLimitCheck.limit,
        resetAt: new Date(rateLimitCheck.resetAt).toISOString(),
      });

      throw new VideoCallError(
        429,
        'RATE_LIMIT_EXCEEDED',
        'Too many call attempts. Please wait before trying again.',
        {
          rateLimit: {
            limit: rateLimitCheck.limit,
            remaining: rateLimitCheck.remaining,
            resetAt: rateLimitCheck.resetAt,
            windowSeconds: rateLimitCheck.windowSeconds,
          },
        }
      );
    }

    logInfo('Rate limit check passed in service', {
      firebaseUid,
      creatorId,
      remaining: rateLimitCheck.remaining,
      limit: rateLimitCheck.limit,
    });

    // Validate creator and creator user
    const creator = await Creator.findById(creatorId);
    if (!creator) {
      throw new VideoCallError(404, 'CREATOR_NOT_FOUND', 'Creator not found');
    }

    const creatorUser = await User.findById(creator.userId);
    if (!creatorUser) {
      throw new VideoCallError(
        404,
        'CREATOR_USER_NOT_FOUND',
        'Creator user not found'
      );
    }

    if (creatorUser.role !== 'creator') {
      throw new VideoCallError(
        400,
        'TARGET_NOT_CREATOR',
        'Target user is not a creator'
      );
    }

    // Check if creator already in a call
    if (creator.currentCallId) {
      throw new VideoCallError(
        409,
        'CREATOR_IN_CALL',
        'Creator is already in a call'
      );
    }

    // Generate deterministic call ID and call type
    const callId = generateCallId(firebaseUid, creatorId.toString());
    const callType = 'default';

    // Prepare Stream Video API call
    const serverToken = generateServerSideToken();
    const apiKey = process.env.STREAM_API_KEY;
    if (!apiKey) {
      throw new VideoCallError(
        500,
        'STREAM_NOT_CONFIGURED',
        'Stream Video service not configured',
        { details: 'STREAM_API_KEY must be set' }
      );
    }

    const streamApiUrl = `https://video.stream-io-api.com/v1/calls/${callType}?id=${callId}&api_key=${apiKey}`;

    const members = [
      {
        user_id: firebaseUid,
        role: 'admin',
      },
      {
        user_id: creatorUser.firebaseUid,
        role: 'call_member',
      },
    ];

    const callSettings = {
      ring: true,
      video: true,
      max_participants: 2,
    };

    logInfo('Creating/getting Stream call from service', {
      callId,
      firebaseUid,
      creatorFirebaseUid: creatorUser.firebaseUid,
    });

    try {
      // Use existing circuit breaker + monitoring utilities
      // (require used to avoid circular import at module top-level)
      const { streamVideoCircuitBreaker } = require('../../utils/circuit-breaker');
      const { recordAPIMetric } = require('../../utils/monitoring');

      const startTime = Date.now();
      const response = await streamVideoCircuitBreaker.execute(async () => {
        return await axios.post(
          streamApiUrl,
          {
            members,
            settings_override: callSettings,
          },
          {
            headers: {
              Authorization: `Bearer ${serverToken}`,
              'Content-Type': 'application/json',
            },
            timeout: 10000,
          }
        );
      });

      const duration = Date.now() - startTime;
      recordAPIMetric('stream_video.create_call.duration', duration);
      recordAPIMetric('stream_video.create_call.success', 1);

      logInfo('Stream call ready (service)', {
        callId,
        response: response.data,
      });

      // Upsert Call record
      await Call.findOneAndUpdate(
        { callId },
        {
          callId,
          callerUserId: user._id,
          creatorUserId: creatorUser._id,
          status: 'ringing',
        },
        { upsert: true, new: true }
      );

      return { callId, callType };
    } catch (error: any) {
      const { monitoring, recordAPIMetric } = require('../../utils/monitoring');
      const errorDetails = error.response?.data || error.message;
      const statusCode = error.response?.status || 500;

      recordAPIMetric('stream_video.create_call.error', 1, {
        statusCode: statusCode.toString(),
      });
      monitoring.recordError(
        'Stream Video API call creation failed',
        error,
        {
          url: streamApiUrl,
          statusCode,
          callId,
          userId: user.firebaseUid,
        },
        'error'
      );

      throw new VideoCallError(
        500,
        'STREAM_CREATE_CALL_FAILED',
        'Failed to create call',
        {
          statusCode,
          streamError: errorDetails,
        }
      );
    }
  }


  /**
   * Core business logic for a creator accepting a call.
   */
  async acceptCallForCreator(
    firebaseUid: string,
    callId: string
  ): Promise<AcceptCallResult> {
    if (!callId) {
      throw new VideoCallError(400, 'CALL_ID_REQUIRED', 'callId is required');
    }

    const user = await User.findOne({ firebaseUid });
    if (!user) {
      throw new VideoCallError(404, 'USER_NOT_FOUND', 'User not found');
    }

    const call = await Call.findOne({ callId });
    if (!call) {
      throw new VideoCallError(404, 'CALL_NOT_FOUND', 'Call not found');
    }

    // Must be the creator for this call
    if (call.creatorUserId.toString() !== user._id.toString()) {
      throw new VideoCallError(
        403,
        'NOT_CALL_CREATOR',
        'Only the creator can accept this call'
      );
    }

    if (call.status !== 'ringing') {
      throw new VideoCallError(
        400,
        'CALL_NOT_RINGING',
        `Call is not in ringing state. Current status: ${call.status}`
      );
    }

    const creator = await Creator.findOne({ userId: user._id });
    if (!creator) {
      throw new VideoCallError(
        404,
        'CREATOR_PROFILE_NOT_FOUND',
        'Creator profile not found'
      );
    }

    if (creator.currentCallId && creator.currentCallId !== callId) {
      throw new VideoCallError(
        409,
        'CREATOR_IN_OTHER_CALL',
        'Creator is already in another call'
      );
    }

    const caller = await User.findById(call.callerUserId);
    if (!caller) {
      throw new VideoCallError(
        404,
        'CALLER_NOT_FOUND',
        'Caller not found'
      );
    }

    // Snapshot pricing at call time using centralised pricing logic
    const pricing = await pricingService.snapshotForCreator(creator._id.toString());
    call.priceAtCallTime = pricing.pricePerMinute;
    call.creatorShareAtCallTime = pricing.creatorShareAtCallTime;
    call.acceptedAt = new Date();
    call.status = 'accepted';

    await call.save();

    // Lock creator for this call and mark them busy via the centralised helper.
    // This keeps currentCallId + availability/Stream Chat busy flags in sync.
    await acquireCreatorCallLock(user._id.toString(), callId);

    logInfo('Call accepted by creator (service)', {
      callId,
      creatorUserId: user._id.toString(),
      priceAtCallTime: call.priceAtCallTime,
      creatorShareAtCallTime: call.creatorShareAtCallTime,
    });

    return {
      callId,
      priceAtCallTime: call.priceAtCallTime || 0,
      creatorShareAtCallTime: call.creatorShareAtCallTime || 0,
    };
  }
}

export const videoCallService = new VideoCallService();

