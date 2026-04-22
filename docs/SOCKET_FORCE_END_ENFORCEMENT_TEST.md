# Socket.IO `call:force-end` enforcement test

This document describes how to **prove real-time UX enforcement** for video-call billing: when the fan’s wallet can no longer pay for the next billing second, the backend **terminates billing**, emits a Socket.IO event to **both** participants, and (when enabled) drives server-side call teardown. It complements REST-only load tests that already validated **ledger correctness** and **concurrency**.

---

## 1. What this test proves vs what it does not

| Layer | What prior tests showed | What this test shows |
|--------|-------------------------|----------------------|
| Billing math / settlement | REST `call-started` / `call-ended`, Mongo, Redis | Same session can drive **live** `call:force-end` |
| Socket contract | Documented in code | **Observed** on the wire for `call:force-end` |
| Mobile UI | Not covered | **Not covered** — Flutter must listen for the event separately (see failure Case C) |

**Pass for this harness:** an authenticated Socket.IO client in room `user:{fanFirebaseUid}` receives `call:force-end` with `reason: 'insufficient_coins'` after the wallet is exhausted, within the expected wall-clock window (see timing section). Optional mode also verifies the creator socket receives `reason: 'user_out_of_coins'`.

---

## 2. Exact server contract (from code)

### 2.1 Event and rooms

Implementation: [`billing-termination.service.ts`](../src/modules/billing/billing-termination.service.ts) — `forceTerminateCall`.

- **Event name:** `call:force-end`
- **Fan room:** `user:{userFirebaseUid}` — payload includes `callId`, `reason: 'insufficient_coins'`, and `remainingCoins` (floor of micro-balance) when provided.
- **Creator room:** `user:{creatorFirebaseUid}` — same event name, payload uses **`reason: 'user_out_of_coins'`** (via `creatorReason`).

Emission happens **before** optional Stream `mark_ended` / settlement work; socket delivery is not blocked by Redis settlement latency.

### 2.2 When it fires

After each billing tick, if **post-deduction** balance is below one second of cost (`balanceMicros < pricePerSecondMicros`), the billing service schedules `forceTerminateCall` with the reasons above. See [`billing.service.ts`](../src/modules/billing/billing.service.ts) (post-tick insufficient branch). Scheduling uses `emitSoon` → `setImmediate` (negligible delay vs wall clock).

### 2.3 No client `join:user` event

The sample snippet that calls `socket.emit('join:user', uid)` **does not match this repository**. Authenticated connections are **automatically** joined to `user:{firebaseUid}` in [`billing-socket.gateway.ts`](../src/modules/billing/billing-socket.gateway.ts) (`socket.join(\`user:${firebaseUid}\`)`). The harness only needs:

- `io(BASE_URL, { auth: { token: ID_TOKEN }, transports: ['websocket'] })`

### 2.4 REST `call-started` (no Flutter)

Same body as other load tests:

- `POST /api/v1/billing/call-started`
- Body: `{ callId, creatorFirebaseUid, creatorMongoId }`
- Header: `Authorization: Bearer <fan ID token>`

`callId` must match [`parseAppVideoCallId`](../src/modules/billing/billing-call-id.util.ts): `{fanUid}_{creatorMongoId}_{numericTimestamp}` (timestamp may be ms or seconds — digits only).

---

## 3. Expected timing (600 coins, default creator price)

Seed script ([`seed-load-test-users.ts`](../src/scripts/seed-load-test-users.ts)) sets creator **`price`** from `SEED_CREATOR_PRICE` (default **60** coins per minute, see [`DEFAULT_CREATOR_STARTER_PRICE`](../src/modules/creator/creator-starter.service.ts)).

**Nominal drain rate:** `creatorPrice / 60` whole coins per second.

**Approximate seconds until exhaustion:**

\[
T_{\mathrm{sec}} \approx \frac{\texttt{SEED\_FAN\_COINS} \times 60}{\texttt{SEED\_CREATOR\_PRICE}}
\]

Example: `SEED_FAN_COINS=600`, `SEED_CREATOR_PRICE=60` → \(600 \times 60 / 60 = 600\) seconds (**10 minutes**).

**Jitter:** Billing ticks use [`BILLING_PROCESS_INTERVAL_MS`](../src/modules/billing/billing.constants.ts) (default **450 ms**). The force-end tick is aligned to that grid, so **`t2 - t1` is usually within roughly ±1–2 seconds** of \(T_{\mathrm{sec}}\), not necessarily exact to the millisecond. If you see **many seconds** of extra delay, investigate infra (Redis, worker backlog, CPU) rather than rounding alone.

The harness logs:

- `billingRestStartedAt` / `t1_ms`
- `force-end` receive time / `t2_ms`
- `deltaSec`, `expectedSec`, `skewSec`

Set `SEED_FAN_COINS` and `SEED_CREATOR_PRICE` in the environment when running the script so the **expected** line matches how you seeded (the pairs JSON does not store coin counts).

---

## 4. Prerequisites

1. **MongoDB** and **Redis** available with the same config as the backend.
2. **Backend** running (e.g. `npm run dev` or `npm start`) and reachable at `BASE_URL`.
3. **Firebase:** `FIREBASE_WEB_API_KEY` for token exchange. For **dual-socket** mode (fan + creator), **Firebase Admin** credentials are required (`GOOGLE_APPLICATION_CREDENTIALS`, `FIREBASE_SERVICE_ACCOUNT_JSON`, or `FIREBASE_PROJECT_ID` + key + client email) so the script can mint ID tokens for both UIDs via custom token exchange.
4. **Seeded pairs file** — from backend root:

   **bash / macOS / Linux**

   ```bash
   export SEED_COUNT=1
   export SEED_FAN_COINS=600
   npm run seed:load-test
   ```

   **Windows PowerShell**

   ```powershell
   $env:SEED_COUNT=1; $env:SEED_FAN_COINS=600; npm run seed:load-test
   ```

   Default output: [`scripts/load-test/pairs.generated.json`](../scripts/load-test/pairs.generated.json). Point `LOAD_TEST_PAIRS_PATH` at that file (absolute or relative to `process.cwd()` when running from `backend/`).

5. **Environment for the harness** (see [`billing-load-test.env.example`](../scripts/load-test/billing-load-test.env.example) for patterns):

   - `BASE_URL` — e.g. `http://127.0.0.1:3000`
   - `LOAD_TEST_PAIRS_PATH` — e.g. `scripts/load-test/pairs.generated.json`
   - `FIREBASE_WEB_API_KEY`
   - Optional: `SEED_FAN_COINS`, `SEED_CREATOR_PRICE` (for expectation logging only)
   - Optional: `SEED_FIREBASE_PASSWORD` if using email/password sign-in for the fan (when Admin SDK is not used)

---

## 5. How to run the harness

From **`backend/`** (where `package.json` lives):

```bash
npm install
npm run loadtest:socket-force-end
```

Or:

```bash
node scripts/load-test/socket-force-end-test.mjs
```

### 5.1 Modes

| Env | Behavior |
|-----|----------|
| *(default)* | Single pair (`PAIR_INDEX`, default `0`), **fan socket only** — asserts `reason === 'insufficient_coins'`. |
| `FORCE_END_TEST_BOTH_PARTIES=1` | Fan + creator sockets — asserts fan `insufficient_coins` and creator `user_out_of_coins` for the same `callId`. **Requires Firebase Admin.** |
| `FORCE_END_TEST_MULTI_N=10` | First **N** pairs — N parallel fan sockets and N `call-started` calls; waits until **all** receive `call:force-end`. |

Other useful variables:

- `FORCE_END_TEST_MAX_WAIT_MS` — optional hard cap (milliseconds). If **unset**, the harness derives a wait budget from `SEED_FAN_COINS` and `SEED_CREATOR_PRICE` (45% headroom plus eight minutes) so large wallets are not cut off by a short fixed timeout. The script logs `force_end_wait_strategy` with `postsCallEnded: false` (it never sends `call-ended`; the session ends when the server emits `call:force-end` after the wallet is exhausted).
- `PAIR_INDEX` — which row in the pairs JSON (default `0`).
- `LOAD_TEST_HTTP_TIMEOUT_MS` — HTTP client timeout for `call-started`.

---

## 6. Expected PASS output (illustrative)

After ~10 minutes with 600 coins and price 60, logs should include JSON lines such as:

- `event: "billing_call_started"` with `billingRestStartedAt`
- `event: "FORCE_END_PASS"` with payload containing `"reason": "insufficient_coins"`
- `event: "timing"` with `deltaSec` near `expectedSec`, `skewSec` small (typically under a few seconds)

Dual-party mode adds a second `FORCE_END_PASS` for role `creator` with `"reason": "user_out_of_coins"`.

---

## 7. Failure scenarios and triage

### Case A — No `call:force-end` before timeout

**Symptom:** Harness exits with timeout; no or wrong payload.

**Possible causes:**

- Billing worker not running or Redis disconnected — ticks never drain the session.
- Wrong `callId` / pair mismatch so the client filters out events.
- Fan balance not what you think (seed not applied, or different env).
- Exception path in billing skipping termination (check server logs / metrics).

**Code areas:** insufficient-balance branch in [`billing.service.ts`](../src/modules/billing/billing.service.ts), `forceTerminateCall` in [`billing-termination.service.ts`](../src/modules/billing/billing-termination.service.ts).

### Case B — Event arrives very late (e.g. tens of seconds after expected)

**Symptom:** `skewSec` huge consistently.

**Possible causes:**

- Redis or BullMQ backlog, process CPU starvation, or `BILLING_PROCESS_INTERVAL_MS` set very high.
- Network issues between client and server (less likely on localhost).

Distinguish **one tick (~0.45 s default)** of quantization from **multi-second** infra delay.

### Case C — Event received in harness but app does not end the call

**Symptom:** This script passes; Flutter user still on video.

**Interpretation:** Server emitted correctly; **client** not handling `call:force-end` or not wiring billing state to `CallConnectionController` / `callBillingProvider`. See app code paths (e.g. `call:force-end` listeners and `forceEnded` in billing state). This repository’s harness **does not** test Flutter.

---

## 8. Advanced: correlate with server time (optional)

For production-level debugging you can add a **temporary** log inside `forceTerminateCall` (e.g. `callId`, `Date.now()`) and compare to the harness `t2_ms`. Remove before merging if policy requires no noisy logs. The harness already compares **client-received** time to **expected duration from seed parameters**; server log is optional confirmation of emit time.

---

## 9. Limitations and flags

- **`BILLING_SERVER_FORCE_END_ENABLED`:** If set to `false`, [`forceTerminateCall`](../src/modules/billing/billing-termination.service.ts) still **emits** `call:force-end` but **skips** server-side Stream `mark_ended` and related steps. Clients might still need to tear down media. See [`VIDEO_BILLING_EXECUTION_TRACE_DEEP.md`](VIDEO_BILLING_EXECUTION_TRACE_DEEP.md).
- **Stream / GetStream:** This test does not open a real video session; it validates **billing + socket** enforcement only.
- **Auth:** Dual-socket mode requires Firebase Admin for the creator token unless you extend the script to sign in as the creator via email (not generated in the default pairs JSON).

---

## 10. Success criteria checklist

- [ ] `call:force-end` received on fan socket with `reason: 'insufficient_coins'` (and correct `callId`).
- [ ] `deltaSec` ≈ `SEED_FAN_COINS * 60 / SEED_CREATOR_PRICE` within tick-level tolerance (typically a few seconds max on a healthy local stack).
- [ ] If `FORCE_END_TEST_BOTH_PARTIES=1`: creator receives `user_out_of_coins` for the same `callId`.
- [ ] If `FORCE_END_TEST_MULTI_N`: all N participants receive the event within the max wait window.

When these hold, **real-time enforcement of the socket contract** is confirmed for the backend path that mirrors production billing termination.
