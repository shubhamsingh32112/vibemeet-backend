# Video billing: step-by-step execution traces (code-derived)

This document traces **actual** backend behavior from the codebase. Constants and formulas reference:

- [`billing.constants.ts`](../src/modules/billing/billing.constants.ts) — `COIN_MICROS`, tick interval, caps, locks  
- [`pricing.service.ts`](../src/modules/video/pricing.service.ts) — `pricePerSecondMicros`, `creatorEarningsPerSecondMicros`  
- [`pricing.config.ts`](../src/config/pricing.config.ts) — `MIN_COINS_TO_CALL`, `CREATOR_SHARE_PERCENTAGE`, duration defaults  
- [`billing.service.ts`](../src/modules/billing/billing.service.ts) — `startBillingSession`, `_processBillingCycleInternal`  
- [`billing.queue.ts`](../src/modules/billing/billing.queue.ts) — BullMQ worker, `scheduleBillingJob`, backpressure  
- [`billing-settlement.service.ts`](../src/modules/billing/billing-settlement.service.ts) — `settleCall`, Mongo writes  
- [`billing-termination.service.ts`](../src/modules/billing/billing-termination.service.ts) — `forceTerminateCall`  
- [`billing-termination.state.ts`](../src/modules/billing/billing-termination.state.ts) — lease + `call:ended:` marker  
- [`billing-termination.stream.ts`](../src/modules/billing/billing-termination.stream.ts) — Stream `mark_ended` HTTP  
- [`call-lifecycle.service.ts`](../src/modules/video/call-lifecycle.service.ts) — `call.session_started` → `handleCallStartedHttp`, `call.session_ended` → `settleCallHttp`  
- [`billing.gateway.ts`](../src/modules/billing/billing.gateway.ts) — HTTP billing entry, pending end deferral  

**Driver note:** `BILLING_DRIVER=bullmq` selects BullMQ delayed jobs; otherwise the ZSET + `setInterval` batch path runs ([`billing-batch.processor.ts`](../src/modules/billing/billing-batch.processor.ts)). Traces below call out differences where they matter.

---

## Global reference: pricing and hot-path math

### Integer micro-coins

- `COIN_MICROS = 1_000_000` (one display “coin”).

### Creator list price → per-second micro rates

From [`pricing.service.ts`](../src/modules/video/pricing.service.ts) + [`billing.constants.ts`](../src/modules/billing/billing.constants.ts):

- **User charge:**  
  `pricePerSecondMicros = floor((round(pricePerMinute * COIN_MICROS)) / 60)`  
  ([`pricePerMinuteToUserMicrosPerSecond`](../src/modules/billing/billing.constants.ts))

- **Creator earn:**  
  `creatorEarningsPerSecondMicros = floor((round(pricePerMinute * CREATOR_SHARE_PERCENTAGE * COIN_MICROS)) / 60)`  
  ([`pricePerMinuteToCreatorMicrosPerSecond`](../src/modules/billing/billing.constants.ts))

Default `CREATOR_SHARE_PERCENTAGE = 0.25` ([`pricing.config.ts`](../src/config/pricing.config.ts)).

### Scenario baseline numbers (creator `price` = 60 coins/min)

- `pricePerMinute = 60`
- `pricePerSecondMicros = floor(60 * 1_000_000 / 60) = 1_000_000` micros per second of **billed** time (≈ 1 coin/s).
- `creatorEarningsPerSecondMicros = floor(60 * 0.25 * 1_000_000 / 60) = 250_000` micros per second of **billed** time (≈ 0.25 coin/s).

User wallet at session start: Mongo `user.coins = 60` → `balanceMicros = 60 * COIN_MICROS = 60_000_000`.

### Tick interval and caps

- `BILLING_PROCESS_INTERVAL_MS = 300` — nominal delay between **scheduled** cycles (ZSET score step / BullMQ delay baseline).
- `MAX_BILLING_DELTA_MS` — default **5000** ms per cycle (env-clamped 500–60000); wall lag beyond this is **split across ticks** ([`billing.constants.ts`](../src/modules/billing/billing.constants.ts)).
- `MIN_BILLING_DELTA_MS = 50` — shorter deltas return `tick_ok` without charging ([`billing.service.ts`](../src/modules/billing/billing.service.ts)).
- Per-tick deduction ([`billing.service.ts`](../src/modules/billing/billing.service.ts)):
  - `rawWallLagMs = now - session.lastProcessedAt` (metrics: `billing_wall_lag_ms`; if `rawWallLagMs > MAX_BILLING_DELTA_MS`, metric `billing_delta_capped`).
  - `deltaMs = min(rawWallLagMs, MAX_BILLING_DELTA_MS)`.
  - `potentialDeduct = floor((deltaMs * pricePerSecondMicros) / 1000)`.
  - `actualDeduct = min(potentialDeduct, balanceMicros)`.
  - `timeCoveredMs = floor((actualDeduct * 1000) / pricePerSecondMicros)`.
  - `earnMicros = floor((timeCoveredMs * creatorEarningsPerSecondMicros) / 1000)`.
  - Session: `lastProcessedAt += timeCoveredMs`, `totalDeductedMicros += actualDeduct`, `totalEarnedMicros += earnMicros`.
  - `elapsedSeconds = floor(totalDeductedMicros / pricePerSecondMicros)` (derived from **deducted** micros, not raw wall clock).

### Call start gates ([`startBillingSession`](../src/modules/billing/billing.service.ts))

1. **Idempotency:** if `call:session:{callId}` exists → return (metric `session_start_duplicate`).
2. **Active slots:** `tryReserveActiveCallSlots` — `SET active:call:user:{uid} NX` for caller and creator to `callId` (TTL `ACTIVE_CALL_BY_USER_TTL` = 7200s). Conflict → emit `billing:error` `ACTIVE_CALL_CONFLICT`, return.
3. **Mongo:** load `User`, `Creator`; `pricingService.snapshotForCreator`.
4. **Balance:** `balanceMicros = coinsWholeToMicros(user.coins)`. Must satisfy  
   `balanceMicros >= max(pricePerSecondMicros, minEntryMicros)` where `minEntryMicros = coinsWholeToMicros(MIN_COINS_TO_CALL)` and default `MIN_COINS_TO_CALL = 10` ([`pricing.config.ts`](../src/config/pricing.config.ts)).  
   So the **minimum entry** is **10 whole coins** unless `pricePerSecondMicros` exceeds that in micros (expensive rates).
5. **Redis session keys:** `call:session:{callId}`, `call:user_coins:{callId}`, `call:creator_earnings:{callId}` (TTL 7200s in service).
6. **Scheduler registration:**
   - **BullMQ:** `scheduleBillingJob(callId, BILLING_PROCESS_INTERVAL_MS)` — queue `billing-cycle`, job name `cycle`, **`jobId = billing-cycle:${callId}`**, `delay = 300` ms ([`billing.queue.ts`](../src/modules/billing/billing.queue.ts)).
   - **ZSET:** `ZADD billing:active_calls score=now+300 member=callId`.

### Primary lifecycle wiring (Stream webhooks)

- **`call.session_started`** ([`call-lifecycle.service.ts`](../src/modules/video/call-lifecycle.service.ts)): if no existing `call:session:{callId}`, loads caller/creator, then **`handleCallStartedHttp`** ([`billing.gateway.ts`](../src/modules/billing/billing.gateway.ts)) → `billingService.startBillingSession`.  
  If `pending:call:ends:{callId}` exists (HTTP end raced start), it deletes it and **`settleCall`** immediately after start (deferred settlement path).
- **`call.session_ended`**: **`settleCallHttp`** → if `isCallActive` → **`settleCall`**; else sets **`pending:call:ends:{callId}`** with short TTL so a later start can settle ([`billing.gateway.ts`](../src/modules/billing/billing.gateway.ts)).

### Termination + Stream

- **`forceTerminateCall`** ([`billing-termination.service.ts`](../src/modules/billing/billing-termination.service.ts)):
  1. Emits Socket.IO `call:force-end` to user and creator rooms.
  2. If `BILLING_SERVER_FORCE_END_ENABLED === 'false'` → stop (default is enabled unless set false).
  3. If Redis `call:ended:{callId}` exists (`hasCallEndedMarker`) → dedupe.
  4. `tryAcquireMarkEndedLease(callId)` — NX key `billing:mark_ended_lease:{callId}` (TTL default 120s, env `BILLING_MARK_ENDED_LEASE_TTL_SECONDS`). Failure → dedupe metric.
  5. `markStreamCallEnded` — POST Stream Video `.../mark_ended` ([`billing-termination.stream.ts`](../src/modules/billing/billing-termination.stream.ts)).
  6. On success: `setCallEndedMarker` (`call:ended:{callId}`), `releaseMarkEndedLease`.
  7. On failure: `releaseMarkEndedLease`; if `BILLING_DRIVER=bullmq` → **`enqueueTerminationRetryJob`**; else **`enqueueTerminationRedisRetry`** (ZSET + payload, processed in reconciliation) ([`billing-termination-redis-retry.ts`](../src/modules/billing/billing-termination-redis-retry.ts)).

### Settlement ([`settleCall`](../src/modules/billing/billing-settlement.service.ts))

Order:

1. `removeCallFromBilling` — `ZREM billing:active_calls` (no-op for pure BullMQ scheduling; harmless).
2. Idempotency: `settled:call:{callId}` short-circuit; `settle:lock:{callId}` NX.
3. Read session + `call:user_coins` + `call:creator_earnings`.
4. **User Mongo balance** set to `user.coins = max(0, microsToWholeCoinsFloor(balanceMicros))` — **floor** of remaining Redis micros.
5. **Debit transaction amount:** `totalDeducted = microsToUserDebitWholeCoins(session.totalDeductedMicros)` — **ceil** of deducted micros to whole coins ([`microsToUserDebitWholeCoins`](../src/modules/billing/billing.constants.ts)).
6. **Creator credit:** `totalEarnedCreator = microsToCreatorCreditWholeCoins(earningsMicros)` — **floor**.
7. Transaction commits; then **`deleteBillingSessionRedisKeys`** (session, coins, earnings, both `active:call:user:*`).

**Important:** Billed duration in history uses `session.elapsedSeconds` (from deducted micros). `wallClockSeconds` is logged but **not** used as the monetary authority.

---

# Scenario 1 — User 60 coins, creator 60 coins/min, call duration **1 minute** (wall-clock)

**Assumptions for a closed trace:** Stream fires `session_started` once; user and creator stay connected ~60s; `session_ended` fires after; billing keeps up (no 5s+ processor stalls); defaults `effectiveDurationLimitSeconds` ≥ 60 (e.g. min(1800, 1800, 3600) from [`billing.service.ts`](../src/modules/billing/billing.service.ts) unless overridden in DB).

## 1) Call initiation flow

| Step | What runs | Redis / IO |
|------|-----------|------------|
| A | Stream webhook `call.session_started` → `handleCallStartedHttp` | — |
| B | `startBillingSession`: no prior `call:session:{callId}` | — |
| C | `tryReserveActiveCallSlots` | `SET NX` `active:call:user:{callerUid}` = `callId`, same for creator |
| D | Balance check: `60_000_000 >= max(1_000_000, 10_000_000)` → **true** | — |
| E | Session written | `call:session:{callId}`, `call:user_coins:{callId}` = `60000000`, `call:creator_earnings:{callId}` = `0` |
| F | BullMQ: `scheduleBillingJob` → jobId `billing-cycle:{callId}`, delay **300ms**. ZSET: score `startTime+300`. | Queue delayed job / ZSET |
| G | Socket emits `billing:started` with `maxSeconds = floor(60_000_000 / 1_000_000) = 60` | — |

**APIs:** Billing start is **not** a dedicated REST “start billing” route in the snippets above; it is **`handleCallStartedHttp` from the Stream `session_started` path** ([`call-lifecycle.service.ts`](../src/modules/video/call-lifecycle.service.ts)). Clients use `/video/token`, etc.; webhook is authoritative for this trace.

## 2) Billing over time

- **Nominal tick cadence:** next cycle **~300ms** after each successful chain (BullMQ `scheduleNextBillingCycleAfterTickOk` / ZSET `zadd` with `lastProcessedAt + 300` in batch path — see [`billing-batch.processor.ts`](../src/modules/billing/billing-batch.processor.ts)).
- **Charge per cycle:** with ~300ms lag and no cap split, `deltaMs ≈ 300`, `potentialDeduct = floor(300 * 1_000_000 / 1000) = 300_000` micros ≈ **0.3 coin** per tick while balance allows.
- Over **~200** such ticks (60s / 0.3s), **total deducted micros** approaches `60 * COIN_MICROS` subject to **integer flooring** on each `potentialDeduct` and the final “cannot afford full chunk” behavior.
- **Creator earnings:** each tick adds `earnMicros` proportional to `timeCoveredMs` at **300k micros/s**.

**When balance runs low:** On a tick, if after deduction `balanceMicros < pricePerSecondMicros` (1_000_000), code schedules **`forceTerminateCall`** with `insufficient_coins` and returns **`stop_needs_settlement`** ([`billing.service.ts`](../src/modules/billing/billing.service.ts)). Worker then **`settleCall`** (BullMQ branch).

For a **full 60s** of successful ticks at ~1 coin/s, Redis `totalDeductedMicros` ≈ 60e6; remaining `balanceMicros` ≈ 0.

## 3) Queue + worker (BullMQ)

- **JobId:** `billing-cycle:{callId}` — stable id; repeated `add` updates the same logical job in BullMQ ([`scheduleBillingJob`](../src/modules/billing/billing.queue.ts)).
- **Retry on throw:** worker catches, if session exists, reschedules with delay `computeNextCycleDelayMs(queueLagMs, callId, 600)` (2× base interval) ([`billing.queue.ts`](../src/modules/billing/billing.queue.ts)).
- **Backpressure:** if `queueLagMs > BILLING_BACKPRESSURE_LAG_MS` (default 5000) **and** call is in rollout cohort, next delay may increase (factor/cap envs) — **longer gaps between ticks** for that call; billing math still uses **wall lag** per tick, so revenue vs wall-clock behavior follows `MAX_BILLING_DELTA_MS` splitting (see global reference).

## 4) Termination

- For a **clean 60s call** that ends via Stream **`session_ended`** without hitting zero coins first: **`forceTerminateCall` may not run**; settlement is driven by **`settleCallHttp` → `settleCall`**.
- If **`mark_ended`** were invoked (e.g. client hangup path), lease + `call:ended:{callId}` prevent duplicate Stream posts.

## 5) Edge cases

- **Stream `session_ended` before Redis session written:** `settleCallHttp` may set **`pending:call:ends`**; next **`handleCallStartedHttp`** flushes settlement ([`billing.gateway.ts`](../src/modules/billing/billing.gateway.ts)).
- **`settleCall` with no session:** warns, releases lock; may mark idempotent via CallHistory if already written.

## 6) Final state

| Layer | State |
|-------|--------|
| Redis | Session keys **deleted** after successful Mongo commit; `settled:call:{callId}` set |
| User Mongo | `user.coins = floor(remaining micros / COIN_MICROS)` ≈ **0** if fully depleted in Redis |
| CoinTransaction debit | `coins = ceil(totalDeductedMicros / COIN_MICROS)` — **up to 1 whole coin** above strict floor of micros |
| Creator | `coins += floor(earningsMicros / COIN_MICROS)` (credit floored) |
| CallHistory | `durationSeconds = session.elapsedSeconds` (from **deducted** basis) |

**Inconsistency possibility:** **ceil** on user debit vs **floor** on remaining balance can produce **off-by-one coin** vs naive “60 − 60” expectations when micro dust exists; this is **platform-favorable** on debit per code comments ([`billing.constants.ts`](../src/modules/billing/billing.constants.ts)).

## 7) Scalability + correctness

| Concern | Verdict |
|---------|---------|
| Overcharge | Unlikely; deduction capped by `balanceMicros` each tick |
| Undercharge | Possible **micro dust**; wall clock **>** billed time if ticks lag and call ends before backlog drains (`MAX_BILLING_DELTA_MS` split + settlement uses session, not wall-only true-up) |
| Stuck call | Mitigated by BullMQ reschedule / DLQ / stale watchdog (recent remediation); outside this doc’s line range |

**Verdict:** ✅ **Correct** for nominal 1 min / 60 coins / 60 cpm **assuming** webhook settlement runs; ⚠️ **rounding / wall-vs-billed** edge cases as above.

---

# Scenario 2 — Same wallet, call duration **5 minutes** (wall-clock intent)

User still only has **60 coins** at **60 cpm** (~1 coin/s **affordable** billed time).

## Chronological trace

1. **Start:** same as Scenario 1 — `maxSeconds = 60` in `billing:started` (informational).
2. **Billing ticks:** accumulate `totalDeductedMicros` until balance can no longer cover the next second-equivalent.
3. **~After ~60s of billed time** (subject to tick quantization): `balanceMicros` falls below `pricePerSecondMicros` → **`forceTerminateCall`** (`insufficient_coins`) + **`stop_needs_settlement`** on that tick ([`billing.service.ts`](../src/modules/billing/billing.service.ts)).
4. **Worker:** `settleCall` runs for that stop path.
5. **Actual media:** If Stream still shows the room until `mark_ended` succeeds, user may experience **extra wall time** after balance exhaustion — **not billed** beyond Redis session state (session stops advancing when no deduction occurs and termination settles).

If the **user stays connected 5 minutes** but server force-ends at ~60s billed time:

- **Billed duration (`elapsedSeconds`)** ≈ **60** (from micros / rate), not 300.
- **Wall clock 300s** is **not** the billing authority.

## Redis / queue

- Same as Scenario 1 until termination; then chain stops (`stop_needs_settlement` → settle; BullMQ does not schedule next tick after settle from worker).

## Final state

- User Mongo: ~**0** coins (floor of remainder).
- Creator: ~**floor(0.3 * 60)** = **18 coins** credit (60 × 0.30) subject to **per-tick flooring** of `earnMicros` (small drift possible).

**Verdict:** ✅ **Correct** relative to **coins**, not requested wall duration; ⚠️ **UX / expectation mismatch** if product promises “5 minutes” regardless of balance.

---

# Scenario 3 — Call duration **10 minutes**

Same economics as Scenario 2. Billing stops when **wallet micros** cannot support the rate; **`elapsedSeconds`** plateaus at ~**60**. No additional charges after depletion unless a **bug replayed** ticks (mitigated by locks + idempotent settlement checks).

**Verdict:** ✅ same as Scenario 2.

---

# Scenario 4 — Call duration **15 minutes**

Same as Scenarios 2–3.

**Additional limit:** If per-user/per-creator **`effectiveDurationLimitSeconds`** (min of limits, max 3600) is **below** wall intent, **`duration_limit_reached`** path fires **`forceTerminateCall`** when `session.elapsedSeconds >= effectiveLimit` ([`billing.service.ts`](../src/modules/billing/billing.service.ts)). With defaults **1800s**, a **15 min** call does **not** hit that limit; a **60 min** wall call could.

**Verdict:** ✅ for coin exhaustion; ⚠️ duration limit is a separate axis from coin exhaustion.

---

# Scenario 5 — User **60 coins**, creator **90 coins/min**

## Pricing math

- `pricePerMinute = 90`
- `pricePerSecondMicros = floor(90 * 1_000_000 / 60) = 1_500_000` (1.5 coin/s).
- `creatorEarningsPerSecondMicros = floor(90 * 0.30 * 1_000_000 / 60) = 450_000`.

## Allowed to start?

Start condition:  
`balanceMicros >= max(pricePerSecondMicros, minEntryMicros)`  
`max(1_500_000, 10_000_000) = 10_000_000` → user needs **≥ 10 coins**.  
**60 coins → start allowed.**

## Immediately after connect (`billing:started`)

- `maxSeconds = floor(60_000_000 / 1_500_000) = 40` seconds of **full-rate** affordability at list price.
- Ticks begin 300ms later (BullMQ/ZSET).

## If call runs until broke

- Billed wall ~**40s** of full-rate ticks (quantized), then insufficient path → **`forceTerminateCall`** + settlement.

**Verdict:** ✅ **Correct** per code; ⚠️ **`maxSeconds` is informational** — actual stop is tick + termination + settlement.

---

# Scenario 6 — **50** users × **50** creators (1:1), simultaneous

## Call initiation

- Each pair gets distinct **`callId`** → distinct Redis session keys and **distinct** `active:call:user:*` keys (caller + creator per call).
- **`tryReserveActiveCallSlots`** prevents the **same** Firebase UID from holding two **different** `callId`s at once **if** both try to start second sessions — **second start gets `ACTIVE_CALL_CONFLICT`** ([`billing.service.ts`](../src/modules/billing/billing.service.ts)).

## Queue behavior (BullMQ)

- **50** delayed jobs with **distinct** `jobId = billing-cycle:{callId}` → no cross-call deduplication conflict.
- Worker concurrency default **`BILLING_BULLMQ_CONCURRENCY`** = **50** ([`billing.queue.ts`](../src/modules/billing/billing.queue.ts)) — up to 50 parallel `processBillingTick` executions **subject to** per-call **`billing:cycle_lock:{callId}`** NX ([`billing.service.ts`](../src/modules/billing/billing.service.ts)): duplicate tick for same call is rejected → returns **`tick_ok`** without double charge.

## Redis contention

- **Hot keys:** 50 sessions + 50 user coin keys + 50 locks; **different keys** → low direct contention.
- **Same Redis** used for BullMQ — standard queue load.

## Billing accuracy

- **Per-call isolation:** balances in `call:user_coins:{callId}` — no shared purse across calls **unless** same user opens two calls (blocked by slot reservation for same UID).

## Failure scenarios

- **Tick throws (Redis):** retry with backoff → DLQ → reconciliation; BullMQ worker reschedules if session exists ([`billing.queue.ts`](../src/modules/billing/billing.queue.ts), [`billing-reconciliation.ts`](../src/modules/billing/billing-reconciliation.ts)).
- **Termination Stream failure:** BullMQ termination retry queue **or** Redis ZSET retry path when not BullMQ ([`billing-termination.service.ts`](../src/modules/billing/billing-termination.service.ts)).

**Verdict:** ✅ **Mostly correct** under load for **distinct users**; ⚠️ **total Redis + BullMQ throughput** must be sized; ⚠️ **multi-tab same user** second call **rejected** by design (`ACTIVE_CALL_CONFLICT`).

---

## Cross-scenario risks (critical review)

| Risk | Mechanism in code | Severity |
|------|-------------------|----------|
| Wall clock > billed time at hangup | Settlement uses **`session.totalDeductedMicros` / `elapsedSeconds`**, not `Date.now()-startTime` as charge base | ⚠️ Economic gap under lag |
| User debit ceil vs balance floor | [`microsToUserDebitWholeCoins`](../src/modules/billing/billing.constants.ts) vs [`microsToWholeCoinsFloor`](../src/modules/billing/billing.constants.ts) on remaining | ⚠️ Small rounding drift |
| `removeCallFromBilling` before read | [`settleCall`](../src/modules/billing/billing-settlement.service.ts) ZREM first — BullMQ doesn’t rely on ZSET; OK | ✅ |
| Legacy webhook billing | **Removed** (`video.legacy.webhook.ts` deleted). Only [`video.webhook.ts`](../src/modules/video/video.webhook.ts) → `CallLifecycleService` + Redis billing is wired; [`video.webhook.routes.contract.test.ts`](../src/modules/video/video.webhook.routes.contract.test.ts) guards against reintroducing the legacy import. |

---

## Scenario verdicts (summary table)

| # | Verdict |
|---|---------|
| 1 | ✅ **Correct** for billed 60s / 60 coins at 60 cpm (± rounding); ⚠️ micro/ceil-floor |
| 2 | ✅ **Correct** coin depletion ~60s; ⚠️ not 5 min billed |
| 3 | ✅ same |
| 4 | ✅ same + note duration limit env |
| 5 | ✅ start + `maxSeconds=40`; ⚠️ informational |
| 6 | ✅ isolated calls; ⚠️ ops scaling + same-user conflict |

---

*Generated from repository state: backend `billing`, `video`, `config` modules. If deployment enables different env vars (`MAX_BILLING_DELTA_MS`, `BILLING_DRIVER`, `MIN_COINS_TO_CALL`, creator share), recompute numeric traces accordingly.*
