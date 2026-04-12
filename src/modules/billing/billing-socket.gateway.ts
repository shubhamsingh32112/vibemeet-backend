import { Server } from 'socket.io';
import {
  getRedis,
  callSessionKey,
  callUserCoinsKey,
  callCreatorEarningsKey,
  ACTIVE_BILLING_CALLS_KEY,
  activeCallByUserKey,
  pendingCallEndKey,
  PENDING_CALL_END_TTL,
} from '../../config/redis';
import { recordBillingMetric } from '../../utils/monitoring';
import { billingService } from './billing.service';
import { settleCall } from './billing-settlement.service';
import { logError, logInfo, logDebug, logWarning } from '../../utils/logger';
import { checkCallRateLimit } from '../../utils/rate-limit.service';
import { COIN_MICROS, BILLING_SESSION_SCHEMA_VERSION, microsToWholeCoinsFloor } from './billing.constants';

/** Shape of Redis billing session JSON (recover-state handler). */
interface BillingRecoverSession {
  schemaVersion?: number;
  callId: string;
  userFirebaseUid: string;
  creatorFirebaseUid: string;
  userMongoId: string;
  creatorMongoId: string;
  pricePerMinute: number;
  pricePerSecondMicros?: number;
  pricePerSecond?: number;
  creatorEarningsPerSecondMicros?: number;
  creatorEarningsPerSecond?: number;
  creatorShareAtCallTime?: number;
  startTime: number;
  lastProcessedAt?: number;
  totalDeductedMicros?: number;
  totalEarnedMicros?: number;
  elapsedSeconds: number;
  effectiveDurationLimitSeconds?: number;
}

/**
 * Attach billing-related socket events.
 * Called AFTER `setupAvailabilityGateway` (which installs the auth middleware).
 */
export function setupBillingGateway(io: Server): void {
  io.on('connection', (socket) => {
    const firebaseUid: string | undefined = socket.data.firebaseUid;
    if (!firebaseUid) return;

    socket.join(`user:${firebaseUid}`);
    logDebug('User joined billing room', { firebaseUid, room: `user:${firebaseUid}` });

    socket.on(
      'call:started',
      async (data: {
        callId: string;
        creatorFirebaseUid: string;
        creatorMongoId: string;
        userFirebaseUid?: string;
      }) => {
        try {
          const payerFirebaseUid = data.userFirebaseUid || firebaseUid;

          logInfo('call:started received', {
            callId: data.callId,
            socketFirebaseUid: firebaseUid,
            payerFirebaseUid,
            isCreatorInitiated: !!data.userFirebaseUid,
          });

          const rateLimitCheck = await checkCallRateLimit(payerFirebaseUid);
          if (!rateLimitCheck.allowed) {
            logWarning('Call rate limit exceeded', {
              payerFirebaseUid,
              callId: data.callId,
              count: rateLimitCheck.limit - rateLimitCheck.remaining,
              limit: rateLimitCheck.limit,
              resetAt: new Date(rateLimitCheck.resetAt).toISOString(),
            });
            recordBillingMetric('rate_limit_exceeded', 1, {
              firebaseUid: payerFirebaseUid,
              callId: data.callId,
            });

            io.to(`user:${payerFirebaseUid}`).emit('billing:error', {
              callId: data.callId,
              error: 'RATE_LIMIT_EXCEEDED',
              message: `Too many call attempts. Please wait before trying again.`,
              rateLimit: {
                limit: rateLimitCheck.limit,
                remaining: rateLimitCheck.remaining,
                resetAt: rateLimitCheck.resetAt,
                windowSeconds: rateLimitCheck.windowSeconds,
              },
            });
            return;
          }

          logDebug('Rate limit check passed', {
            payerFirebaseUid,
            callId: data.callId,
            remaining: rateLimitCheck.remaining,
            limit: rateLimitCheck.limit,
          });

          await billingService.startBillingSession(io, payerFirebaseUid, data, {
            source: 'client_socket',
          });

          const redis = getRedis();
          const pendingEndKey = pendingCallEndKey(data.callId);
          const hasPendingEnd = await redis.get(pendingEndKey);
          if (hasPendingEnd) {
            await redis.del(pendingEndKey);
            logInfo('Deferred settlement for call', { callId: data.callId });
            await settleCall(io, data.callId);
          }
        } catch (err) {
          logError('Error in call:started', err, { callId: data.callId, firebaseUid });
          const redis = getRedis();
          await redis.del(pendingCallEndKey(data.callId)).catch(() => {});
          socket.emit('billing:error', {
            callId: data.callId,
            message: 'Failed to start billing',
          });
        }
      }
    );

    socket.on('call:ended', async (data: { callId: string }) => {
      try {
        logInfo('call:ended received', { callId: data.callId, firebaseUid });

        const redis = getRedis();
        const sessionExists = await redis.get(callSessionKey(data.callId));

        const isInActiveBilling = await redis.zscore(ACTIVE_BILLING_CALLS_KEY, data.callId);

        if (!sessionExists && !isInActiveBilling) {
          await redis.setex(pendingCallEndKey(data.callId), PENDING_CALL_END_TTL, '1');
          logInfo('Deferring call:ended (session not ready)', { callId: data.callId });
          return;
        }

        await settleCall(io, data.callId);
      } catch (err) {
        logError('Error in call:ended', err, { callId: data.callId, firebaseUid });
      }
    });

    socket.on('billing:recover-state', async () => {
      try {
        logInfo('State recovery requested', { firebaseUid });
        const redis = getRedis();

        const callId = await redis.get(activeCallByUserKey(firebaseUid));

        if (!callId) {
          socket.emit('billing:recover-state:response', {
            success: true,
            activeCalls: [],
          });
          return;
        }

        const isInActiveBilling = await redis.zscore(ACTIVE_BILLING_CALLS_KEY, callId);
        if (!isInActiveBilling) {
          await redis.del(activeCallByUserKey(firebaseUid));
          socket.emit('billing:recover-state:response', {
            success: true,
            activeCalls: [],
          });
          return;
        }

        const sessionRaw = await redis.get(callSessionKey(callId));
        if (!sessionRaw) {
          await redis.del(activeCallByUserKey(firebaseUid));
          socket.emit('billing:recover-state:response', {
            success: true,
            activeCalls: [],
          });
          return;
        }

        const session: BillingRecoverSession =
          typeof sessionRaw === 'string'
            ? JSON.parse(sessionRaw)
            : (sessionRaw as BillingRecoverSession);

        const [coinsRaw, earningsRaw] = await Promise.all([
          redis.get(callUserCoinsKey(callId)),
          redis.get(callCreatorEarningsKey(callId)),
        ]);

        const coinsStr = String(coinsRaw ?? '0');
        let balanceMicros: number;
        if (coinsStr.includes('.')) {
          balanceMicros = Math.round(parseFloat(coinsStr) * COIN_MICROS);
        } else {
          balanceMicros = parseInt(coinsStr, 10) || 0;
        }

        const earnRaw = parseInt(String(earningsRaw ?? '0'), 10) || 0;
        let earningsMicros = earnRaw;
        if ((session.schemaVersion ?? 0) < BILLING_SESSION_SCHEMA_VERSION) {
          earningsMicros = Math.round((earnRaw * COIN_MICROS) / 10000);
        }
        const earningsDisplay = Math.round((earningsMicros / COIN_MICROS) * 100) / 100;

        const pps =
          session.pricePerSecondMicros ??
          Math.max(1, Math.round((session.pricePerSecond ?? 0) * COIN_MICROS));
        const remainingSeconds = pps > 0 ? Math.floor(balanceMicros / pps) : 0;

        const serverTimestamp = Date.now();

        socket.emit('billing:recover-state:response', {
          success: true,
          activeCalls: [
            {
              callId: session.callId,
              coins: microsToWholeCoinsFloor(balanceMicros),
              coinsExact: balanceMicros / COIN_MICROS,
              pricePerSecond: pps / COIN_MICROS,
              pricePerSecondMicros: pps,
              elapsedSeconds: session.elapsedSeconds,
              remainingSeconds,
              earnings: earningsDisplay,
              serverTimestamp,
              callStartTime: session.startTime,
            },
          ],
        });

        logInfo('State recovery completed', {
          firebaseUid,
          callId,
          elapsedSeconds: session.elapsedSeconds,
        });

        recordBillingMetric('state_recovery', 1, { callId, firebaseUid });
      } catch (err) {
        logError('State recovery failed', err, { firebaseUid });
        socket.emit('billing:recover-state:response', {
          success: false,
          error: 'Failed to recover state',
          activeCalls: [],
        });
      }
    });

    socket.on('disconnect', async (reason) => {
      logInfo('Socket disconnected', { firebaseUid, reason });
      const redis = getRedis();
      const callId = await redis.get(activeCallByUserKey(firebaseUid));
      if (callId) {
        logInfo('Auto-settling call due to disconnect', { callId, firebaseUid });
        try {
          await settleCall(io, callId);
        } catch (err) {
          logError('Auto-settle failed', err, { callId, firebaseUid });
        }
      }
    });
  });
}
