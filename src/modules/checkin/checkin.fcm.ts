import * as admin from 'firebase-admin';
import { getFirebaseAdmin } from '../../config/firebase';
import { logError, logInfo, logWarning } from '../../utils/logger';
import { CHECKIN_DEEP_LINK } from './checkin.config';
import { pruneInvalidTokens } from './device-push-token.service';

const INVALID_TOKEN_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
]);

export async function sendDailyCheckInReminders(tokens: string[]): Promise<{
  successCount: number;
  failureCount: number;
  invalidTokens: string[];
}> {
  if (tokens.length === 0) {
    return { successCount: 0, failureCount: 0, invalidTokens: [] };
  }

  let messaging: admin.messaging.Messaging;
  try {
    messaging = getFirebaseAdmin().messaging();
  } catch (err) {
    logError('FCM unavailable for daily check-in reminders', err as Error);
    return { successCount: 0, failureCount: tokens.length, invalidTokens: [] };
  }

  const invalidTokens: string[] = [];
  let successCount = 0;
  let failureCount = 0;

  // FCM multicast supports up to 500 tokens per call.
  for (let i = 0; i < tokens.length; i += 500) {
    const batch = tokens.slice(i, i + 500);
    try {
      const response = await messaging.sendEachForMulticast({
        tokens: batch,
        notification: {
          title: 'Daily Check-in',
          body: "Don't forget to claim today's reward!",
        },
        data: {
          type: 'daily_checkin',
          deepLink: CHECKIN_DEEP_LINK,
        },
        android: {
          priority: 'high',
        },
        apns: {
          payload: {
            aps: {
              sound: 'default',
            },
          },
        },
      });

      successCount += response.successCount;
      failureCount += response.failureCount;

      response.responses.forEach((r, idx) => {
        if (r.success) return;
        const code = r.error?.code ?? '';
        if (INVALID_TOKEN_CODES.has(code)) {
          invalidTokens.push(batch[idx]);
        } else {
          logWarning('Daily check-in FCM send failed', {
            code,
            message: r.error?.message,
          });
        }
      });
    } catch (err) {
      failureCount += batch.length;
      logError('Daily check-in multicast failed', err as Error, {
        batchSize: batch.length,
      });
    }
  }

  if (invalidTokens.length > 0) {
    const pruned = await pruneInvalidTokens(invalidTokens);
    logInfo('Pruned invalid FCM tokens after check-in reminder', {
      pruned,
      invalidCount: invalidTokens.length,
    });
  }

  return { successCount, failureCount, invalidTokens };
}
