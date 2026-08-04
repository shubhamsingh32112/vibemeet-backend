# Rewards Launch Runbook

Operations guide for Telegram Join Reward, Consumer Rewards Hub, and Daily Check-in.

## Prerequisites

### Secrets / env

| Variable | Purpose |
|----------|---------|
| `TELEGRAM_BOT_TOKEN` | Bot API token |
| `TELEGRAM_BOT_USERNAME` | Bot username without `@` |
| `TELEGRAM_WEBHOOK_SECRET` | Path secret for `POST /api/v1/rewards/telegram/webhook/:secret` |
| `TELEGRAM_LINK_TOKEN_SECRET` or `JWT_SECRET` | Signed deep-link bind payloads |
| `CONSUMER_REWARDS_ENABLED` | Master kill switch (`false` disables hub credits even if Mongo `enabled`) |
| `DAILY_CHECKIN_ENABLED` | Daily check-in opt-in (`true` to enable) |
| Seed coins envs | Only seed the first Mongo `ConsumerRewardConfig` / Telegram config docs |

Set Telegram webhook after deploy:

```bash
curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
  -d "url=https://YOUR_API_HOST/api/v1/rewards/telegram/webhook/$TELEGRAM_WEBHOOK_SECRET"
```

Bot must be **admin** (or at least able to call `getChatMember`) on the channel.

### Mongo replica set

Reward claims use multi-document transactions (`CoinTransaction` + `User.coins` + progress). A **replica set** is required (local: `rs.initiate()`).

## Admin surfaces

| Endpoint | Role |
|----------|------|
| `GET/PUT /api/v1/admin/consumer-rewards` | Hub master + per-task coins/toggles, daily budget, **readiness** flags |
| `GET/PUT /api/v1/admin/telegram-reward` | Telegram enable, channel URL/chat id, coins |
| `GET /api/v1/admin/rewards/monitor?range=today\|7d` | Fraud/issuance widgets (read-only) |
| `GET /api/v1/admin/rewards/recon` | Latest nightly recon report; `?run=1` to run immediately |

Readiness fields (non-secret): `botTokenSet`, `webhookSecretSet`, `telegramChannelConfigured`, `consumerEnabled`, `mongoTxnNote`.

### Soft daily budget

- `dailyRewardBudgetCoins` default **500_000**
- `dailyBudgetMode: alert_only` — when Redis counter `reward_coins_issued:{istDate}` crosses budget, **log + metric only**; credits continue

### Nightly recon

Runs ~**01:30 IST** (api-ws / hygiene role). Compares reward ledger credits for previous IST day, sample-wallets via `verifyUserBalance`, writes latest report for admin GET.

## Enable ladder (production)

Enable **only after** correctness tests and monitor/recon are green. Default: everything **admin-off** until ops intentionally flip.

```
1. Daily Check-in          (DAILY_CHECKIN_ENABLED=true)
2. Photo / Complete profile (hub tasks)
3. Watch / Like / Follow   (daily + once engagement)
4. Telegram join reward    (Mongo telegram enabled + env bot)
5. First video call
6. First recharge
7. Referral (invite + successful)
```

**Why financial last:** call / recharge / referral move large coin amounts; engagement rewards are lower abuse surface and easier to pause.

### Per-step rollback

Turn task `enabled=false` in admin (no redeploy). Overnight recon stays on.

### Master kill switches

- `CONSUMER_REWARDS_ENABLED=false` — all hub credits stop
- Telegram Mongo `enabled=false`
- `DAILY_CHECKIN_ENABLED=false`
- Per-task toggles under Consumer Rewards

## Monitor how-to

1. Open Admin → Settings → Rewards monitor (or `GET /admin/rewards/monitor?range=today`)
2. Watch coins issued, top earners, telegram claim count, softAlerts
3. Investigate via `/admin/rewards/recon` if wallet mismatches or budget alerts fire

## Manual QA (staging)

- Photo reward only after approved/auto-ok avatar
- First recharge: second completed purchase must **not** pay bonus
- Watch reward only on FREE/PREVIEW/VIP access reasons
- Telegram: webhook update ×10 → one link; verify ×10 → one credit
- Referral: purchase path once; call path same referred user → no second wallet credit
- IST daily ids differ across 23:59:59 / 00:00:00 / 00:00:01 IST
- Budget dry-run: lower `dailyRewardBudgetCoins`, credit, confirm `reward.budget_exceeded` log
