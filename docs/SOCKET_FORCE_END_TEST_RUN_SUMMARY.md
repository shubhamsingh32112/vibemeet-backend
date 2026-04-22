# Socket.IO `call:force-end` test — run summary and behavior

**Document date:** 2026-04-19  

This note records how the [`socket-force-end-test.mjs`](../scripts/load-test/socket-force-end-test.mjs) harness behaves, how it differs from fixed-duration load tests, and the outcome of an execution attempt in this workspace.

---

## 1. What “run until coins end” means in this harness

There is **no real video encoder** in this script (by design: minimal Socket.IO + REST). What it simulates is the **billing session** that a real call would drive:

| Step | What happens |
|------|----------------|
| Start | One `POST /api/v1/billing/call-started` with a valid `callId` and creator fields. |
| During | The backend ticks billing against the fan’s **Mongo wallet** (same as production). |
| End | When the balance can no longer cover the next second at the creator’s rate, the server calls `forceTerminateCall` and emits **`call:force-end`**. |

**Important:** This harness does **not** send `POST /api/v1/billing/call-ended`. It does **not** use a fixed “sustain” window like [`simulate-calls.mjs`](../scripts/load-test/simulate-calls.mjs) (`LOAD_TEST_SUSTAIN_MS`). The only end condition under test is **natural wallet exhaustion** → server `call:force-end`, unless the wait budget is exceeded (see below).

At startup the script logs JSON with:

- `"naturalExhaustion": true`
- `"postsCallEnded": false`

So a “video call” in the product sense is represented by **open billing until coins hit zero**, not by a timer.

---

## 2. Wait budget (not a fixed call length)

If `FORCE_END_TEST_MAX_WAIT_MS` is **not** set, the script computes a ceiling from the same parameters used for the expected-duration line:

- `expectedWallSecondsApprox ≈ SEED_FAN_COINS × 60 / SEED_CREATOR_PRICE`
- Default max wait ≈ **that time × 1.45 + 8 minutes** (headroom for tick alignment, Redis/BullMQ, and jitter), with a small minimum so tiny wallets still work.

**You must set `SEED_FAN_COINS` and `SEED_CREATOR_PRICE` to match the last `npm run seed:load-test` run.** The pairs JSON does not include coin balances; if these env vars disagree with Mongo, the script may time out before the wallet is empty (too short) or wait far longer than needed (too long).

Example (defaults `600` / `60`): expected ~600 seconds (~10 minutes) of billed time; computed cap in one run was **22.5 minutes** (`maxWaitMs: 1350000`).

Override explicitly when needed:

```bash
# bash
export FORCE_END_TEST_MAX_WAIT_MS=7200000   # 2 hours hard cap
```

```powershell
$env:FORCE_END_TEST_MAX_WAIT_MS=7200000
```

---

## 3. Execution attempt (this workspace)

**Health check:** `GET http://127.0.0.1:3000/health` — **no response** (connection failed: backend not listening on localhost).

**Command run (fan-only mode, default pair index 0):**

- `BASE_URL=http://127.0.0.1:3000`
- `LOAD_TEST_PAIRS_PATH=scripts/load-test/pairs.generated.json`
- Backend `.env` loaded by the script for `FIREBASE_WEB_API_KEY` and related config (when present).

**Observed output (abbreviated):**

1. `force_end_wait_strategy` — confirmed `naturalExhaustion: true`, `postsCallEnded: false`, and derived `maxWaitMs` / `maxWaitMinutes` for the configured expectation.
2. `force_end_test_start` — `mode: "fan_only"`, `pairIndex: 0`, `baseURL: "http://127.0.0.1:3000"`.
3. **Failure:** WebSocket connection error — `ECONNREFUSED 127.0.0.1:3000` (nothing accepting connections on port 3000).

**Conclusion:** The **full** test (wait until `call:force-end` after ~10 minutes of billing for a 600-coin / 60-price fan) was **not** completed here because **no API/Socket.IO server was running** locally. The harness started correctly and failed at the expected stage (socket connect).

---

## 4. How to obtain a full PASS locally

1. **Start dependencies** the backend expects (MongoDB, Redis, etc.) per your environment.
2. **Start the backend** (e.g. `npm run dev` from `backend/`) so `BASE_URL` (often `http://127.0.0.1:3000`) responds on `/health` and Socket.IO accepts WebSockets.
3. **Seed** a fan/creator pair if needed, with the coin balance you want to drain (e.g. `SEED_FAN_COINS=600`):
   - Bash: `SEED_COUNT=1 SEED_FAN_COINS=600 npm run seed:load-test`
   - PowerShell: `$env:SEED_COUNT=1; $env:SEED_FAN_COINS=600; npm run seed:load-test`
4. **Export** `BASE_URL`, `LOAD_TEST_PAIRS_PATH`, matching `SEED_FAN_COINS` / `SEED_CREATOR_PRICE`, and `FIREBASE_WEB_API_KEY` (see [`billing-load-test.env.example`](../scripts/load-test/billing-load-test.env.example)).
5. **Run:** `npm run loadtest:socket-force-end` (from `backend/`).

**PASS** when logs include `FORCE_END_PASS` with payload `reason: "insufficient_coins"` and a `timing` block whose `deltaSec` is near the expected wall time (allow a few seconds for billing ticks).

**Both participants:** set `FORCE_END_TEST_BOTH_PARTIES=1` and ensure Firebase Admin credentials are available so the script can mint a creator ID token; expect the creator payload `reason: "user_out_of_coins"`.

---

## 5. Mapping to your failure scenarios

| Case | Meaning |
|------|--------|
| **A** — No event | Billing not ticking, wrong pair/callId, or balance never reaches zero within the wait budget. Check server logs and Redis/BullMQ. |
| **B** — Event very late | Infra backlog or very large `BILLING_PROCESS_INTERVAL_MS`; distinguish from normal tick quantization (~sub-second to a few seconds). |
| **C** — Event in harness but app UI stuck | Flutter/client not handling `call:force-end`; this script only proves server → socket. |

---

## 6. Security note

Do **not** commit real `.env` values, Firebase keys, or Mongo/Redis URLs into this summary or into version control. Use placeholders in documentation and keep secrets in local or CI-only configuration.

---

## 7. Related documentation

- Full procedure and socket contract: [`SOCKET_FORCE_END_ENFORCEMENT_TEST.md`](SOCKET_FORCE_END_ENFORCEMENT_TEST.md)
- Billing findings (REST load tests): [`LOAD_TEST_BILLING_FINDINGS_2026-04-18.md`](LOAD_TEST_BILLING_FINDINGS_2026-04-18.md)
