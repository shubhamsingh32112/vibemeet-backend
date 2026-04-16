# Video call billing — deep execution trace (backend)

This document is a **step-by-step, code-grounded** trace of the backend billing stack: initiation, Redis, ticks, queues, Stream termination, settlement, and reconciliation. It applies the **actual** control flow in this repository—not idealized behavior.

**Primary sources:**  
`billing.service.ts`, `billing-socket.gateway.ts`, `billing.gateway.ts`, `billing.routes.ts`, `billing-settlement.service.ts`, `billing-batch.processor.ts`, `billing.queue.ts`, `billing-reconciliation.ts`, `billing-termination.*`, `billing-active-call.service.ts`, `billing.constants.ts`, `pricing.service.ts`, `pricing.config.ts`, `call-lifecycle.service.ts`, `config/redis.ts`, `billing-driver.ts`.

**Environment toggles that change behavior:**

| Variable | Effect |
|----------|--------|
| `BILLING_DRIVER=bullmq` | Billing cycles run via **BullMQ** (`billing-cycle` queue + worker). Otherwise **`setInterval` + Redis ZSET** `billing:active_calls`. |
| `BILLING_TERMINATION_RETRY_ENABLED` | Termination retry queue (default enabled unless `false`). **Still requires BullMQ** for enqueue—see §Termination. |
| `BILLING_SERVER_FORCE_END_ENABLED` | If `false`, `call:force-end` is emitted but **Stream `mark_ended` is skipped** (clients may keep media up). |

---

## Shared mechanics (all scenarios)

### A. Rate snapshot (at `startBillingSession`)

From `pricing.service.ts` + `billing.constants.ts`:

- `pricePerMinute` = `creator.price` (Mongo `Creator`).
- `pricePerSecondMicros = floor((round(pricePerMinute × COIN_MICROS)) / 60)` where `COIN_MICROS = 1_000_000`.
- Creator side: `creatorEarningsPerSecondMicros = floor((round(pricePerMinute × CREATOR_SHARE_PERCENTAGE × COIN_MICROS)) / 60)` with default `CREATOR_SHARE_PERCENTAGE = 0.30` from `pricing.config.ts`.

**Numeric examples used below (defaults, integer coin balances):**

| Creator `price` (coins/min) | `pricePerSecondMicros` | User cost/sec (display) | Creator micros/sec | Creator coins/sec (display) |
|----------------------------|-------------------------|-------------------------|--------------------|-----------------------------|
| 60 | `floor(60×1e6/60) = 1_000_000` | 1 coin/s | `floor(18×1e6/60) = 300_000` | 0.3 |
| 90 | `floor(90×1e6/60) = 1_500_000` | 1.5 coins/s | `floor(27×1e6/60) = 450_000` | 0.45 |

### B. Entry gate (`startBillingSession`)

From `billing.service.ts` (~241–261):

- Load payer `User` by Firebase UID; load `Creator` by `creatorMongoId` (`Creator.findById` or `findOne({ userId })`).
- `balanceMicros = coinsWholeToMicros(user.coins)` → `round(user.coins × COIN_MICROS)`.
- **Reject billing session** (emit `forceTerminateCall`, reasons `min_coins_not_met` or `insufficient_coins`) if:

  `balanceMicros < max(pricePerSecondMicros, coinsWholeToMicros(MIN_COINS_TO_CALL))`

  Default `MIN_COINS_TO_CALL = 10` → `minEntryMicros = 10_000_000`.

  So the user must have **at least 10 whole coins** *and* enough micros to cover **one second** at the creator rate (whichever maximum applies).

- **No explicit “only one active call per user” check** inside `startBillingSession`. Overlap is constrained elsewhere (product/Stream); Redis still sets `active:call:user:{firebaseUid}` → `callId` with TTL 7200s, so **last writer wins** if two sessions were ever started for the same Firebase UID.

### C. Redis keys written at session start

On success, `billing.service.ts` (~297–302, 361–374):

| Key | Purpose |
|-----|---------|
| `call:session:{callId}` | JSON `CallSession` (schema v2): rates, `startTime`, `lastProcessedAt`, `elapsedSeconds`, `totalDeductedMicros`, `effectiveDurationLimitSeconds`, etc. |
| `call:user_coins:{callId}` | **String** of **integer micro-coins** (balance mirror for this call). |
| `call:creator_earnings:{callId}` | **String** integer micro-coins accumulated for creator. |
| `active:call:user:{userFirebaseUid}` | `callId` (TTL `ACTIVE_CALL_BY_USER_TTL` = 7200). |
| `active:call:user:{creatorFirebaseUid}` | Same `callId` (both parties point to the call). |

**Scheduler registration:**

- **ZSET mode** (`BILLING_DRIVER` unset / not `bullmq`): `ZADD billing:active_calls {nextMs} {callId}` with next score derived after each tick in `billing-batch.processor.ts`.
- **BullMQ mode:** `scheduleBillingJob(callId, BILLING_PROCESS_INTERVAL_MS)` → `Queue.add('cycle', { callId }, { jobId: 'billing-cycle:'+callId, delay: 300ms, ... })`.

### D. How billing ticks run

`BILLING_PROCESS_INTERVAL_MS = 300` (`billing.constants.ts`) — **not 1000ms**. The **worker/batch runs often**; inside `_processBillingCycleInternal`, billing **aggregates wall-clock delta** since `session.lastProcessedAt`:

- Skip if `deltaMs < MIN_BILLING_DELTA_MS` (50ms) → `'tick_ok'` without deducting (throttle).
- Clamp `deltaMs` to `MAX_BILLING_DELTA_MS` (env, default 5000ms) to bound catch-up.
- `potentialDeduct = floor((deltaMs × pricePerSecondMicros) / 1000)`.
- `actualDeduct = min(potentialDeduct, balanceMicros)` — cannot go negative.
- `timeCoveredMs = floor((actualDeduct × 1000) / pricePerSecondMicros)`.
- Creator: `earnMicros = floor((timeCoveredMs × creatorEarningsPerSecondMicros) / 1000)`.
- Update `balanceMicros`, `earningsMicros`, `session.totalDeductedMicros`, `totalEarnedMicros`, `lastProcessedAt += timeCoveredMs`, `elapsedSeconds = floor(totalDeductedMicros / pricePerSecondMicros)`.

So **“per second” is simulated by proportional deduction over arbitrary `deltaMs`**, not a literal 1 Hz timer.

**Force-end conditions inside a successful deduct path:**

1. `elapsedSeconds >= effectiveDurationLimitSeconds` → `duration_limit_reached`.
2. After persist, if `balanceMicros < pricePerSecondMicros` → `insufficient_coins` (cannot fund **next** second).

**Early exit without deduct:** if `actualDeduct <= 0` and `balanceMicros < pricePerSecondMicros` → immediate `insufficient_coins` + `'stop_needs_settlement'`.

**Concurrency:** each tick takes Redis lock `billing:cycle_lock:{callId}` (`SET NX PX` + heartbeat). Parallel ticks for the **same** `callId` skip (`return 'tick_ok'`).

### E. Termination + Stream

`forceTerminateCall` (`billing-termination.service.ts`):

1. Always emits Socket.IO `call:force-end` to **both** Firebase UIDs (reasons may differ for creator).
2. If `BILLING_SERVER_FORCE_END_ENABLED !== 'false'`:  
   - If `exists call:ended:{callId}` → dedupe.  
   - `SET billing:mark_ended_lease:{callId} NX EX` (lease TTL env, default 120s). If not acquired → dedupe.  
   - `POST .../mark_ended` via `billing-termination.stream.ts` (axios, 6s timeout).  
   - On success: `SETEX call:ended:{callId}` (300s), `DEL` lease.  
   - On failure: release lease; **if BullMQ billing enabled**, enqueue `billing-termination-retry` job `terminate:{callId}` with exponential backoff.  
   - **If `BILLING_DRIVER` is not `bullmq`, `enqueueTerminationRetryJob` returns early** (`force_terminate_retry_skipped`) — **no Bull retry queue**, Stream failure may leave media session up until client/webhook ends it.

### F. Settlement (`settleCall`)

`billing-settlement.service.ts`:

1. **`ZREM billing:active_calls {callId}`** (no-op if BullMQ-only scheduling).
2. Idempotency: `GET settled:call:{callId}` → skip; `SET settle:lock:{callId} NX EX 60`.
3. Load session + coin/earnings keys; if no session, possibly idempotent Mongo `CallHistory` path.
4. **User debit:** `totalDeducted = microsToUserDebitWholeCoins(session.totalDeductedMicros)` (**ceil** to whole coins — platform-favorable rounding).
5. **Creator credit:** `totalEarnedCreator = microsToCreatorCreditWholeCoins(earningsMicros)` (**floor**).
6. **Mongo transaction:** set `user.coins = max(0, floor(balanceMicros/COIN_MICROS))` from Redis mirror; upsert debits/credits; `CallHistory`; commit.
7. **After commit:** delete `call:session`, `call:user_coins`, `call:creator_earnings`, `active:call:user:*`; `SETEX settled:call:{callId}`; emit `coins_updated`, `billing:settled`, admin, optional Stream chat system message.

**Critical inconsistency window:** If Redis cleanup after commit fails, log says balances are committed but Redis keys may linger — **documented in code** (~385–389).

### G. Initiation paths (duplicate-safe)

1. **Socket `call:started`** (`billing-socket.gateway.ts`): rate limit → `startBillingSession` with `source: 'client_socket'` → flush `pending:call:ends:{callId}` if any.
2. **HTTP `POST /api/v1/billing/call-started`** (`billing.routes.ts`): Firebase auth; `assertBillingRestCallStartedAccess` parses `callId` and ensures payer/creator fields match; `handleCallStartedHttp` (same as socket + pending end flush).
3. **Stream webhook `call.session_started`** (`call-lifecycle.service.ts`): if `call:session:{callId}` **already exists**, **skip** `handleCallStartedHttp` (idempotent). Else `handleCallStartedHttp` with `source: 'webhook_session_started'` using **caller** `User.firebaseUid` from Mongo `Call` record.

`startBillingSession` begins with `GET call:session:{callId}` — if present, **returns immediately** (duplicate start from client + webhook).

### H. End paths

1. **Socket `call:ended`**: `isCallActive` → else `SETEX pending:call:ends:{callId}` 60s. **Disconnect does not settle** (`billing-socket.gateway.ts` explicitly avoids settling on socket drop).
2. **HTTP `POST /api/v1/billing/call-ended`**: `assertBillingRestCallEndedAccess` (participant or parsed `callId`) → `settleCallHttp` (pending end if inactive).
3. **Webhooks** `call.ended`, `call.session_ended` → `settleCallHttp`.

**Pending end:** If settlement runs before session exists, `pending` key is set; next successful `call-started` handler **deletes** it and calls `settleCall` immediately.

### I. Reconciliation (`billing-reconciliation.ts`)

- Every `RECONCILIATION_INTERVAL_MS` (5 min default), **one** node wins `SET lock:reconciliation:billing NX`.
- **DLQ:** processes keys listed in set `dlq:billing:failed:set` (from `_addToDLQ` on tick failure after retries in `processBillingTick`).
- **Stale watchdog:** only if **not** BullMQ — scans ZSET for scores older than 2 minutes and runs `processBillingTick`. **No equivalent “stale BullMQ job” watchdog** in this file.

### J. Known implementation risks (cross-cutting)

1. **DLQ + BullMQ gap:** In `processDLQ`, when `tickResult === 'tick_ok'` and `isBullmqBillingEnabled()`, code **does not** `scheduleBillingJob` (only re-ZADDs in ZSET mode). A recovered tick **does not restart the BullMQ chain** — potential **stuck billing** until another mechanism fires. **Verdict: ⚠️ risky** for BullMQ + DLQ recovery.

2. **Termination retry** requires BullMQ **and** `BILLING_TERMINATION_RETRY_ENABLED`. ZSET mode: no automated Stream retry from queue.

3. **`removeCallFromBilling` in `settleCall` always ZREM** — harmless for BullMQ; BullMQ job may still fire once → `processBillingTick` returns `stop_no_session` → worker does not reschedule (OK) but **wastes work**.

4. **Multi-instance Socket.IO:** emits use `io.to('user:...')` — without Redis adapter, clients on another node miss events (ops concern, not scenario math).

---

## Scenario 1 — User 60 coins, creator 60/min, “1 minute” call

**Interpretation:** Wallet affords **~60 seconds** at 1 coin/s. A “1 minute” call means **connected ~60s of billable time** then natural end (hang up or force-end when balance cannot fund the next second).

### 1. Call initiation flow

1. Client connects Socket.IO; joins room `user:{payerFirebaseUid}`.
2. **`call:started`** with `{ callId, creatorFirebaseUid, creatorMongoId }` (or HTTP POST with same body + `callId` encoding per `parseAppVideoCallId`).
3. **Validations:**
   - Rate limit: `checkCallRateLimit` (socket).
   - `startBillingSession`: `balanceMicros = 60 × 1e6`; `pricePerSecondMicros = 1e6`; `minEntryMicros = 10e6`; `max(1e6, 10e6) = 10e6`; `60e6 >= 10e6` → **pass**.
4. **Redis:** session + user coins mirror `60_000_000` + earnings `0` + `active:call:user:*` + scheduler (ZSET or BullMQ job `billing-cycle:{callId}` delay 300ms).
5. **`billing:started`** to user: `maxSeconds` / `remainingSeconds` = `floor(60e6/1e6) = 60`; `durationLimit` = `min(creator.maxCallDurationSeconds ?? 1800, user.maxCallDurationSeconds ?? 3600, MAX_CALL_DURATION_SECONDS)` (defaults from `pricing.config.ts`).

### 2. Billing over time

- Ticks every ~300ms cadence (worker/batch); each tick may cover up to `MAX_BILLING_DELTA_MS` (default 5000ms) of **financial** time in one go if processor was delayed.
- Over ~60s wall time, `totalDeductedMicros` approaches `60 × 1e6`; `balanceMicros` approaches `0`.
- Creator earnings increase ~`300_000` micros per **second of timeCoveredMs** (for 60/min, 30% share).

**Insufficient mid-call:** When after a tick `balanceMicros < 1e6`, **`call:force-end`** + `'stop_needs_settlement'`.

### 3. Queue + worker

- **ZSET:** each `tick_ok` resets ZSET score to `lastProcessedAt + 300ms`.
- **BullMQ:** each `tick_ok` enqueues next job `billing-cycle:{callId}` with delay from `computeNextCycleDelayMs` (backpressure may increase delay for rollout cohort).

### 4. Termination

- If user hangs up: **`call:ended`** → `settleCall` when session active.
- If wallet exhausted: tick path → `forceTerminateCall` → optional Stream `mark_ended`.

### 5. Edge cases

- **Stream OK, Redis fails during tick:** tick throws → DLQ after retries; **stale watchdog** (ZSET) or **missing BullMQ reschedule** from DLQ (see §J) affects outcome.
- **Double settlement:** `settled:call` + Mongo `CallHistory` guard.

### 6. Final state (intended)

- **User coins (Mongo):** `0` if full 60s billed at 1 coin/s and ceil debit matches mirror (see rounding).
- **Creator user wallet:** `floor` of accumulated earnings micros → ~`0.3 × 60 = 18` coins (if no rounding loss; micro accumulation uses integer math per tick).
- **Redis:** session keys deleted after successful commit; `settled:call:{callId}` set 300s.
- **Inconsistency:** possible if post-commit Redis delete fails — **money committed, Redis stale** until ops.

### 7. Scalability / correctness

- Under load, **backpressure** may delay ticks → **wall-clock call longer than billed seconds** (billed time is authoritative via `totalDeductedMicros`, not wall clock) — **undercharge of time** if users expect wall-clock billing; **code bills by financial seconds**, not watch time. **Verdict: ✅ correct relative to code; ⚠️ product ambiguity.**

**Scenario 1 verdict: ✅ correct** (within documented rounding and “billed seconds” model).

---

## Scenario 2 — Same wallet, “5 minutes” intended

There is **no** “reserve 5 minutes” API. **Affordable billed seconds remain ~60** at 60/min.

### Chronological trace

1. Same initiation as Scenario 1 (`remainingSeconds ≈ 60`).
2. After ~60s of **deducted** time, balance cannot fund second 61 → **`insufficient_coins`** force-end + settlement.
3. If participants stay connected without coins, **Stream may still carry media** until `mark_ended` succeeds or client tears down — server **attempts** `mark_ended` on force-end (if enabled).

**Billing math:** Maximum **~60** `elapsedSeconds` at this rate with 60 coins.

**Verdict: ✅ correct** for coded economics; **⚠️** if product promises 5 minutes for 60 coins.

---

## Scenario 3 — “10 minutes”

Same as Scenario 2: **~60s** billable, then force-end. **Verdict: ✅ / ⚠️** (same product caveat).

---

## Scenario 4 — “15 minutes”

Same. **Verdict: ✅ / ⚠️** (same product caveat).

---

## Scenario 5 — User 60 coins, creator **90** coins/min

### Whether call is allowed to start

- `pricePerSecondMicros = 1_500_000`.
- Entry: `max(1_500_000, 10_000_000) = 10_000_000`; `balanceMicros = 60_000_000` → **60M ≥ 10M** → **session allowed**.

### Immediately after connect

1. `billing:started` **maxSeconds** = `floor(60_000_000 / 1_500_000) = 40` seconds (integer division — **not** 60/1.5 float in UI if client shows 40).

2. Creator sees earnings rate **0.45 coins/s** display (`450_000` micros/s).

3. Full wallet depletion in **~40** billed seconds (then `insufficient_coins`).

**Verdict: ✅ correct** per code; **⚠️** UX: user may expect 60s at “60 coins” ignoring creator price.

---

## Scenario 6 — 50 users × 50 creators (50 concurrent 1:1 calls)

### Queue behavior

- **BullMQ (`BILLING_DRIVER=bullmq`):** up to `BILLING_BULLMQ_CONCURRENCY` (default **50**) jobs in parallel; each call has **one** delayed job id `billing-cycle:{callId}` at a time (default add; emergency dedupe flag exists).
- **ZSET mode:** `setInterval` every **300ms** runs `processBillingBatch`; takes up to **50** calls per batch (`BILLING_BATCH_SIZE`). **50 calls fit in one batch** — all processed in parallel **Promise.all** (each tick still **per-call locked** in Redis).

### Redis contention

- **Hot keys:** per-`callId` keys only — **little cross-call contention** except global reconciliation lock and BullMQ internal keys.
- **Per-call `billing:cycle_lock:{callId}`** — different calls do not block each other.

### Billing accuracy under concurrency

- Isolation by `callId`; no shared balance between calls.
- **Accuracy risk:** processor lag + `MAX_BILLING_DELTA_MS` catch-up may deduct **large chunks** in one tick — still capped by **remaining balance** and duration limit checks after updating `elapsedSeconds`.

### Failure under load

- Redis slowness → ticks throw → **DLQ**; ZSET stale watchdog may recover **non-BullMQ**; BullMQ DLQ tick_ok **may not reschedule** (§J).
- **Backpressure:** high queue lag → `computeNextCycleDelayMs` may increase **inter-tick delay** for calls in rollout cohort → **slower** deduction cadence, **longer** wall-clock calls for same wallet — **under-bill wall-clock**, not over-bill.

**Verdict: ⚠️ risky** under extreme lag + BullMQ + DLQ; **✅** for normal throughput per design.

---

## Explicit billing math table (scenarios 1–4, 60/min)

Let `pricePerSecondMicros = 1_000_000`.

| Item | Value |
|------|--------|
| Max affordable seconds at start | `floor(60e6 / 1e6) = 60` |
| After ~60 billed seconds | `balanceMicros < 1e6` → force-end |
| User debit (settlement) | `ceil(totalDeductedMicros / 1e6)` coins |
| Creator credit | `floor(earningsMicros / 1e6)` coins |
| Typical creator earnings micros over 60s billed | ~`60 × 300_000 = 18_000_000` → **18** coins |

**Note:** Per-tick `timeCoveredMs` rounding can leave **sub-second** remainders; final `elapsedSeconds` is tied to **`totalDeductedMicros / pricePerSecondMicros`**, not raw wall clock.

---

## Summary verdict table

| Scenario | Verdict | Primary notes |
|----------|---------|----------------|
| 1 (1 min, 60/60) | ✅ | ~60s billed; settlement ceil/floor rules apply. |
| 2 (5 min intent) | ⚠️ | Code stops ~60s; not 5 wall minutes. |
| 3 | ⚠️ | Same. |
| 4 | ⚠️ | Same. |
| 5 (90/min) | ✅ | Starts; **40s** max affordable; min 10 coins entry. |
| 6 (50×50) | ⚠️ | Scales by per-call keys; DLQ+BullMQ reschedule gap; backpressure delays. |

---

## Bugs / mismatches explicitly identified

1. **DLQ recovery does not call `scheduleBillingJob` in BullMQ mode** when a retried tick returns `tick_ok` — **billing chain may stall** (`billing-reconciliation.ts` ~303–318 vs `billing.queue.ts` scheduling).
2. **Termination retry queue** (`billing-termination.queue.ts` ~84–87) **skipped unless BullMQ** — ZSET deployments rely on **manual** or webhook/client cleanup if `mark_ended` fails.
3. **`BATCH_PROCESSOR_LOCK_KEY`** defined in `redis.ts` **unused** in `billing-batch.processor.ts` (dead config / doc drift).
4. **Documentation** elsewhere may say “1s tick”; actual scheduler is **300ms** interval with **delta-based** deduction (50ms minimum step, 5s default max catch-up).

---

*Generated from repository analysis; behavior depends on env vars in production.*
