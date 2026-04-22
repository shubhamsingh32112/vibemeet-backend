# Billing load test — validation report (coin depletion, force-end, financials)

This document captures a **50×50** billing load run: **600** coins per fan, **60** coins/min creator price, **simultaneous** `call-started` / sustain / `call-ended` via [`simulate-calls.mjs`](../scripts/load-test/simulate-calls.mjs). It addresses:

- Logged **start** and **end** timestamps (harness + REST acknowledgements).
- Whether **coins → 0** implies **server force-end**, **client disconnect signal**, and **no unbilled “free” time** at the **settlement** layer.
- **Call duration**, **user deduction**, and **creator earnings** from Mongo **`callhistories`**.

**Scope:** The harness exercises **REST billing only** (no Stream/WebRTC clients). Proving that a **real mobile app** tears down the call UI requires a **separate** Socket.IO or E2E test (see §4.2).

---

## 1. Run configuration

| Parameter | Value |
|-----------|--------|
| Pairs | 50 |
| `SEED_FAN_COINS` | 600 |
| `SEED_CREATOR_PRICE` | 60 |
| `LOAD_TEST_SUSTAIN_MS` | 1_200_000 (20 min hold before REST `call-ended`) |
| `LOAD_TEST_RAMP_UP_MS` / `LOAD_TEST_RAMP_DOWN_MS` / `LOAD_TEST_SUSTAIN_JITTER_MS` | 0 / 0 / 0 |
| API | `http://127.0.0.1:3000` |
| Redis (local) | Session-only: `REDIS_URL` overridden to the **public** Railway URL so billing works off-Railway (see [LOAD_TEST_BILLING_FINDINGS_2026-04-18.md](./LOAD_TEST_BILLING_FINDINGS_2026-04-18.md) §4.1). |

**Artifacts for this run**

| Artifact | Path |
|----------|------|
| Harness results (timestamps) | [`scripts/load-test/load-test-results-2026-04-18T19-52-16-220Z.json`](../scripts/load-test/load-test-results-2026-04-18T19-52-16-220Z.json) |
| Coins before / after | [`scripts/load-test/coins-before-validation-2026-04-18.json`](../scripts/load-test/coins-before-validation-2026-04-18.json), [`scripts/load-test/coins-after-validation-2026-04-18.json`](../scripts/load-test/coins-after-validation-2026-04-18.json) |

---

## 2. Logged start and end timestamps (harness)

The harness records:

| Field | Meaning |
|-------|--------|
| `startedAt` | Wall time when the worker **begins** (before Firebase token + HTTP). |
| `billingRestStartedAt` | ISO time when **`POST /api/v1/billing/call-started`** returned **200** (billing session accepted). |
| `billingRestEndedAt` | ISO time when **`POST /api/v1/billing/call-ended`** returned **200**. |
| `endedAt` | Wall time when the worker finishes (same instant as `billingRestEndedAt` on success). |
| `durationMs` | `endedAt` − `startedAt` (includes token fetch + full **sustain** sleep). |

**Example (row 0):**

- `startedAt`: `2026-04-18T19:32:10.992Z`
- `billingRestStartedAt`: `2026-04-18T19:32:14.702Z`
- `billingRestEndedAt`: `2026-04-18T19:52:15.955Z`
- `durationMs`: ~1,204,963 (~20.1 min), matching **20 min sustain** + overhead.

All 50 workers completed with **`callStartedHttp`: 200**, **`callEndedHttp`: 200**, **`error`: null**.

---

## 3. Requirement: coins → 0 → disconnect

### 3.1 What the backend does (code)

When a billing tick finds the fan’s balance **below one second of cost**, the service calls **`forceTerminateCall`** with **`reason: 'insufficient_coins'`** (and creator-facing `user_out_of_coins`). That function:

1. Records **`billing.force_terminate_requested`** (metrics).
2. Emits **`call:force-end`** to Socket.IO rooms **`user:{fanUid}`** and **`user:{creatorUid}`** with the reason and payload.
3. If server force-end is enabled, attempts Stream **`mark_ended`**, then triggers **settlement**.

Relevant implementation: [`billing-termination.service.ts`](../src/modules/billing/billing-termination.service.ts) (`forceTerminateCall`), and the insufficient-balance branch in [`billing.service.ts`](../src/modules/billing/billing.service.ts) (post-tick low balance).

So **“disconnect” in product terms** is modeled as **force-end + socket event + Stream end**, not as the REST harness closing a TCP connection (the harness never opens a video session).

### 3.2 Proof checklist

| # | Claim | Supported by this run? | Notes |
|---|--------|-------------------------|--------|
| 1 | **Server triggers force-end** when balance can’t pay the next second | **Partially** | Logic is in code (above). **Process metrics** in `development` are **in-memory**; Redis persistence for metric ZSETs is **not** continuously representative in dev. A **staging/production** run with `NODE_ENV=production` (or metrics polling **during** load) gives cleaner **`billing.force_terminate_requested`** counts. Redis sample in the test window showed **non-zero** `force_terminate_requested` events; full 50/50 correlation to ZSET retention is not guaranteed in dev. |
| 2 | **Client receives disconnect** | **Not proven** here | The harness does **not** open Socket.IO. To prove **`call:force-end`**, use a small **socket client** joined as `user:{firebaseUid}` or an **app E2E** test. |
| 3 | **No “free extra” billed seconds** | **Yes (settlement layer)** | **`callhistories.durationSeconds`** stayed **599–600 s** while the harness held **~20 min** before REST `call-ended`. User **coins deducted** stayed **600** each — no extra whole-coin billing for the extra ~10 minutes of wall time before the harness called `call-ended`. |

**Interpretation:** “Free extra seconds” are **not** visible as extra **billed duration** or **extra user debits** in **`CallHistory`** for this scenario. The billing session stops accumulating billable time once the wallet is exhausted (subject to tick granularity); the REST client simply stayed idle until sustain elapsed.

---

## 4. Measured call duration, user deduction, creator earnings

Queries (after settlement):

```bash
node scripts/load-test/query-callhistory-durations.mjs scripts/load-test/load-test-results-2026-04-18T19-52-16-220Z.json
node scripts/load-test/query-callhistory-financials.mjs scripts/load-test/load-test-results-2026-04-18T19-52-16-220Z.json
```

### 4.1 Billed duration (`CallHistory.durationSeconds`, user rows)

| Metric | Value |
|--------|--------|
| Rows matched | 50 / 50 |
| Min / max | **599** / **600** s |
| Mean | **599.44** s |

Nominal “10 minutes” at 60 coins/min for 600 coins is 600 s; observed **599–600 s** matches tick/rounding.

### 4.2 User coins deducted (`coinsDeducted`, user rows)

| Metric | Value |
|--------|--------|
| Min / max / mean | **600** / **600** / **600** |
| Sum (50 fans) | **30,000** |

Coin snapshot diff: every fan **600 → 0**, **`negativeAfterCount: 0`**.

### 4.3 Creator coins earned (`coinsEarned`, creator rows)

| Metric | Value |
|--------|--------|
| Min / max | **179** / **180** |
| Mean | **179.44** |
| Sum | **8,972** |

Creator credit is **below** gross user debit because the product applies **platform / fee / micros** rules in settlement (not 1:1 with fan debits). Exact split is defined in billing settlement and pricing helpers — this run **measures** outcomes, not the formula.

---

## 5. `/metrics` snapshot (informational)

After the run, **`GET /metrics`** showed **`forceTermination.requested: 0`** in the **in-process** summary — consistent with **dev** not retaining a long history of billing counters. Prefer **Redis ZSET counts over the test window** or **production** persistence for audit-style proof.

---

## 6. Harness vs video

- **Not tested:** Stream SFU, ringing, or app UI teardown.
- **Tested:** REST billing lifecycle, Redis/Mongo settlement, **`CallHistory`** financials, and **socket contract** by code inspection (`call:force-end`).

---

## 7. Cleanup

`npm run revert:load-test` was executed: **50** creators, **100** Mongo users, **100** Firebase users removed.

---

## 8. Scripts and references

| Purpose | File |
|---------|------|
| Load harness | [`scripts/load-test/simulate-calls.mjs`](../scripts/load-test/simulate-calls.mjs) |
| Duration stats | [`scripts/load-test/query-callhistory-durations.mjs`](../scripts/load-test/query-callhistory-durations.mjs) |
| User/creator money stats | [`scripts/load-test/query-callhistory-financials.mjs`](../scripts/load-test/query-callhistory-financials.mjs) |
| Force-end emit | [`src/modules/billing/billing-termination.service.ts`](../src/modules/billing/billing-termination.service.ts) |
| Insufficient-coins path | [`src/modules/billing/billing.service.ts`](../src/modules/billing/billing.service.ts) |
