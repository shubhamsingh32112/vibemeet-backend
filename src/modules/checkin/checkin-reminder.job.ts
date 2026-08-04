import mongoose from 'mongoose';
import { User } from '../user/user.model';
import { istDateKey, IST_TIMEZONE } from '../../utils/ist-time';
import { logError, logInfo } from '../../utils/logger';
import {
  getDailyCheckInReminderHourIst,
  getDailyCheckInReminderWindowMinutes,
  isDailyCheckInEnabled,
} from './checkin.config';
import { DailyCheckInState } from './checkin.model';
import { sendDailyCheckInReminders } from './checkin.fcm';
import { listTokensForUserIds } from './device-push-token.service';

const BATCH_SIZE = 500;

function getIstHourAndMinute(now: Date): { hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: IST_TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now);

  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  return { hour, minute };
}

/** True when current IST time is inside the configured reminder send window. */
export function isInsideReminderWindow(now = new Date()): boolean {
  const targetHour = getDailyCheckInReminderHourIst();
  const windowMins = getDailyCheckInReminderWindowMinutes();
  const { hour, minute } = getIstHourAndMinute(now);
  if (hour !== targetHour) return false;
  return minute < windowMins;
}

/**
 * Claim reminder slot for a user (at-most-once per IST day).
 * Returns true if this worker won the claim.
 */
export async function claimReminderSlot(
  userId: mongoose.Types.ObjectId,
  todayKey: string
): Promise<boolean> {
  const updated = await DailyCheckInState.findOneAndUpdate(
    {
      userId,
      lastReminderDateKey: { $ne: todayKey },
      lastClaimDateKey: { $ne: todayKey },
    },
    { $set: { lastReminderDateKey: todayKey } },
    { new: true }
  );
  return Boolean(updated);
}

/**
 * Process one reminder tick: find eligible users, claim slots, send FCM.
 */
export async function runDailyCheckInReminderTick(now = new Date()): Promise<{
  scanned: number;
  claimed: number;
  sentSuccess: number;
  sentFailure: number;
}> {
  if (!isDailyCheckInEnabled()) {
    return { scanned: 0, claimed: 0, sentSuccess: 0, sentFailure: 0 };
  }
  if (!isInsideReminderWindow(now)) {
    return { scanned: 0, claimed: 0, sentSuccess: 0, sentFailure: 0 };
  }

  const todayKey = istDateKey(now);
  let scanned = 0;
  let claimed = 0;
  let sentSuccess = 0;
  let sentFailure = 0;
  let lastId: mongoose.Types.ObjectId | null = null;

  // Page through consumer users who have not claimed today.
  // Reminder state is claimed per-user before send to prevent multi-worker spam.
  for (;;) {
    const userQuery: Record<string, unknown> = { role: 'user' };
    if (lastId) {
      userQuery._id = { $gt: lastId };
    }

    const users = await User.find(userQuery)
      .select('_id')
      .sort({ _id: 1 })
      .limit(BATCH_SIZE)
      .lean();

    if (users.length === 0) break;
    scanned += users.length;
    lastId = users[users.length - 1]._id as mongoose.Types.ObjectId;

    const userIds = users.map((u) => u._id as mongoose.Types.ObjectId);

    // Ensure state docs exist so reminder marking works for never-opened users.
    await DailyCheckInState.bulkWrite(
      userIds.map((userId) => ({
        updateOne: {
          filter: { userId },
          update: {
            $setOnInsert: {
              userId,
              nextDayIndex: 1,
              lastClaimDateKey: null,
              lastClaimedDayIndex: null,
              lastReminderDateKey: null,
            },
          },
          upsert: true,
        },
      })),
      { ordered: false }
    );

    const states = await DailyCheckInState.find({
      userId: { $in: userIds },
      lastClaimDateKey: { $ne: todayKey },
      lastReminderDateKey: { $ne: todayKey },
    })
      .select('userId')
      .lean();

    const eligibleIds = states.map((s) => s.userId as mongoose.Types.ObjectId);
    if (eligibleIds.length === 0) continue;

    const tokenRows = await listTokensForUserIds(eligibleIds);
    if (tokenRows.length === 0) continue;

    const tokensByUser = new Map<string, string[]>();
    for (const row of tokenRows) {
      const key = row.userId.toString();
      const list = tokensByUser.get(key) ?? [];
      list.push(row.token);
      tokensByUser.set(key, list);
    }

    const tokensToSend: string[] = [];
    for (const userId of eligibleIds) {
      const tokens = tokensByUser.get(userId.toString());
      if (!tokens || tokens.length === 0) continue;
      const won = await claimReminderSlot(userId, todayKey);
      if (!won) continue;
      claimed += 1;
      tokensToSend.push(...tokens);
    }

    if (tokensToSend.length === 0) continue;

    const result = await sendDailyCheckInReminders(tokensToSend);
    sentSuccess += result.successCount;
    sentFailure += result.failureCount;
  }

  if (claimed > 0 || scanned > 0) {
    logInfo('Daily check-in reminder tick', {
      todayKey,
      scanned,
      claimed,
      sentSuccess,
      sentFailure,
    });
  }

  return { scanned, claimed, sentSuccess, sentFailure };
}

let reminderInterval: ReturnType<typeof setInterval> | null = null;

export function startDailyCheckInReminderJob(): void {
  if (reminderInterval) return;
  const tick = () => {
    runDailyCheckInReminderTick().catch((err) => {
      logError('Daily check-in reminder tick failed', err as Error);
    });
  };
  // Every 5 minutes during the send window.
  reminderInterval = setInterval(tick, 5 * 60 * 1000);
  // Kick once shortly after boot (non-blocking).
  setTimeout(tick, 30_000);
  logInfo('Daily check-in reminder job started');
}

export function stopDailyCheckInReminderJob(): void {
  if (reminderInterval) {
    clearInterval(reminderInterval);
    reminderInterval = null;
  }
}
