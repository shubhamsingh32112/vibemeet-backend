import mongoose from 'mongoose';
import { User } from '../user/user.model';
import { CoinTransaction } from '../user/coin-transaction.model';
import { getIO } from '../../config/socket';
import { verifyUserBalance } from '../../utils/balance-integrity';
import { istDateKey, istDayBounds } from '../../utils/ist-time';
import { logError, logInfo } from '../../utils/logger';
import {
  CHECKIN_CYCLE_DAYS,
  getDailyCheckInRewardForDay,
  getDailyCheckInRewards,
  isDailyCheckInEnabled,
} from './checkin.config';
import { DailyCheckInState, IDailyCheckInState } from './checkin.model';

export type RewardDayStatus = 'claimed' | 'today' | 'upcoming';

export interface CheckInRewardDay {
  day: number;
  coins: number;
  status: RewardDayStatus;
}

export interface CheckInStatusPayload {
  rewards: CheckInRewardDay[];
  canClaimToday: boolean;
  claimedToday: boolean;
  currentDayIndex: number;
  resetsAt: string;
  serverNow: string;
  coinsBalance: number;
  alreadyClaimed?: boolean;
  coinsCredited?: number;
}

export class CheckInError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly code?: string
  ) {
    super(message);
    this.name = 'CheckInError';
  }
}

function isDuplicateKeyError(err: unknown): boolean {
  return Boolean(
    err &&
      typeof err === 'object' &&
      'code' in err &&
      (err as { code?: number }).code === 11000
  );
}

export function dailyCheckInTransactionId(
  userId: mongoose.Types.ObjectId | string,
  dateKey: string
): string {
  return `daily_checkin_${userId.toString()}_${dateKey}`;
}

export function buildRewardsGrid(input: {
  nextDayIndex: number;
  lastClaimDateKey: string | null;
  lastClaimedDayIndex: number | null;
  todayKey: string;
  rewards: number[];
}): CheckInRewardDay[] {
  const claimedToday = input.lastClaimDateKey === input.todayKey;
  const todayIndex = claimedToday
    ? (input.lastClaimedDayIndex ?? input.nextDayIndex)
    : input.nextDayIndex;

  return input.rewards.map((coins, i) => {
    const day = i + 1;
    let status: RewardDayStatus;
    if (day < todayIndex) {
      status = 'claimed';
    } else if (day === todayIndex) {
      status = claimedToday ? 'claimed' : 'today';
    } else {
      status = 'upcoming';
    }
    return { day, coins, status };
  });
}

function toStatusPayload(
  state: Pick<
    IDailyCheckInState,
    'nextDayIndex' | 'lastClaimDateKey' | 'lastClaimedDayIndex'
  >,
  coinsBalance: number,
  now: Date,
  extras?: { alreadyClaimed?: boolean; coinsCredited?: number }
): CheckInStatusPayload {
  const todayKey = istDateKey(now);
  const { end: resetsAt } = istDayBounds(todayKey);
  const claimedToday = state.lastClaimDateKey === todayKey;
  const currentDayIndex = claimedToday
    ? (state.lastClaimedDayIndex ?? state.nextDayIndex)
    : state.nextDayIndex;

  return {
    rewards: buildRewardsGrid({
      nextDayIndex: state.nextDayIndex,
      lastClaimDateKey: state.lastClaimDateKey,
      lastClaimedDayIndex: state.lastClaimedDayIndex,
      todayKey,
      rewards: getDailyCheckInRewards(),
    }),
    canClaimToday: !claimedToday,
    claimedToday,
    currentDayIndex,
    resetsAt: resetsAt.toISOString(),
    serverNow: now.toISOString(),
    coinsBalance,
    ...extras,
  };
}

async function ensureState(
  userId: mongoose.Types.ObjectId,
  session?: mongoose.ClientSession
): Promise<IDailyCheckInState> {
  const existing = await DailyCheckInState.findOne({ userId }).session(session ?? null);
  if (existing) return existing;

  try {
    const created = await DailyCheckInState.create(
      [
        {
          userId,
          nextDayIndex: 1,
          lastClaimDateKey: null,
          lastClaimedDayIndex: null,
          lastReminderDateKey: null,
        },
      ],
      session ? { session } : undefined
    );
    return created[0];
  } catch (err) {
    if (isDuplicateKeyError(err)) {
      const raced = await DailyCheckInState.findOne({ userId }).session(session ?? null);
      if (raced) return raced;
    }
    throw err;
  }
}

export async function getCheckInStatusForUser(input: {
  firebaseUid: string;
  now?: Date;
}): Promise<CheckInStatusPayload> {
  if (!isDailyCheckInEnabled()) {
    throw new CheckInError('Daily check-in is disabled', 404, 'DISABLED');
  }

  const user = await User.findOne({ firebaseUid: input.firebaseUid }).select(
    '_id role coins'
  );
  if (!user) {
    throw new CheckInError('User not found', 404);
  }
  if (user.role !== 'user') {
    throw new CheckInError('Daily check-in is only available for users', 403, 'ROLE');
  }

  const now = input.now ?? new Date();
  const state = await ensureState(user._id);
  return toStatusPayload(state, user.coins ?? 0, now);
}

async function emitCoinsUpdated(
  firebaseUid: string,
  userId: mongoose.Types.ObjectId,
  coins: number
): Promise<void> {
  try {
    const io = getIO();
    io.to(`user:${firebaseUid}`).emit('coins_updated', {
      userId: userId.toString(),
      coins,
    });
  } catch (err) {
    logError('Failed to emit coins_updated for daily check-in', err as Error);
  }
}

/**
 * Atomically claim today's check-in reward.
 * Idempotent: re-claim same IST day returns 200 with alreadyClaimed=true.
 *
 * Concurrency model (no double credit):
 * 1. Mongo multi-doc transaction serializes concurrent claims for the same user.
 * 2. Unique CoinTransaction.transactionId = daily_checkin_{userId}_{IST-date}.
 * 3. State update uses conditional lastClaimDateKey !== todayKey.
 * 4. Device clock is ignored — eligibility uses server `now` → istDateKey only.
 *    At 12:00 AM IST, todayKey rolls → canClaimToday becomes true automatically.
 */
export async function claimDailyCheckIn(input: {
  firebaseUid: string;
  now?: Date;
}): Promise<CheckInStatusPayload> {
  if (!isDailyCheckInEnabled()) {
    throw new CheckInError('Daily check-in is disabled', 404, 'DISABLED');
  }

  const now = input.now ?? new Date();
  const todayKey = istDateKey(now);

  const user = await User.findOne({ firebaseUid: input.firebaseUid }).select(
    '_id role coins firebaseUid'
  );
  if (!user) {
    throw new CheckInError('User not found', 404);
  }
  if (user.role !== 'user') {
    throw new CheckInError('Daily check-in is only available for users', 403, 'ROLE');
  }

  const session = await mongoose.startSession();
  let result: CheckInStatusPayload | null = null;
  let creditedCoins = 0;

  try {
    await session.withTransaction(async () => {
      const freshUser = await User.findById(user._id)
        .select('_id role coins firebaseUid')
        .session(session);
      if (!freshUser || freshUser.role !== 'user') {
        throw new CheckInError('Daily check-in is only available for users', 403, 'ROLE');
      }

      const state = await ensureState(freshUser._id, session);

      if (state.lastClaimDateKey === todayKey) {
        result = toStatusPayload(state, freshUser.coins ?? 0, now, {
          alreadyClaimed: true,
          coinsCredited: 0,
        });
        return;
      }

      const dayIndex = state.nextDayIndex;
      const coins = getDailyCheckInRewardForDay(dayIndex);
      const txnId = dailyCheckInTransactionId(freshUser._id, todayKey);
      const nextDayIndex =
        dayIndex >= CHECKIN_CYCLE_DAYS ? 1 : dayIndex + 1;

      try {
        await CoinTransaction.create(
          [
            {
              transactionId: txnId,
              userId: freshUser._id,
              type: 'credit',
              coins,
              source: 'daily_checkin',
              description: `Daily check-in Day ${dayIndex} reward`,
              status: 'completed',
            },
          ],
          { session }
        );
      } catch (err) {
        if (isDuplicateKeyError(err)) {
          const reloaded = await DailyCheckInState.findOne({
            userId: freshUser._id,
          }).session(session);
          const balUser = await User.findById(freshUser._id)
            .select('coins')
            .session(session);
          result = toStatusPayload(
            reloaded ?? state,
            balUser?.coins ?? freshUser.coins ?? 0,
            now,
            { alreadyClaimed: true, coinsCredited: 0 }
          );
          return;
        }
        throw err;
      }

      const walletUpdate = await User.updateOne(
        { _id: freshUser._id, role: 'user' },
        { $inc: { coins } },
        { session }
      );
      if (walletUpdate.modifiedCount !== 1) {
        throw new CheckInError('Failed to credit wallet', 500, 'WALLET');
      }

      // Conditional state claim — second concurrent txn loses even if it somehow
      // raced past the read check (belt-and-suspenders with unique txn id).
      const stateClaim = await DailyCheckInState.updateOne(
        {
          _id: state._id,
          $or: [
            { lastClaimDateKey: { $ne: todayKey } },
            { lastClaimDateKey: null },
          ],
        },
        {
          $set: {
            lastClaimDateKey: todayKey,
            lastClaimedDayIndex: dayIndex,
            nextDayIndex,
          },
        },
        { session }
      );

      if (stateClaim.modifiedCount !== 1) {
        // Another request already claimed this IST day — abort wallet credit
        // by throwing so the transaction rolls back the $inc + CoinTransaction.
        throw new CheckInError('Already claimed today', 409, 'ALREADY_CLAIMED');
      }

      const updatedUser = await User.findById(freshUser._id)
        .select('coins')
        .session(session);
      creditedCoins = coins;

      const updatedState = {
        nextDayIndex,
        lastClaimDateKey: todayKey,
        lastClaimedDayIndex: dayIndex,
      };
      result = toStatusPayload(
        updatedState,
        updatedUser?.coins ?? freshUser.coins + coins,
        now,
        {
          alreadyClaimed: false,
          coinsCredited: coins,
        }
      );
    });
  } catch (err) {
    if (err instanceof CheckInError && err.code === 'ALREADY_CLAIMED') {
      // Transaction aborted — return idempotent success from current DB state.
      const state = await DailyCheckInState.findOne({ userId: user._id });
      const balUser = await User.findById(user._id).select('coins');
      return toStatusPayload(
        state ?? {
          nextDayIndex: 1,
          lastClaimDateKey: todayKey,
          lastClaimedDayIndex: 1,
        },
        balUser?.coins ?? user.coins ?? 0,
        now,
        { alreadyClaimed: true, coinsCredited: 0 }
      );
    }
    throw err;
  } finally {
    await session.endSession();
  }

  if (!result) {
    throw new CheckInError('Claim failed', 500);
  }

  const payload = result as CheckInStatusPayload;

  if (!payload.alreadyClaimed && creditedCoins > 0) {
    await emitCoinsUpdated(user.firebaseUid, user._id, payload.coinsBalance);
    verifyUserBalance(user._id).catch(() => {});
    logInfo('Daily check-in claimed', {
      userId: user._id.toString(),
      dateKey: todayKey,
      coins: creditedCoins,
      dayIndex: payload.currentDayIndex,
    });
  }

  return payload;
}
