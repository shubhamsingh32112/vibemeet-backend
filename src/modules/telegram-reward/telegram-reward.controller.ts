import { Request, Response } from 'express';
import { logError } from '../../utils/logger';
import { assertAdmin } from '../../middlewares/staff.middleware';
import {
  TelegramRewardConfig,
  getOrCreateTelegramRewardConfig,
} from './telegram-reward-config.model';
import { TELEGRAM_REWARD_COINS_MAX } from './telegram-reward.config';
import {
  TelegramRewardError,
  createTelegramLinkToken,
  getTelegramRewardStatus,
  handleTelegramWebhook,
  verifyAndClaimTelegramReward,
} from './telegram-reward.service';

function handleError(res: Response, err: unknown): void {
  if (err instanceof TelegramRewardError) {
    res.status(err.statusCode).json({
      success: false,
      error: err.message,
      message: err.message,
      code: err.code,
    });
    return;
  }
  logError('Telegram reward error', err as Error);
  res.status(500).json({ success: false, error: 'Internal server error' });
}

export const getTelegramRewardStatusHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    if (!req.auth?.firebaseUid) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }
    const data = await getTelegramRewardStatus({
      firebaseUid: req.auth.firebaseUid,
    });
    res.json({ success: true, data });
  } catch (err) {
    handleError(res, err);
  }
};

export const createTelegramLinkTokenHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    if (!req.auth?.firebaseUid) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }
    const data = await createTelegramLinkToken({
      firebaseUid: req.auth.firebaseUid,
    });
    res.json({ success: true, data });
  } catch (err) {
    handleError(res, err);
  }
};

export const verifyTelegramRewardHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    if (!req.auth?.firebaseUid) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }
    const data = await verifyAndClaimTelegramReward({
      firebaseUid: req.auth.firebaseUid,
    });
    res.json({ success: true, data });
  } catch (err) {
    handleError(res, err);
  }
};

export const telegramWebhookHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    const secret = typeof req.params.secret === 'string' ? req.params.secret : '';
    await handleTelegramWebhook({
      secret,
      update: (req.body ?? {}) as Parameters<typeof handleTelegramWebhook>[0]['update'],
    });
    // Always 200 to Telegram once secret is accepted (or reject 401 via error).
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof TelegramRewardError && err.statusCode === 401) {
      res.status(401).json({ ok: false, error: 'Unauthorized' });
      return;
    }
    logError('Telegram webhook error', err as Error);
    // Still 200 to avoid Telegram retry storms for malformed updates after auth.
    res.json({ ok: true });
  }
};

export const getTelegramRewardConfigAdmin = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    if (!(await assertAdmin(req, res))) return;
    const data = await getOrCreateTelegramRewardConfig();
    res.json({ success: true, data });
  } catch (err) {
    logError('Get telegram reward config error', err as Error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

export const updateTelegramRewardConfigAdmin = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    if (!(await assertAdmin(req, res))) return;
    const enabled = Boolean(req.body?.enabled);
    const channelUrl =
      typeof req.body?.channelUrl === 'string' ? req.body.channelUrl.trim() : '';
    const channelChatId =
      typeof req.body?.channelChatId === 'string'
        ? req.body.channelChatId.trim()
        : '';
    const rewardCoins = Number(req.body?.rewardCoins);

    if (
      !Number.isFinite(rewardCoins) ||
      rewardCoins < 1 ||
      rewardCoins > TELEGRAM_REWARD_COINS_MAX
    ) {
      res.status(400).json({
        success: false,
        error: `rewardCoins must be between 1 and ${TELEGRAM_REWARD_COINS_MAX}`,
      });
      return;
    }

    if (enabled && (!channelUrl || !channelChatId)) {
      res.status(400).json({
        success: false,
        error: 'channelUrl and channelChatId are required when enabling',
      });
      return;
    }

    if (channelUrl && !/^https?:\/\/(t\.me|telegram\.me)\//i.test(channelUrl)) {
      res.status(400).json({
        success: false,
        error: 'channelUrl must be a t.me or telegram.me URL',
      });
      return;
    }

    await TelegramRewardConfig.findOneAndUpdate(
      { singletonKey: 'global' },
      {
        $set: {
          enabled,
          channelUrl,
          channelChatId,
          rewardCoins: Math.floor(rewardCoins),
        },
        $setOnInsert: { singletonKey: 'global' },
      },
      { upsert: true, new: true }
    );

    const data = await getOrCreateTelegramRewardConfig();
    res.json({ success: true, data });
  } catch (err) {
    logError('Update telegram reward config error', err as Error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};
