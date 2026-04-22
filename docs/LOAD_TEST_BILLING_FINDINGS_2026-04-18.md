# Billing load test — findings report (2026-04-18)

This document summarizes **backend-driven billing load tests** run against a **local** API instance, using the harness under `backend/scripts/load-test/` and seed/revert scripts under `backend/src/scripts/`. It captures **what was tested**, **how it was configured**, **what succeeded or failed in earlier attempts**, and **what the final successful run demonstrated**.

**Important scope note:** These tests exercise **REST billing** (`POST /api/v1/billing/call-started` and `/call-ended`) and server-side Redis/Mongo settlement. They do **not** exercise Stream’s SFU or mobile clients. Behavior is representative of **billing + settlement**, not full end-to-end video UX.

---

## 1. Objectives

1. **Concurrent sessions:** Simulate **50 simultaneous** billable sessions (50 distinct fan users × 50 distinct creator users — required because the backend allows **only one active billed call per creator** at a time).
2. **Coin depletion / auto-end:** With **creator price = 60 coins per minute**, verify that users with **~600 coins** cannot sustain much beyond **~10 minutes** of billed time, and that the system **does not leave negative balances** when coins run out.
3. **Spread of balances:** Exercise a **600–660 coin** range across fans to observe variation in total debit (ceil/tick quantization still applies).
4. **Observability:** Sample **`GET /metrics`** during load where possible.
5. **Reversibility:** After testing, **remove seeded Mongo + Firebase users** so the environment returns to a clean state (no long-lived test accounts).

---

## 2. Architecture under test (code-aligned)

| Step | Mechanism |
|------|-----------|
| Start billing | `POST /api/v1/billing/call-started` with `callId`, `creatorFirebaseUid`, `creatorMongoId` |
| Tick processing | Redis-backed billing; default tick interval **450ms** (`BILLING_PROCESS_INTERVAL_MS`) |
| End / settle | `POST /api/v1/billing/call-ended` with `callId` |
| `callId` format | `{fanFirebaseUid}_{creatorMongoId}_{digits}` — see `billing-call-id.util.ts` |

Pricing for billing uses **`Creator.price` as coins per minute**, converted to per-second micro-coins in `pricing.service.ts` / `billing.constants.ts`. A naive “rate × wall-clock minutes” may **not** equal final whole-coin debits; settlement uses **micros** and **rounding rules** at settlement.

---

## 3. Harness and scripts (deliverables)

| Artifact | Purpose |
|----------|---------|
| `src/scripts/seed-load-test-users.ts` | Creates Firebase users + Mongo `User` + `Creator`; writes `scripts/load-test/pairs.generated.json` |
| `src/scripts/revert-load-test-users.ts` | Deletes seeded users/creators by `loadtest_*@<domain>` pattern; removes Firebase Auth users |
| `scripts/load-test/simulate-calls.mjs` | Concurrent virtual “calls”: token → `call-started` → hold → `call-ended` |
| `scripts/load-test/metrics-poll.mjs` | Polls `GET /metrics` on an interval, appends JSONL |
| `scripts/load-test/snapshot-coins.mjs` | Snapshots `User.coins` for fans in pairs file; `diff` compares before/after |

NPM shortcuts (from `backend/package.json`):

- `npm run seed:load-test`
- `npm run revert:load-test`
- `npm run loadtest:billing`
- `npm run loadtest:metrics`
- `npm run loadtest:snapshot-coins`

---

## 4. Environment and operational constraints

### 4.1 Local Redis connectivity

The backend’s `.env` may define:

- **`REDIS_URL`** pointing at an **internal** hostname (e.g. Railway internal DNS) that **does not resolve on a developer machine**.
- **`REDIS_PUBLIC_URL`** (or equivalent) that **does** resolve publicly.

The Redis helper prefers `REDIS_URL` **first**, then `REDIS_PUBLIC_URL` (`backend/src/config/redis.ts`). For **local** runs:

- **Session-only fix (recommended):** In the shell that starts `npm run dev`, set `REDIS_URL` to the **public** Redis URL for that process only. **Do not commit** ad-hoc URL edits unless your team standardizes on public Redis for local dev.

If Redis is unreachable, billing and `/metrics` aggregation that touch Redis can fail with **HTTP 500** or **ioredis “max retries”** errors on `call-started` / `call-ended`.

### 4.2 Port collision (`EADDRINUSE`)

If **multiple** Node processes bind to **port 3000**, one instance crashes and traffic may hit a **stale** process (wrong Redis config, half-initialized state). Symptom: intermittent **500** on billing while another process still answers `/health`.

**Mitigation:** Ensure **exactly one** listener on the target port before load tests (stop stray `tsx watch` / `node` dev servers).

### 4.3 Rate limits

Billing REST endpoints are **rate-limited per Firebase user** (`billingLimiter` in `rate-limit.middleware.ts`). Using **50 distinct fan users** avoids per-user burst issues during staggered or parallel starts.

### 4.4 Secrets

This document intentionally **does not** reproduce API keys, JWT secrets, Redis passwords, or private keys. Load tests should run against **staging** or a dedicated test project whenever possible.

---

## 5. Earlier failed / partial runs (what went wrong)

These runs are worth recording because they explain noisy results and guide future operators.

| Issue | Symptom | Cause |
|--------|---------|--------|
| Redis internal hostname from laptop | `call-started` **500**, ioredis max retries | DNS / network path to internal Redis |
| Wrong process on :3000 | **500** on billing despite “healthy” server | **EADDRINUSE**; new dev server exited; old process served requests |
| Very high concurrency + settlement | `call-ended` **500**, Redis errors in metrics | Overload / timeouts under burst; needs healthy Redis and single server instance |

These failures are **infrastructure/process** issues, not proof that billing logic is wrong — but they **invalidate** a run until Redis and a single backend instance are confirmed.

---

## 6. Successful scenario: 50 × 1:1, 60 coins/min, balances 600–660, long hold

### 6.1 Configuration

| Parameter | Value |
|-----------|--------|
| Pairs | 50 (fan + creator each) |
| Creator `price` | **60** coins/minute |
| Fan balances | **600–649** (50 distinct values in range; spread implemented by index modulo after seed) |
| Simultaneity | **Ramp-up 0 ms** — all 50 workers start together |
| Sustain | **900000 ms (15 minutes)** — longer than ~10 minutes so that users with ~600 coins should hit **depletion / force path** well before the hold ends |
| Base URL | `http://127.0.0.1:3000` (local) |
| Redis for this run | Public proxy URL via **session-only** `REDIS_URL` override when starting dev server |

### 6.2 Outcome (load harness JSON)

Result file:

- `backend/scripts/load-test/load-test-results-2026-04-18T15-31-19-489Z.json`

Aggregates (from that run):

| Metric | Value |
|--------|--------|
| Rows | 50 |
| `call-started` HTTP 200 | **50 / 50** |
| `call-ended` HTTP 200 | **50 / 50** |
| Harness-reported `error` field | **0** |
| Duration (wall time per worker) | ~**912–914 s** (~15.2 min) — matches intentional sustain window |

So the **client harness** completed all starts and ends without HTTP errors in this run.

### 6.3 Coin correctness (Mongo snapshots)

Snapshots:

- Before: `backend/scripts/load-test/coins-before.json`
- After: `backend/scripts/load-test/coins-after.json`

Diff (`npm run loadtest:snapshot-coins -- diff ...`):

- For **every** fan: **`coinsAfter === 0`**
- **`deltaCoins`** matched **`coinsBefore`** for each user (full depletion of the seeded balance in Mongo)
- **`negativeAfterCount === 0`**

**Interpretation:** Under this run, users did **not** end with negative balances. Total debits aligned with **starting whole-coin balances** after the session (subject to the system’s micros + settlement rounding — here ending at zero across the board).

**Note on “exactly 10 minutes”:** At **60 coins/minute**, **600 coins** ≈ **10 minutes** of nominal minute-rate cost, but actual billed duration is driven by **tick interval**, **partial ticks**, **ceil at settlement**, and **force-terminate** behavior. The harness does **not** assert wall-clock “stop at 10:00”; it asserts **no negative coins** and **successful** `call-ended` after a **long** hold. Tighter timing assertions would require **per-call timestamps** from server logs or instrumenting billing events.

---

## 7. Metrics sampling

A metrics JSONL file was written during the run, e.g.:

- `backend/scripts/load-test/metrics-samples-2026-04-18T15-15-28-493Z.jsonl`

Observed characteristics in sampled lines (not a full time-series analysis):

- **`GET /metrics`** returned **HTTP 200** in sampled windows.
- **`billing.backpressure.currentStage`** remained **0** in those samples.
- **`runtime.eventLoopLagMs`** stayed in the **low millisecond** range in sampled windows.
- Redis pipeline counters showed activity without obvious failure-rate spikes in the sampled segments.

**Caveat:** `/metrics` combines in-process summaries and Redis-backed rollups; under extreme failure modes, the endpoint itself can return **500** if Redis sampling fails — treat metrics availability as part of the health check.

---

## 8. Cleanup / revert (return to “normal”)

After the successful run, **`npm run revert:load-test`** was executed. Reported effect:

| Action | Count |
|--------|--------|
| Creator documents removed | 50 |
| User documents removed | 100 (50 fans + 50 creators) |
| Firebase Auth users deleted | 100 (with `auth/user-not-found` treated as OK) |

This removes **seeded** test identities from Mongo and Firebase. It does **not** delete unrelated users.

**Local artifacts** (result JSON, metrics JSONL, coin snapshots) may remain under `backend/scripts/load-test/` unless gitignored — they are **not** secrets but can be large; delete manually if desired.

---

## 9. Limitations and follow-ups

1. **Not Stream video:** No WebRTC, no SDK `call.getOrCreate`, no Stream webhooks in this path — only billing REST + server tick/settlement.
2. **Harness holds wall-clock time:** The script waits a fixed **sustain** duration; it does **not** poll “call still active.” Auto-end due to coins is inferred from **final balances** and successful **`call-ended`**, not from a client “call ended” event.
3. **Production load:** These runs targeted **localhost**. Running the same against production requires change control, **`BASE_URL`**, and careful rate-limit / abuse policies.
4. **Stronger proof of “stopped at T≈10min”:** Add server-side logging correlation (`callId`, first tick, force-terminate reason, settlement time) or export billing session timeline from Redis/Mongo for each test user.

---

## 10. Quick reproduction checklist (operators)

1. From `backend/`, ensure **one** dev server on the chosen port with **working Redis** (public URL for local if needed).
2. `npm run seed:load-test` (adjust `SEED_COUNT`, `SEED_FAN_COINS`, `SEED_CREATOR_PRICE` via env as needed).
3. Optionally adjust fan balances in Mongo to a spread (600–660) if testing depletion variance.
4. `npm run loadtest:snapshot-coins -- snapshot scripts/load-test/pairs.generated.json scripts/load-test/coins-before.json`
5. Set `BASE_URL`, `LOAD_TEST_PAIRS_PATH`, `LOAD_TEST_SUSTAIN_MS`, ramp envs; run `npm run loadtest:billing`
6. `npm run loadtest:snapshot-coins -- snapshot ... coins-after.json` then `diff` before/after
7. `npm run revert:load-test` to clean Firebase + Mongo test users

---

## 11. References (code)

- Billing REST: `backend/src/modules/billing/billing.routes.ts`
- Call ID parsing: `backend/src/modules/billing/billing-call-id.util.ts`
- Billing service / ticks: `backend/src/modules/billing/billing.service.ts`
- Pricing snapshot: `backend/src/modules/video/pricing.service.ts`
- Metrics endpoint: `backend/src/server.ts` (`GET /metrics`)
- Redis config: `backend/src/config/redis.ts`

---

*Generated from internal load-test execution and harness output on 2026-04-18. Update this file if test procedures or env defaults change.*
