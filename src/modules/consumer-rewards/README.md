# Consumer Rewards Hub

Mongo-backed live config (`ConsumerRewardConfig`) + domain hooks + hub API.

## Endpoints

- `GET /api/v1/rewards/hub` — task list + progress
- `POST /api/v1/rewards/tasks/:key/claim` — manual claim (profile/follow/daily)
- Telegram remains under `/api/v1/rewards/telegram/*`
- Admin: `GET/PUT /api/v1/admin/consumer-rewards` (+ readiness flags, daily budget)
- Admin: `GET /api/v1/admin/rewards/monitor?range=today|7d`
- Admin: `GET /api/v1/admin/rewards/recon` (`?run=1` to execute)

## Config

Env seeds first Mongo doc only (`REWARD_*`, `CONSUMER_REWARDS_ENABLED`). Admin Settings overwrites live amounts without redeploy.

See [docs/REWARDS_LAUNCH.md](../../docs/REWARDS_LAUNCH.md) for production enable ladder, recon, and budget ops.

## Anti-abuse / hardening

- Unique `CoinTransaction.transactionId`, role=`user` only
- True first recharge (exactly one completed `payment_gateway` credit)
- Watch reward free-tier access only (`FREE` / `PREVIEW` / `VIP`)
- Avatar photo reward requires approved/auto-ok (or null) moderation
- Atomic daily `$addToSet` progress; referral purchase/call share one txn id + `rewardGranted`
- Soft daily budget alerts (`alert_only`); nightly ledger recon + fraud monitor
