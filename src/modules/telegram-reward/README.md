/**
 * Telegram Join Reward — ops setup
 *
 * 1. Create a bot with BotFather; set TELEGRAM_BOT_TOKEN and TELEGRAM_BOT_USERNAME.
 * 2. Add the bot as an **administrator** of the target channel (required for getChatMember).
 * 3. Public API: set webhook
 *    https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<API_HOST>/api/v1/rewards/telegram/webhook/<TELEGRAM_WEBHOOK_SECRET>
 *    Local API without HTTPS: set TELEGRAM_UPDATES_POLLING=true (getUpdates; clears webhook on this bot).
 * 4. Configure TELEGRAM_WEBHOOK_SECRET and TELEGRAM_LINK_TOKEN_SECRET in env.
 * 5. In admin Settings → Rewards — Telegram: enable, set **channel** URL (not the bot), chat id, coins.
 *
 * Connect-account deep links use a compact signed `start` payload (≤64 chars; Telegram hard limit).
 * Anti-abuse: one claim per user, unique telegramUserId, HMAC link tokens, rate limits, fail-closed verify.
 */
