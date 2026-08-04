/** Env secrets for Telegram bot + bootstrap defaults when Mongo config is empty. */

export function getTelegramBotToken(): string {
  return (process.env.TELEGRAM_BOT_TOKEN || '').trim();
}

export function getTelegramBotUsername(): string {
  return (process.env.TELEGRAM_BOT_USERNAME || '').trim().replace(/^@/, '');
}

export function getTelegramWebhookSecret(): string {
  return (process.env.TELEGRAM_WEBHOOK_SECRET || '').trim();
}

export function getTelegramLinkTokenSecret(): string {
  const explicit = (process.env.TELEGRAM_LINK_TOKEN_SECRET || '').trim();
  if (explicit) return explicit;
  const jwt = (process.env.JWT_SECRET || '').trim();
  if (jwt) return `telegram_link:${jwt}`;
  return '';
}

export function getTelegramRewardDefaultEnabled(): boolean {
  return process.env.TELEGRAM_REWARD_DEFAULT_ENABLED === 'true';
}

export function getTelegramRewardDefaultCoins(): number {
  const n = Number(process.env.TELEGRAM_REWARD_DEFAULT_COINS ?? 100);
  if (!Number.isFinite(n) || n < 1) return 100;
  return Math.min(Math.floor(n), 10000);
}

export const TELEGRAM_LINK_TOKEN_TTL_MS = 30 * 60 * 1000; // 30 minutes
export const TELEGRAM_REWARD_COINS_MAX = 10000;
