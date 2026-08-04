import { getTelegramBotToken } from './telegram-reward.config';
import { logError, logWarning } from '../../utils/logger';

const TELEGRAM_API_BASE = 'https://api.telegram.org';

export type TelegramChatMemberStatus =
  | 'creator'
  | 'administrator'
  | 'member'
  | 'restricted'
  | 'left'
  | 'kicked';

export class TelegramApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number = 502,
    public readonly code: string = 'TELEGRAM_API_ERROR'
  ) {
    super(message);
    this.name = 'TelegramApiError';
  }
}

async function callTelegramApi<T>(
  method: string,
  body: Record<string, unknown>
): Promise<T> {
  const token = getTelegramBotToken();
  if (!token) {
    throw new TelegramApiError('Telegram bot token is not configured', 503, 'BOT_NOT_CONFIGURED');
  }

  const url = `${TELEGRAM_API_BASE}/bot${token}/${method}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    logError('Telegram API network error', err as Error);
    throw new TelegramApiError('Failed to reach Telegram API', 502, 'TELEGRAM_API_ERROR');
  }

  let json: { ok?: boolean; result?: T; description?: string };
  try {
    json = (await response.json()) as typeof json;
  } catch (err) {
    logError('Telegram API invalid JSON', err as Error);
    throw new TelegramApiError('Invalid Telegram API response', 502, 'TELEGRAM_API_ERROR');
  }

  if (!response.ok || !json.ok) {
    const description = json.description || `Telegram API ${method} failed`;
    logWarning('Telegram API error', { method, description, status: response.status });
    // getChatMember returns 400 when user is not a member — surface as not joined.
    if (
      method === 'getChatMember' &&
      (response.status === 400 || /user not found|chat not found|participant/i.test(description))
    ) {
      throw new TelegramApiError(description, 400, 'NOT_JOINED');
    }
    throw new TelegramApiError(description, 502, 'TELEGRAM_API_ERROR');
  }

  return json.result as T;
}

export async function getChatMember(
  chatId: string,
  telegramUserId: string
): Promise<{ status: TelegramChatMemberStatus }> {
  return callTelegramApi<{ status: TelegramChatMemberStatus }>('getChatMember', {
    chat_id: chatId,
    user_id: Number(telegramUserId),
  });
}

export function isActiveChannelMember(status: TelegramChatMemberStatus): boolean {
  if (status === 'creator' || status === 'administrator' || status === 'member') {
    return true;
  }
  // Restricted users may still be members of a channel/supergroup.
  return false;
}

export async function sendTelegramMessage(
  chatId: number | string,
  text: string
): Promise<void> {
  try {
    await callTelegramApi('sendMessage', {
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
    });
  } catch (err) {
    logWarning('Failed to send Telegram message', {
      chatId: String(chatId),
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
