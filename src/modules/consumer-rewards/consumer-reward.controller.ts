import { Request, Response } from 'express';
import { logError } from '../../utils/logger';
import { assertAdmin } from '../../middlewares/staff.middleware';
import {
  ConsumerRewardConfig,
  getOrCreateConsumerRewardConfig,
  invalidateConsumerRewardConfigCache,
  type ConsumerRewardTasksConfig,
  type TaskConfigSlice,
} from './consumer-reward-config.model';
import { buildDefaultTaskConfig } from './task-registry';
import {
  ConsumerRewardError,
  claimRewardsTask,
  getRewardsHubForUser,
} from './hub.service';
import { isConsumerRewardTaskKey } from './task-keys';
import { recordRewardMetric } from './reward-metrics';
import {
  getTelegramBotToken,
  getTelegramWebhookSecret,
  getTelegramBotUsername,
} from '../telegram-reward/telegram-reward.config';
import { getOrCreateTelegramRewardConfig } from '../telegram-reward/telegram-reward-config.model';
import { getRewardsMonitor } from './reward-monitor.service';
import { getLatestReconReport, runRewardReconciliation } from './reward-reconciliation.job';

function handleError(res: Response, err: unknown): void {
  if (err instanceof ConsumerRewardError) {
    res.status(err.statusCode).json({
      success: false,
      error: err.message,
      code: err.code,
    });
    return;
  }
  logError('Consumer rewards error', err as Error);
  res.status(500).json({ success: false, error: 'Internal server error' });
}

export const getRewardsHubHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  const started = Date.now();
  try {
    if (!req.auth?.firebaseUid) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }
    const data = await getRewardsHubForUser({
      firebaseUid: req.auth.firebaseUid,
    });
    res.json({ success: true, data });
  } catch (err) {
    handleError(res, err);
  } finally {
    recordRewardMetric('hub_latency_ms', Date.now() - started);
  }
};

export const claimRewardsTaskHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    if (!req.auth?.firebaseUid) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }
    const key = typeof req.params.key === 'string' ? req.params.key : '';
    if (!isConsumerRewardTaskKey(key)) {
      res.status(400).json({ success: false, error: 'Unknown task key' });
      return;
    }
    const data = await claimRewardsTask({
      firebaseUid: req.auth.firebaseUid,
      taskKey: key,
    });
    res.json({ success: true, data });
  } catch (err) {
    handleError(res, err);
  }
};

async function buildReadiness() {
  const tgCfg = await getOrCreateTelegramRewardConfig();
  const consumer = await getOrCreateConsumerRewardConfig();
  return {
    botTokenSet: Boolean(getTelegramBotToken()),
    webhookSecretSet: Boolean(getTelegramWebhookSecret()),
    botUsernameSet: Boolean(getTelegramBotUsername()),
    telegramChannelConfigured: Boolean(
      tgCfg.channelUrl?.trim() && tgCfg.channelChatId?.trim()
    ),
    telegramRewardEnabled: tgCfg.enabled,
    consumerEnabled: consumer.enabled,
    mongoTxnNote:
      'Mongo multi-document transactions require a replica set (including rs.initiate() in local/dev)',
  };
}

export const getConsumerRewardsConfigAdmin = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    if (!(await assertAdmin(req, res))) return;
    const data = await getOrCreateConsumerRewardConfig();
    const readiness = await buildReadiness();
    res.json({ success: true, data: { ...data, readiness } });
  } catch (err) {
    logError('Get consumer rewards config error', err as Error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

function validateTaskSlice(
  key: string,
  slice: TaskConfigSlice
): string | null {
  const coins = Number(slice.coins);
  if (!Number.isFinite(coins) || coins < 0 || coins > 100000) {
    return `Invalid coins for ${key} (0..100000)`;
  }
  if (slice.targetCount !== undefined) {
    const t = Number(slice.targetCount);
    if (!Number.isFinite(t) || t < 1 || t > 50) {
      return `Invalid targetCount for ${key} (1..50)`;
    }
  }
  if (slice.minSeconds !== undefined) {
    const s = Number(slice.minSeconds);
    if (!Number.isFinite(s) || s < 30 || s > 3600) {
      return `Invalid minSeconds for ${key} (30..3600)`;
    }
  }
  if (slice.minPurchaseInr !== undefined) {
    const m = Number(slice.minPurchaseInr);
    if (!Number.isFinite(m) || m < 0 || m > 10_000_000) {
      return `Invalid minPurchaseInr for ${key}`;
    }
  }
  return null;
}

export const updateConsumerRewardsConfigAdmin = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    if (!(await assertAdmin(req, res))) return;

    const enabled = req.body?.enabled !== false;
    const tasksInput = req.body?.tasks;
    const defaults = buildDefaultTaskConfig();
    const tasks = {
      ...defaults,
      ...(tasksInput && typeof tasksInput === 'object' ? tasksInput : {}),
    } as ConsumerRewardTasksConfig;

    for (const [k, slice] of Object.entries(tasks) as [
      keyof ConsumerRewardTasksConfig,
      TaskConfigSlice,
    ][]) {
      if (!slice || typeof slice !== 'object') continue;
      const errMsg = validateTaskSlice(String(k), {
        ...defaults[k],
        ...slice,
        coins: Number(slice.coins),
        enabled: slice.enabled !== false,
      });
      if (errMsg) {
        res.status(400).json({ success: false, error: errMsg });
        return;
      }
      slice.coins = Math.floor(Number(slice.coins));
      slice.enabled = slice.enabled !== false;
      if (slice.targetCount !== undefined) {
        slice.targetCount = Math.floor(Number(slice.targetCount));
      }
      if (slice.minSeconds !== undefined) {
        slice.minSeconds = Math.floor(Number(slice.minSeconds));
      }
      if (slice.minPurchaseInr !== undefined) {
        slice.minPurchaseInr = Math.floor(Number(slice.minPurchaseInr));
      }
    }

    let dailyRewardBudgetCoins: number | undefined;
    if (req.body?.dailyRewardBudgetCoins !== undefined) {
      const b = Number(req.body.dailyRewardBudgetCoins);
      if (!Number.isFinite(b) || b < 0 || b > 100_000_000) {
        res.status(400).json({
          success: false,
          error: 'dailyRewardBudgetCoins must be 0..100000000',
        });
        return;
      }
      dailyRewardBudgetCoins = Math.floor(b);
    }

    const $set: Record<string, unknown> = { enabled, tasks };
    if (dailyRewardBudgetCoins !== undefined) {
      $set.dailyRewardBudgetCoins = dailyRewardBudgetCoins;
    }
    if (req.body?.dailyBudgetMode === 'alert_only') {
      $set.dailyBudgetMode = 'alert_only';
    }

    await ConsumerRewardConfig.findOneAndUpdate(
      { singletonKey: 'global' },
      {
        $set,
        $setOnInsert: { singletonKey: 'global' },
      },
      { upsert: true, new: true }
    );

    invalidateConsumerRewardConfigCache();
    const data = await getOrCreateConsumerRewardConfig();
    const readiness = await buildReadiness();
    res.json({ success: true, data: { ...data, readiness } });
  } catch (err) {
    logError('Update consumer rewards config error', err as Error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

export const getRewardsMonitorAdmin = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    if (!(await assertAdmin(req, res))) return;
    const range =
      req.query.range === '7d' ? ('7d' as const) : ('today' as const);
    const data = await getRewardsMonitor(range);
    res.json({ success: true, data });
  } catch (err) {
    logError('Get rewards monitor error', err as Error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

export const getRewardsReconAdmin = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    if (!(await assertAdmin(req, res))) return;
    const force = req.query.run === '1' || req.query.run === 'true';
    if (force) {
      const report = await runRewardReconciliation();
      res.json({ success: true, data: report });
      return;
    }
    const latest = await getLatestReconReport();
    res.json({ success: true, data: latest });
  } catch (err) {
    logError('Get rewards recon error', err as Error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};
