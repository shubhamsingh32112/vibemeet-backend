/**
 * Local / non-HTTPS dev: process Telegram updates via getUpdates when a public
 * webhook URL is not available.
 *
 * Enable with TELEGRAM_UPDATES_POLLING=true (mutually exclusive with webhook —
 * this clears any configured webhook on start).
 */
import {
  getTelegramBotToken,
  getTelegramWebhookSecret,
} from './telegram-reward.config';
import { handleTelegramWebhook } from './telegram-reward.service';
import { logError, logInfo, logWarning } from '../../utils/logger';

const API = 'https://api.telegram.org';

let stop = false;
let loopPromise: Promise<void> | null = null;

export function isTelegramUpdatesPollingEnabled(): boolean {
  return process.env.TELEGRAM_UPDATES_POLLING === 'true';
}

async function telegramCall(
  token: string,
  method: string,
  body?: Record<string, unknown>
): Promise<unknown> {
  const res = await fetch(`${API}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json()) as {
    ok?: boolean;
    result?: unknown;
    description?: string;
  };
  if (!json.ok) {
    throw new Error(json.description || `${method} failed`);
  }
  return json.result;
}

export function startTelegramUpdatesPolling(): void {
  if (!isTelegramUpdatesPollingEnabled()) return;
  if (loopPromise) return;

  const token = getTelegramBotToken();
  const secret = getTelegramWebhookSecret();
  if (!token || !secret) {
    logWarning(
      'TELEGRAM_UPDATES_POLLING set but TELEGRAM_BOT_TOKEN or TELEGRAM_WEBHOOK_SECRET missing — skip'
    );
    return;
  }

  stop = false;
  loopPromise = (async () => {
    try {
      await telegramCall(token, 'deleteWebhook', { drop_pending_updates: false });
      logInfo('Telegram updates polling started (webhook cleared)');
    } catch (err) {
      logError('Failed to delete Telegram webhook before polling', err as Error);
      return;
    }

    let offset = 0;
    while (!stop) {
      try {
        const updates = (await telegramCall(token, 'getUpdates', {
          offset,
          timeout: 25,
          allowed_updates: ['message'],
        })) as Array<{ update_id: number } & Record<string, unknown>>;

        for (const update of updates) {
          offset = update.update_id + 1;
          try {
            await handleTelegramWebhook({ secret, update });
          } catch (err) {
            logError('Telegram polling update failed', err as Error);
          }
        }
      } catch (err) {
        logError('Telegram getUpdates error', err as Error);
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  })().finally(() => {
    loopPromise = null;
  });
}

export function stopTelegramUpdatesPolling(): void {
  stop = true;
}
