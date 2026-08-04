# Rewards System — Code Changes: Before & After

**Document date:** 2026-08-04  
**Scope:** MatchVibe monorepo — consumer rewards (Telegram join, Rewards Hub, Daily Check-in) plus **Deployment Readiness / Scale Hardening (v2)**.  
**Repos:** `vibemeet-backend`, `vibemeet-admin`, `matchvibe-flutter`

This document is a forensic map of **what the code did before**, **what it does after**, and **exactly which files/paths changed**. Use it for PR review, QA, and rollout.

---

## 1. Executive summary

| Layer | Before (pre-rewards / early hub) | After (shipped + hardened) |
|-------|----------------------------------|----------------------------|
| **Product** | No unified consumer rewards surface; referral purchase reward only (env coins); no telegram join bonus; no missions hub; check-in may exist separately | Full stack: Daily Check-in + Rewards Hub missions + Telegram FAB; admin live amounts |
| **Wallet safety** | Referral path could double-pay; first recharge not gated; paid moment views could farm daily | Shared txn id + `rewardGranted`; true first purchase only; free-tier views only; approved avatar for photo |
| **Scale / races** | Daily progress via read-modify-`save()` | Atomic `$addToSet` + IST dateKey reset |
| **Ops** | No reward ledger recon, no fraud dash, no budget | Nightly recon (~01:30 IST), admin monitor, soft 500k budget, launch runbook |
| **Enablement** | All-or-nothing flags | Per-task toggles + documented enable ladder (financial last) |

---

## 2. Change inventory by repository

### 2.1 Backend — new modules (did not exist before)

| Path | Purpose |
|------|---------|
| `vibemeet-backend/src/modules/telegram-reward/*` | Telegram deep-link bind → `getChatMember` → atomic coin claim |
| `vibemeet-backend/src/modules/consumer-rewards/*` | Hub API, config Mongo, credit engine, domain hooks, recon, monitor, metrics |
| `vibemeet-backend/src/modules/checkin/*` | Daily check-in claim + FCM reminder job (independent of hub credit engine) |
| `vibemeet-backend/docs/REWARDS_LAUNCH.md` | Production runbook (env, recon, monitor, enable ladder) |

**`consumer-rewards/` file map (after hardening):**

| File | Role |
|------|------|
| `task-keys.ts` / `task-registry.ts` | Task metadata + default seeds |
| `consumer-reward.config.ts` | Env seed helpers + master `CONSUMER_REWARDS_ENABLED` |
| `consumer-reward-config.model.ts` | Mongo singleton config + **daily budget** + 60s cache |
| `user-reward-progress.model.ts` | Per-user claimed map + daily/lifetime counters |
| `credit-reward.service.ts` | Atomic once/daily credit + metrics + budget track |
| `hooks.ts` | Domain eligibility (photo, call, recharge, view, follow, referral…) |
| `hub.service.ts` | `GET /rewards/hub` + manual claim path |
| `consumer-reward.controller.ts` / `routes.ts` | User + admin HTTP |
| `reward-metrics.ts` | Metrics + Redis daily issuance counter |
| `reward-reconciliation.job.ts` | Nightly ledger vs wallet sample |
| `reward-monitor.service.ts` | Fraud/issuance aggregations |
| `consumer-rewards.contract.test.ts` | Hardening contract tests |

### 2.2 Backend — modified existing files

| File | Change |
|------|--------|
| `src/routes.ts` | Mounts rewards routes |
| `src/server.ts` | Starts check-in reminder + **reward reconciliation job** |
| `src/modules/admin/admin.routes.ts` | `telegram-reward`, `consumer-rewards`, **`rewards/monitor`**, **`rewards/recon`** |
| `src/modules/user/coin-transaction.model.ts` | New `source` enum values + compound indexes |
| `src/modules/user/user.model.ts` | Telegram fields; check-in-related if present |
| `src/modules/user/referral.service.ts` | Live Mongo referral amounts; invite hook; purchase double-credit guards |
| `src/modules/payment/payment.controller.ts` | Hook first recharge + continues referral-on-purchase |
| `src/modules/moments/controllers/moments.controller.ts` | View/like/follow hooks; **pass `accessReason`** |
| `src/modules/chat/chat.controller.ts` | First-message hook |
| `src/modules/billing/billing-session-finalization.service.ts` | First call + successful-referral-on-call hook |
| `src/modules/user/user.controller.ts` | Profile/avatar update → photo/complete profile |
| `src/modules/app-config/*` | Feature flags for telegram/consumer rewards |
| `src/config/feature-flags.ts` | Flag surface |
| `src/middlewares/rate-limit.middleware.ts` | Rewards rate limiters |
| `.env.example` | Documented env seeds / kill switches |
| `package.json` | Adds contract test path |

### 2.3 Admin (`vibemeet-admin`)

| File | Change |
|------|--------|
| `src/services/adminService.ts` | Telegram/consumer APIs; **monitor + recon types/methods**; budget fields |
| `src/pages/settings/SettingsPage.tsx` | Telegram panel; hub tasks table; **budget**; **readiness**; **Rewards monitor** section |

### 2.4 Flutter (`matchvibe-flutter`)

| Path | Purpose |
|------|---------|
| `lib/features/telegram_reward/*` | FAB + sheet + service/provider |
| `lib/features/rewards_hub/*` | Hub screen + service/provider |
| `lib/features/checkin/*` | Daily check-in popup/flow |
| App layout / account | FAB overlay; Account “Rewards” / check-in entry; app features flags |

---

## 3. Architecture — before vs after

### 3.1 Before (baseline economic touches)

```text
Payment verify ──► credit payment_gateway ──► processReferralRewardOnPurchase
                                                 (env coins, rewardGranted + $inc)

Call settlement ──► billing only (no consumer missions)

Moment view ──► analytics / access only

Profile update ──► save user (no photo bonus)

Telegram ──► none
```

### 3.2 After (full rewards + hardening)

```text
                    ┌─ creditOnce / creditDaily ──► CoinTransaction + User.coins
Domain events ──────┤                              │
                    │                              ├─► reward metrics
                    │                              └─► reward_coins_issued:{IST}
                    │
                    └─ progress ($addToSet / claimed map)

Admin PUT ──► ConsumerRewardConfig / TelegramRewardConfig (live)

Nightly ~01:30 IST ──► recon report ──► GET /admin/rewards/recon
Ledger aggregates   ──► GET /admin/rewards/monitor

Flutter: Hub | Telegram FAB | Daily Check-in (Account)
```

---

## 4. Domain-by-domain: before → after

### 4.1 First recharge reward

| | Before | After |
|--|--------|-------|
| **Behavior** | Any payment verify success could fire `first_recharge` if progress not claimed — **legacy rechargers earned bonus on “next” buy** | Credits only if completed `payment_gateway` **credit** count is **exactly 1** (true first purchase after finalize) |
| **Code** | Early hub: `tryCreditFirstRecharge` with progress check only | `countCompletedPaymentGatewayCredits(userId)`; `if (gatewayCount !== 1) return null` |
| **Wire** | `payment.controller.ts` after finalize `completed` → `onUserFirstRecharge` | Same wire; logic in hooks is gated |

**Transaction id (unchanged shape):** `first_recharge_reward_{userId}`

---

### 4.2 Watch free moments (daily)

| | Before | After |
|--|--------|-------|
| **Behavior** | Every recorded view (including paid/premium unlock paths if counted) incremented daily list → **farm via paid views** | Only free-tier access reasons: **`FREE`**, **`PREVIEW`**, **`VIP`** |
| **API call site** | `onMomentViewed(userId, momentId)` | `onMomentViewed(userId, momentId, access.reason)` |
| **Progress write** | Load doc → push array → `save()` (race-prone under parallel views) | Reset daily bucket if `dateKey ≠ today` via conditional update; **`$addToSet`** on `daily.viewedMomentIds` (cap via `$expr` size) |
| **Credit** | At threshold → daily txn `moment_watch_daily_reward_{userId}_{dateKey}` | Same id shape; credit engine + metrics/budget |

**Skip reasons:** `OWNER`, `CREATOR`, `PREMIUM`, `ADMIN`, `DENIED`, `VIP_ONLY`, etc.

---

### 4.3 Profile photo / complete profile

| | Before | After |
|--|--------|-------|
| **Photo eligibility** | Any avatar with `imageId` | `imageId` **and** moderation in `{approved, auto-ok, null/undefined}` — **reject `pending` / `rejected`** |
| **Complete profile** | Photo + username + age + gender | Same, but photo uses **approved** helper |
| **Stacking** | Photo then complete (e.g. 50 + 50) | Unchanged product stack |
| **Txn ids** | `profile_photo_reward_{userId}`, `profile_complete_reward_{userId}` | Same |

---

### 4.4 Successful referral (purchase vs call)

| | Before | After |
|--|--------|-------|
| **Purchase path** | `$set rewardGranted` + `$inc coins` + create `referral_reward_{referrer}_{referred}` from env coins | Same txn id; **early exit if txn already exists**; live coins/min from **Mongo successful_referral**; mark hub progress + metrics |
| **Call path** | Could grant again if `rewardGranted` race or dual engines | `tryCreditSuccessfulReferralOnCall`: skip if txn exists; claim `rewardGranted`; credit once via `creditOnceTaskReward` with **same txn id** |
| **Double wallet risk** | Real if both paths race without shared uniqueness | Reduced via **shared txn id + unique index** + **rewardGranted** mutual exclusion |

**Shared transaction id:**

```text
referral_reward_{referrerId}_{referredUserId}
```

---

### 4.5 Invite friend

| | Before | After |
|--|--------|-------|
| **Behavior** | No separate consumer invite coins (or only edge effects) | On referral attach: `invite_friend_reward_{referrer}_{referred}` via hook |
| **Role gate** | — | Referrer `role === 'user'` only |

---

### 4.6 First message / first video call

| | Before | After |
|--|--------|-------|
| **Message** | No reward | Hook in chat pre-send → `first_message_reward_{userId}` |
| **Call** | No consumer first-call reward | On settlement duration ≥ `minSeconds` → `first_video_call_reward_{userId}`; also triggers successful-referral-on-call for referrer |

---

### 4.7 Like moments / follow creators

| | Before | After |
|--|--------|-------|
| **Like** | None | Atomic daily `$addToSet` on `likedMomentIds` → daily credit |
| **Follow** | None | `$addToSet` `lifetime.followedCreatorIds` → once credit at target |

---

### 4.8 Telegram join reward

| | Before | After (shipped) | Hardening add-ons |
|--|--------|-----------------|-------------------|
| **Flow** | None | Signed link → webhook bind `telegramUserId` → client Verify → `getChatMember` → txn + wallet | Metrics: verify ok / not_joined / api_error; **budget track** on credit |
| **Idempotency** | — | Unique sparse `telegramUserId`; unique `telegram_join_reward_{userId}` | Contract tests: same payload ×10; same claim txn ×10 |
| **Config** | — | Mongo `TelegramRewardConfig` + env secrets | Admin channel URL validation remains strict (`t.me` / `telegram.me`) |

---

### 4.9 Daily check-in

| | Before | After |
|--|--------|-------|
| **Engine** | Separate module (not rewritten into hub) | Still separate: `/user/check-in/*`, IST txn ids, optional FCM reminder |
| **Hub coupling** | N/A | Not merged; listed on enable ladder first; recon includes `daily_checkin` source |

---

## 5. Credit engine — before vs after

### 5.1 Early engine (post-ship, pre-hardening)

- Mongo multi-doc transaction: create `CoinTransaction` → `$inc` user coins → mark progress
- Unique `transactionId` → duplicate key → `alreadyClaimed`
- Emit `coins_updated`; fire-and-forget `verifyUserBalance`
- No budget counter, no structured success/fail metrics

### 5.2 After hardening

Same transaction core **plus**:

| Addition | Where |
|----------|--------|
| `recordRewardCreditSuccess / Already / Fail` | `credit-reward.service.ts` |
| `trackRewardIssuance(coins)` Redis `reward_coins_issued:{istDateKey}` | After successful credit |
| Soft budget log + metric when total ≥ `dailyRewardBudgetCoins` | `reward-metrics.ts` (`alert_only` — **does not block**) |
| Hub latency metric | `getRewardsHubHandler` |

Telegram verify and referral purchase path also call metrics/budget helpers.

---

## 6. Admin & config — before vs after

### 6.1 Config shape

**Before (no hub):** Env-only referral coins, no Mongo consumer config.

**After config view:**

```ts
{
  enabled: boolean;
  tasks: { [taskKey]: { enabled, coins, minSeconds?, minPurchaseInr?, targetCount? } };
  dailyRewardBudgetCoins: number;   // default 500_000
  dailyBudgetMode: 'alert_only';
  updatedAt: string | null;
  readiness?: {
    botTokenSet, webhookSecretSet, botUsernameSet,
    telegramChannelConfigured, telegramRewardEnabled,
    consumerEnabled,
    mongoTxnNote   // replica-set requirement (no secrets)
  }
}
```

**Admin PUT validation (after):**

| Field | Bounds |
|-------|--------|
| coins | 0 … 100_000 |
| targetCount | 1 … 50 |
| minSeconds | 30 … 3600 |
| dailyRewardBudgetCoins | 0 … 100_000_000 |

### 6.2 Admin HTTP surface

| Method / path | Before | After |
|---------------|--------|-------|
| `GET/PUT /admin/telegram-reward` | Missing | Live |
| `GET/PUT /admin/consumer-rewards` | Missing → basic | + readiness, budget |
| `GET /admin/rewards/monitor?range=today\|7d` | Missing | Fraud/issuance widgets |
| `GET /admin/rewards/recon[?run=1]` | Missing | Latest / force recon |

### 6.3 Admin UI (Settings)

| Before | After |
|--------|-------|
| Pricing / commission only (rewards absent) | Telegram section + Hub task table + **budget** + readiness mono lines + **Rewards monitor** (range toggle, top earners, by-source table, softAlerts, run recon) |

---

## 7. Indexes & race safety

| Concern | Before | After |
|---------|--------|-------|
| Txn idempotency | `transactionId` unique | Unchanged (relied on everywhere) |
| First-recharge lookup | Full scan possible | `{ userId, source, type, status }` |
| Recon / monitor | N/A | `{ source, status, type, createdAt }` |
| Daily progress race | `save()` overwrites | `$addToSet` + dateKey reset |
| Config thrash | Short/no cache or 15s | **60s TTL** cache (`invalidate` on PUT) |

---

## 8. Observability jobs

### 8.1 Nightly recon

| Item | Detail |
|------|--------|
| **Start** | `server.ts` → `startRewardReconciliationJob()` (api hygiene role) |
| **Window** | ~01:30–01:40 IST |
| **Day** | Previous IST day (`istYesterdayKey`) |
| **Ledger** | Sum completed credit txn for `REWARD_LEDGER_SOURCES` |
| **Sample** | Up to 500 earner userIds via existing `verifyUserBalance` |
| **Output** | In-memory latest report + log; admin `GET /rewards/recon` |
| **Alert** | `logError` + metric if mismatches |

### 8.2 Monitor widgets

IST `today` or last `7d`:

- Coins issued, counts by source  
- Top earners, top referrers  
- Soft alerts (e.g. telegram > 2000, top earner > 50k, budget ≥ 100%)  
- Redis issuance counter when available  

---

## 9. API surface (user-facing)

| Endpoint | Before | After |
|----------|--------|-------|
| `GET /api/v1/rewards/hub` | — | Task list + progress + balance |
| `POST /api/v1/rewards/tasks/:key/claim` | — | Manual claims (profile/follow/daily) |
| `GET/POST …/rewards/telegram/*` | — | status, link token, verify, webhook |
| Daily check-in routes | Separate check-in module | Unchanged family |

All reward credits remain **`role === 'user'`** only.

---

## 10. CoinTransaction `source` values (ledger)

**Added for rewards stack:**

| source | Task / origin |
|--------|----------------|
| `telegram_join_reward` | Telegram claim |
| `profile_photo_reward` | Photo |
| `profile_complete_reward` | Complete profile |
| `first_video_call_reward` | First call |
| `first_message_reward` | First chat message |
| `invite_friend_reward` | Invite attach |
| `referral_reward` | Successful referral (purchase or call) |
| `first_recharge_reward` | True first purchase |
| `moment_watch_daily_reward` | Daily watch |
| `moment_like_daily_reward` | Daily like |
| `follow_creators_reward` | Follow N creators |
| `daily_checkin` | Daily check-in (pre-existing family, included in recon) |

---

## 11. Flutter / client — before vs after

| Surface | Before | After |
|---------|--------|-------|
| Home | No telegram reward FAB | Floating Telegram FAB (when feature + not claimed) |
| Account | No Rewards row | Entry to Rewards Hub (feature-gated) |
| Check-in | Feature-flagged popup/flow | Independent of hub claim path |
| Flags | N/A | App config: `telegramRewardEnabled`, `consumerRewardsEnabled`, check-in |

Client **does not** invent coin math; backend is source of truth.

---

## 12. Tests — before vs after

| Before | After |
|--------|-------|
| No consumer-rewards contract suite | `consumer-rewards.contract.test.ts` wired in `package.json` `test` script |

**Covered behaviors (contract/unit style):**

1. Free-tier access reason gate  
2. Avatar moderation gate  
3. First-recharge count rule (documented equality to 1)  
4. Stable once-task / referral / telegram txn ids  
5. IST midnight dateKey boundaries (23:59:59 / 00:00:00 / 00:00:01 IST)  
6. Telegram payload verify ×10 same userId  
7. Telegram claim txn id stable under 10× generation  
8. Purchase/call share identical referral txn id  
9. Recon window detection ~01:30 IST  
10. Reward source list completeness  

Full DB integration for concurrent double-claim remains best exercised in staging (transactions need replica set).

---

## 13. Kill switches & rollout ladder

### Before

Ad-hoc env flags only, no documented phased enable.

### After (ops)

| Switch | Effect |
|--------|--------|
| `CONSUMER_REWARDS_ENABLED=false` | Master off (hub credits) |
| Mongo `ConsumerRewardConfig.enabled` + per-task `enabled` | Fine control without redeploy |
| Mongo Telegram `enabled` + bot env | Telegram off |
| `DAILY_CHECKIN_ENABLED` | Check-in off |

**Production enable order (financial last):**

```text
1. Daily Check-in
2. Photo / Complete profile
3. Watch / Like / Follow
4. Telegram join
5. First video call
6. First recharge
7. Referral (invite + successful)
```

Rollback at any step: flip task `enabled=false`. Nightly recon stays on.

Full procedure: [`docs/REWARDS_LAUNCH.md`](./REWARDS_LAUNCH.md).

---

## 14. Risk matrix — mitigated vs remaining

| Risk | Pre-hardening | Post-hardening |
|------|---------------|----------------|
| Legacy recharger free bonus | Open | Closed (`gatewayCount === 1`) |
| Paid moment farm daily 30 | Open | Closed (free-tier reasons only) |
| Referral dual-path double pay | High | Mitigated (txn + `rewardGranted`) |
| Pending avatar still rewarded | Open | Closed (moderation gate) |
| Parallel view race overcounting | Medium | Mitigated (`$addToSet`) |
| Silent multi-day wallet drift | Undetected | Nightly recon + sample `verifyUserBalance` |
| Coin issuance explosion | Undetected | Soft budget alert (no hard stop) |
| Exploit farming | Blind | Top earners / softAlerts (no auto-ban) |
| Budget hard stop / clawbacks | Out of scope | Still out of scope |

---

## 15. Quick “diff checklist” for reviewers

Backend correctness:

- [ ] `hooks.ts` — first recharge count, free view, avatar, atomic daily, referral txn pre-check  
- [ ] `moments.controller.ts` — passes `access.reason`  
- [ ] `referral.service.ts` — existing txn short-circuit; metrics/progress  
- [ ] `credit-reward.service.ts` — metrics + budget  
- [ ] Indexes in `coin-transaction.model.ts`  
- [ ] Admin controller validation + readiness  
- [ ] `server.ts` recon job start  

Admin:

- [ ] Settings monitor + budget + readiness  
- [ ] adminService types/methods  

Docs / tests:

- [ ] `docs/REWARDS_LAUNCH.md`  
- [ ] `consumer-rewards.contract.test.ts`  

Do **not** treat this doc as a replace for git history — use `git diff` / PR for line-level review.

---

## 16. File index (hardest files to re-read)

```text
vibemeet-backend/
  docs/REWARDS_LAUNCH.md
  src/modules/consumer-rewards/
    hooks.ts
    credit-reward.service.ts
    consumer-reward-config.model.ts
    reward-metrics.ts
    reward-reconciliation.job.ts
    reward-monitor.service.ts
    consumer-reward.controller.ts
    hub.service.ts
    consumer-rewards.contract.test.ts
  src/modules/telegram-reward/
  src/modules/user/referral.service.ts
  src/modules/moments/controllers/moments.controller.ts
  src/modules/payment/payment.controller.ts
  src/server.ts
  src/modules/admin/admin.routes.ts

vibemeet-admin/
  src/pages/settings/SettingsPage.tsx
  src/services/adminService.ts

matchvibe-flutter/
  lib/features/telegram_reward/
  lib/features/rewards_hub/
  lib/features/checkin/
```

---

## 17. One-line verdict

**Before:** limited referral purchase bonus and ad-hoc wallet credits.  
**After (baseline ship):** full consumer rewards product (hub + telegram + check-in) with unique ledger ids.  
**After (hardening v2):** production-ready controls — true first recharge, free-view filter, referral single-pay, avatar moderation, atomic daily counters, metrics, soft budget, fraud monitor, nightly recon, staged rollout docs and tests.

---

*Generated from codebase analysis of the MatchVibe rewards stack and Deployment Readiness plan v2. Plan file itself was not modified.*
