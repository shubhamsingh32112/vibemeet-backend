import mongoose from 'mongoose';
import { User } from '../user/user.model';
import { CoinTransaction } from '../user/coin-transaction.model';
import { getIO } from '../../config/socket';
import { verifyUserBalance } from '../../utils/balance-integrity';
import { logError, logInfo, logWarning } from '../../utils/logger';
import {
  getTelegramBotUsername,
  getTelegramWebhookSecret,
} from './telegram-reward.config';
import {
  createTelegramLinkPayload,
  verifyTelegramLinkPayload,
} from './telegram-link-token';
import {
  getChatMember,
  isActiveChannelMember,
  sendTelegramMessage,
  TelegramApiError,
} from './telegram-bot.client';
import { getOrCreateTelegramRewardConfig } from './telegram-reward-config.model';

export class TelegramRewardError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly code?: string
  ) {
    super(message);
    this.name = 'TelegramRewardError';
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

export function telegramJoinRewardTransactionId(
  userId: mongoose.Types.ObjectId | string
): string {
  return `telegram_join_reward_${userId.toString()}`;
}

export type TelegramRewardStatusPayload = {
  enabled: boolean;
  claimed: boolean;
  linked: boolean;
  channelUrl: string;
  rewardCoins: number;
  botUsername: string;
  coinsBalance: number;
  misconfigured?: boolean;
};

export type TelegramVerifyPayload = {
  success: boolean;
  alreadyClaimed: boolean;
  coinsCredited: number;
  coins: number;
  balance: number;
};

export type TelegramLinkTokenPayload = {
  deepLink: string;
  expiresInSeconds: number;
};

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
    logError('Failed to emit coins_updated for telegram reward', err as Error);
  }
}

function assertConfigReady(cfg: {
  enabled: boolean;
  channelUrl: string;
  channelChatId: string;
  rewardCoins: number;
}): void {
  if (!cfg.enabled) {
    throw new TelegramRewardError('Telegram reward is disabled', 403, 'DISABLED');
  }
  if (!cfg.channelUrl.trim() || !cfg.channelChatId.trim()) {
    throw new TelegramRewardError(
      'Telegram reward is misconfigured',
      503,
      'MISCONFIGURED'
    );
  }
  if (!Number.isFinite(cfg.rewardCoins) || cfg.rewardCoins < 1) {
    throw new TelegramRewardError(
      'Telegram reward is misconfigured',
      503,
      'MISCONFIGURED'
    );
  }
}

export async function getTelegramRewardStatus(input: {
  firebaseUid: string;
}): Promise<TelegramRewardStatusPayload> {
  const cfg = await getOrCreateTelegramRewardConfig();
  const botUsername = getTelegramBotUsername();

  const user = await User.findOne({ firebaseUid: input.firebaseUid }).select(
    '_id role coins telegramUserId telegramRewardClaimed'
  );
  if (!user) {
    throw new TelegramRewardError('User not found', 404);
  }
  if (user.role !== 'user') {
    throw new TelegramRewardError(
      'Telegram reward is only available for users',
      403,
      'ROLE'
    );
  }

  const misconfigured =
    cfg.enabled &&
    (!cfg.channelUrl.trim() || !cfg.channelChatId.trim() || !botUsername);

  return {
    enabled: cfg.enabled && !misconfigured,
    claimed: Boolean(user.telegramRewardClaimed),
    linked: Boolean(user.telegramUserId),
    channelUrl: cfg.channelUrl,
    rewardCoins: cfg.rewardCoins,
    botUsername,
    coinsBalance: user.coins ?? 0,
    misconfigured: misconfigured || undefined,
  };
}

export async function createTelegramLinkToken(input: {
  firebaseUid: string;
}): Promise<TelegramLinkTokenPayload> {
  const cfg = await getOrCreateTelegramRewardConfig();
  assertConfigReady(cfg);

  const botUsername = getTelegramBotUsername();
  if (!botUsername) {
    throw new TelegramRewardError(
      'Telegram bot is not configured',
      503,
      'BOT_NOT_CONFIGURED'
    );
  }

  const user = await User.findOne({ firebaseUid: input.firebaseUid }).select(
    '_id role telegramUserId telegramRewardClaimed'
  );
  if (!user) {
    throw new TelegramRewardError('User not found', 404);
  }
  if (user.role !== 'user') {
    throw new TelegramRewardError(
      'Telegram reward is only available for users',
      403,
      'ROLE'
    );
  }
  if (user.telegramRewardClaimed) {
    throw new TelegramRewardError('Reward already claimed', 400, 'ALREADY_CLAIMED');
  }
  if (user.telegramUserId) {
    // Already linked — still allow regenerating deep link is unnecessary; return existing guidance via deep link to bot without payload.
    // Prefer re-issuing a signed payload so user can re-open bot if needed (idempotent bind).
  }

  const payload = createTelegramLinkPayload(user._id.toString());
  return {
    deepLink: `https://t.me/${botUsername}?start=${payload}`,
    expiresInSeconds: 30 * 60,
  };
}

type TelegramUpdate = {
  message?: {
    text?: string;
    chat?: { id?: number };
    from?: { id?: number; is_bot?: boolean };
  };
};

export async function handleTelegramWebhook(input: {
  secret: string;
  update: TelegramUpdate;
}): Promise<{ ok: true }> {
  const expected = getTelegramWebhookSecret();
  if (!expected || input.secret !== expected) {
    throw new TelegramRewardError('Invalid webhook secret', 401, 'UNAUTHORIZED');
  }

  const message = input.update?.message;
  const text = typeof message?.text === 'string' ? message.text.trim() : '';
  const fromId = message?.from?.id;
  const chatId = message?.chat?.id;

  if (!text || fromId == null || chatId == null) {
    return { ok: true };
  }
  if (message?.from?.is_bot) {
    return { ok: true };
  }

  if (!text.startsWith('/start')) {
    await sendTelegramMessage(
      chatId,
      'Open MatchVibe → FREE COINS → Join Channel, then tap Connect account so we can link your profile.'
    );
    return { ok: true };
  }

  const startArg = text.replace(/^\/start(@\w+)?\s*/i, '').trim();
  if (!startArg) {
    await sendTelegramMessage(
      chatId,
      'Missing link. Return to MatchVibe, tap Connect account (must open from the app so your account can be verified), then press Start here.'
    );
    return { ok: true };
  }

  const verified = verifyTelegramLinkPayload(startArg);
  if (!verified) {
    await sendTelegramMessage(
      chatId,
      'This link expired or is invalid. Return to MatchVibe and tap Link Telegram again.'
    );
    return { ok: true };
  }

  if (!mongoose.isValidObjectId(verified.userId)) {
    await sendTelegramMessage(chatId, 'Invalid link. Please try again from MatchVibe.');
    return { ok: true };
  }

  const telegramUserId = String(fromId);
  const userId = new mongoose.Types.ObjectId(verified.userId);

  const existingByTg = await User.findOne({ telegramUserId })
    .select('_id')
    .lean();
  if (existingByTg && !existingByTg._id.equals(userId)) {
    await sendTelegramMessage(
      chatId,
      'This Telegram account is already linked to another MatchVibe account.'
    );
    return { ok: true };
  }

  const user = await User.findById(userId).select(
    '_id role telegramUserId telegramRewardClaimed'
  );
  if (!user || user.role !== 'user') {
    await sendTelegramMessage(chatId, 'Account not eligible for this reward.');
    return { ok: true };
  }

  if (user.telegramUserId && user.telegramUserId !== telegramUserId) {
    await sendTelegramMessage(
      chatId,
      'This MatchVibe account is already linked to a different Telegram account.'
    );
    return { ok: true };
  }

  if (user.telegramUserId === telegramUserId) {
    await sendTelegramMessage(
      chatId,
      'Already linked! Join our Telegram channel, then return to MatchVibe and tap Verify.'
    );
    return { ok: true };
  }

  try {
    const result = await User.updateOne(
      {
        _id: userId,
        role: 'user',
        $or: [{ telegramUserId: null }, { telegramUserId: { $exists: false } }],
      },
      {
        $set: {
          telegramUserId,
          telegramLinkedAt: new Date(),
        },
      }
    );

    if (result.modifiedCount !== 1) {
      // Race: another request linked, or unique index conflict below.
      const refreshed = await User.findById(userId).select('telegramUserId').lean();
      if (refreshed?.telegramUserId === telegramUserId) {
        await sendTelegramMessage(
          chatId,
          'Linked! Join our Telegram channel, then return to MatchVibe and tap Verify.'
        );
        return { ok: true };
      }
      await sendTelegramMessage(
        chatId,
        'Could not link this account. Please try again from MatchVibe.'
      );
      return { ok: true };
    }
  } catch (err) {
    if (isDuplicateKeyError(err)) {
      await sendTelegramMessage(
        chatId,
        'This Telegram account is already linked to another MatchVibe account.'
      );
      return { ok: true };
    }
    logError('Telegram link bind failed', err as Error);
    await sendTelegramMessage(chatId, 'Something went wrong. Please try again later.');
    return { ok: true };
  }

  logInfo('Telegram account linked', {
    userId: userId.toString(),
    telegramUserId,
  });

  await sendTelegramMessage(
    chatId,
    'Linked! Join our official Telegram channel, then return to MatchVibe and tap Verify to claim your coins.'
  );
  return { ok: true };
}

export async function verifyAndClaimTelegramReward(input: {
  firebaseUid: string;
}): Promise<TelegramVerifyPayload> {
  const cfg = await getOrCreateTelegramRewardConfig();
  assertConfigReady(cfg);

  const user = await User.findOne({ firebaseUid: input.firebaseUid }).select(
    '_id role coins firebaseUid telegramUserId telegramRewardClaimed'
  );
  if (!user) {
    throw new TelegramRewardError('User not found', 404);
  }
  if (user.role !== 'user') {
    throw new TelegramRewardError(
      'Telegram reward is only available for users',
      403,
      'ROLE'
    );
  }

  // Early exit before Telegram API — save quota + rate limit budget.
  if (user.telegramRewardClaimed) {
    return {
      success: true,
      alreadyClaimed: true,
      coinsCredited: 0,
      coins: 0,
      balance: user.coins ?? 0,
    };
  }

  if (!user.telegramUserId) {
    throw new TelegramRewardError(
      'Link your Telegram account first',
      400,
      'NOT_LINKED'
    );
  }

  let memberStatus: string;
  try {
    const member = await getChatMember(cfg.channelChatId, user.telegramUserId);
    memberStatus = member.status;
  } catch (err) {
    if (err instanceof TelegramApiError) {
      if (err.code === 'NOT_JOINED') {
        try {
          const { recordRewardMetric } = await import(
            '../consumer-rewards/reward-metrics'
          );
          recordRewardMetric('telegram_verify_not_joined', 1);
        } catch {
          // ignore
        }
        throw new TelegramRewardError(
          'Join the Telegram channel first, then tap Verify',
          400,
          'NOT_JOINED'
        );
      }
      try {
        const { recordRewardMetric } = await import(
          '../consumer-rewards/reward-metrics'
        );
        recordRewardMetric('telegram_verify_api_error', 1, {
          code: err.code || 'API',
        });
      } catch {
        // ignore
      }
      throw new TelegramRewardError(err.message, err.statusCode, err.code);
    }
    throw err;
  }

  if (!isActiveChannelMember(memberStatus as Parameters<typeof isActiveChannelMember>[0])) {
    try {
      const { recordRewardMetric } = await import(
        '../consumer-rewards/reward-metrics'
      );
      recordRewardMetric('telegram_verify_not_joined', 1);
    } catch {
      // ignore
    }
    throw new TelegramRewardError(
      'Join the Telegram channel first, then tap Verify',
      400,
      'NOT_JOINED'
    );
  }

  const rewardCoins = cfg.rewardCoins;
  const session = await mongoose.startSession();
  let payload: TelegramVerifyPayload | null = null;

  try {
    await session.withTransaction(async () => {
      const freshUser = await User.findById(user._id)
        .select(
          '_id role coins firebaseUid telegramUserId telegramRewardClaimed'
        )
        .session(session);

      if (!freshUser || freshUser.role !== 'user') {
        throw new TelegramRewardError(
          'Telegram reward is only available for users',
          403,
          'ROLE'
        );
      }

      if (freshUser.telegramRewardClaimed) {
        payload = {
          success: true,
          alreadyClaimed: true,
          coinsCredited: 0,
          coins: 0,
          balance: freshUser.coins ?? 0,
        };
        return;
      }

      if (!freshUser.telegramUserId) {
        throw new TelegramRewardError(
          'Link your Telegram account first',
          400,
          'NOT_LINKED'
        );
      }

      const txnId = telegramJoinRewardTransactionId(freshUser._id);

      try {
        await CoinTransaction.create(
          [
            {
              transactionId: txnId,
              userId: freshUser._id,
              type: 'credit',
              coins: rewardCoins,
              source: 'telegram_join_reward',
              description: 'Telegram Join Reward',
              status: 'completed',
            },
          ],
          { session }
        );
      } catch (err) {
        if (isDuplicateKeyError(err)) {
          const balUser = await User.findById(freshUser._id)
            .select('coins')
            .session(session);
          payload = {
            success: true,
            alreadyClaimed: true,
            coinsCredited: 0,
            coins: 0,
            balance: balUser?.coins ?? freshUser.coins ?? 0,
          };
          return;
        }
        throw err;
      }

      const claimUpdate = await User.updateOne(
        {
          _id: freshUser._id,
          role: 'user',
          telegramRewardClaimed: { $ne: true },
        },
        {
          $set: {
            telegramRewardClaimed: true,
            telegramRewardClaimedAt: new Date(),
          },
          $inc: { coins: rewardCoins },
        },
        { session }
      );

      if (claimUpdate.modifiedCount !== 1) {
        // Concurrent claim won — roll back txn + credit via abort.
        throw new TelegramRewardError('Reward already claimed', 409, 'ALREADY_CLAIMED');
      }

      const balUser = await User.findById(freshUser._id)
        .select('coins')
        .session(session);

      payload = {
        success: true,
        alreadyClaimed: false,
        coinsCredited: rewardCoins,
        coins: rewardCoins,
        balance: balUser?.coins ?? (freshUser.coins ?? 0) + rewardCoins,
      };
    });
  } catch (err) {
    if (err instanceof TelegramRewardError && err.code === 'ALREADY_CLAIMED') {
      const balUser = await User.findById(user._id).select('coins');
      return {
        success: true,
        alreadyClaimed: true,
        coinsCredited: 0,
        coins: 0,
        balance: balUser?.coins ?? user.coins ?? 0,
      };
    }
    throw err;
  } finally {
    await session.endSession();
  }

  // Assignments occur inside withTransaction callback; cast for CFA across closure.
  const settled = payload as TelegramVerifyPayload | null;
  if (!settled) {
    throw new TelegramRewardError('Failed to claim reward', 500, 'WALLET');
  }

  if (!settled.alreadyClaimed && settled.coinsCredited > 0) {
    await emitCoinsUpdated(user.firebaseUid, user._id, settled.balance);
    verifyUserBalance(user._id).catch((err) => {
      logWarning('telegram reward balance integrity check failed', {
        userId: user._id.toString(),
        error: err instanceof Error ? err.message : String(err),
      });
    });
    try {
      const {
        recordRewardCreditSuccess,
        trackRewardIssuance,
        recordRewardMetric,
      } = await import('../consumer-rewards/reward-metrics');
      recordRewardMetric('telegram_verify_ok', 1);
      recordRewardCreditSuccess('telegram_join', settled.coinsCredited);
      void trackRewardIssuance(settled.coinsCredited);
    } catch {
      // non-fatal
    }
    logInfo('Telegram join reward claimed', {
      userId: user._id.toString(),
      coins: settled.coinsCredited,
      balance: settled.balance,
    });
    try {
      const { onCreatorReferralTelegramClaimed } = await import(
        '../creator-referral/creator-referral-reward.service'
      );
      onCreatorReferralTelegramClaimed(user._id);
    } catch {
      // non-fatal
    }
  } else if (settled.alreadyClaimed) {
    try {
      const { recordRewardCreditAlready } = await import(
        '../consumer-rewards/reward-metrics'
      );
      recordRewardCreditAlready('telegram_join');
    } catch {
      // non-fatal
    }
    // Already claimed earlier — still mark creator referral edge if present.
    try {
      const { onCreatorReferralTelegramClaimed } = await import(
        '../creator-referral/creator-referral-reward.service'
      );
      onCreatorReferralTelegramClaimed(user._id);
    } catch {
      // non-fatal
    }
  }

  return settled;
}
