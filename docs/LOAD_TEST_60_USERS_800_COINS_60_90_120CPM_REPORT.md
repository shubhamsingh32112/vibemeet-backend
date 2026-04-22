# Load test: concurrent billing until coin exhaustion

**Generated:** 2026-04-21T11:19:00.513Z  
**Harness:** `scripts/load-test/socket-force-end-test.mjs` (multi mode)  
**JSON:** `scripts/load-test/force-end-multi-results-2026-04-21T11-19-00-492Z.json`

## 1. Configuration

| Parameter | Value |
|-----------|--------|
| Concurrent fan sessions | 60 |
| Fan coins (seed) | 800 |
| Creator pricing | Mixed tiers: **60, 90, 120** coins/min (see §5). Slowest expected exhaustion (min CPM): ~800.0 s. |
| Wait budget (default strategy) | Derived from **min** CPM across pairs (60) so the slowest-burn session can exhaust |
| Billing end condition | Server emits `call:force-end` with `reason: insufficient_coins` (no client `call-ended`) |
| BASE_URL | http://127.0.0.1:3000 |

## 2. Scope (what this proves)

- **Proves:** Concurrent **billing + Socket.IO** behavior: each fan starts one billable session; the server drains the seeded wallet at the creator rate until balance cannot cover the next second, then emits `call:force-end`.
- **Does not prove:** WebRTC video stability, packet loss, or Stream video quality — there is no real media in this harness. Treat “call stability” below as **billing/socket/session** stability; production video should be validated separately (e.g. real devices + Stream dashboards).

## 3. Overall outcome

**All sessions auto-ended on zero coins (socket signal):** **YES** — every fan received `call:force-end` / `insufficient_coins` within the wait budget.

## 4. Duration statistics — all successful sessions

| Metric | Value (seconds) |
|--------|-----------------|
| Count | 60 |
| Min | 399.786 |
| Max | 800.755 |
| Mean | 577.948 |
| Median | 533.380 |
| Std dev | 166.363 |


## 5. Duration statistics — by creator price tier

### 60 coins/min (expected wall ~800.0 s)

| Metric | Value (seconds) |
|--------|-----------------|
| Count | 20 |
| Min | 799.872 |
| Max | 800.755 |
| Mean | 800.279 |
| Median | 800.350 |
| Std dev | 0.221 |

### 90 coins/min (expected wall ~533.3 s)

| Metric | Value (seconds) |
|--------|-----------------|
| Count | 20 |
| Min | 533.130 |
| Max | 533.805 |
| Mean | 533.429 |
| Median | 533.380 |
| Std dev | 0.177 |

### 120 coins/min (expected wall ~400.0 s)

| Metric | Value (seconds) |
|--------|-----------------|
| Count | 20 |
| Min | 399.786 |
| Max | 400.480 |
| Mean | 400.137 |
| Median | 400.164 |
| Std dev | 0.202 |


## 6. Per-session results (table)

| Index | Fan email | CPM | billingRestStartedAt | forceEndAt | Duration (s) | Skew vs expected (s) | remainingCoins | Auto-ended | Notes |
|-------|-----------|-----|----------------------|------------|--------------|----------------------|----------------|------------|-------|
| 0 | loadtest_fan_1@loadtest60.local | 60 | 2026-04-21T11:05:38.221Z | 2026-04-21T11:18:58.618Z | 800.397 | 0.397 | 0 | yes | insufficient_coins |
| 1 | loadtest_fan_2@loadtest60.local | 60 | 2026-04-21T11:05:38.194Z | 2026-04-21T11:18:58.306Z | 800.112 | 0.112 | 0 | yes | insufficient_coins |
| 2 | loadtest_fan_3@loadtest60.local | 60 | 2026-04-21T11:05:38.271Z | 2026-04-21T11:18:58.619Z | 800.348 | 0.348 | 0 | yes | insufficient_coins |
| 3 | loadtest_fan_4@loadtest60.local | 60 | 2026-04-21T11:05:39.399Z | 2026-04-21T11:18:59.551Z | 800.152 | 0.152 | 0 | yes | insufficient_coins |
| 4 | loadtest_fan_5@loadtest60.local | 60 | 2026-04-21T11:05:38.278Z | 2026-04-21T11:18:58.307Z | 800.029 | 0.029 | 0 | yes | insufficient_coins |
| 5 | loadtest_fan_6@loadtest60.local | 60 | 2026-04-21T11:05:37.950Z | 2026-04-21T11:18:58.307Z | 800.357 | 0.357 | 0 | yes | insufficient_coins |
| 6 | loadtest_fan_7@loadtest60.local | 60 | 2026-04-21T11:05:38.177Z | 2026-04-21T11:18:58.932Z | 800.755 | 0.755 | 0 | yes | insufficient_coins |
| 7 | loadtest_fan_8@loadtest60.local | 60 | 2026-04-21T11:05:38.207Z | 2026-04-21T11:18:58.618Z | 800.411 | 0.411 | 0 | yes | insufficient_coins |
| 8 | loadtest_fan_9@loadtest60.local | 60 | 2026-04-21T11:05:40.286Z | 2026-04-21T11:19:00.491Z | 800.205 | 0.205 | 0 | yes | insufficient_coins |
| 9 | loadtest_fan_10@loadtest60.local | 60 | 2026-04-21T11:05:38.428Z | 2026-04-21T11:18:58.307Z | 799.879 | 0.121 | 0 | yes | insufficient_coins |
| 10 | loadtest_fan_11@loadtest60.local | 60 | 2026-04-21T11:05:38.291Z | 2026-04-21T11:18:58.307Z | 800.016 | 0.016 | 0 | yes | insufficient_coins |
| 11 | loadtest_fan_12@loadtest60.local | 60 | 2026-04-21T11:05:38.438Z | 2026-04-21T11:18:58.931Z | 800.493 | 0.493 | 0 | yes | insufficient_coins |
| 12 | loadtest_fan_13@loadtest60.local | 60 | 2026-04-21T11:05:37.944Z | 2026-04-21T11:18:58.307Z | 800.363 | 0.363 | 0 | yes | insufficient_coins |
| 13 | loadtest_fan_14@loadtest60.local | 60 | 2026-04-21T11:05:37.963Z | 2026-04-21T11:18:58.306Z | 800.343 | 0.343 | 0 | yes | insufficient_coins |
| 14 | loadtest_fan_15@loadtest60.local | 60 | 2026-04-21T11:05:38.268Z | 2026-04-21T11:18:58.619Z | 800.351 | 0.351 | 0 | yes | insufficient_coins |
| 15 | loadtest_fan_16@loadtest60.local | 60 | 2026-04-21T11:05:37.952Z | 2026-04-21T11:18:58.307Z | 800.355 | 0.355 | 0 | yes | insufficient_coins |
| 16 | loadtest_fan_17@loadtest60.local | 60 | 2026-04-21T11:05:38.357Z | 2026-04-21T11:18:58.932Z | 800.575 | 0.575 | 0 | yes | insufficient_coins |
| 17 | loadtest_fan_18@loadtest60.local | 60 | 2026-04-21T11:05:38.172Z | 2026-04-21T11:18:58.306Z | 800.134 | 0.134 | 0 | yes | insufficient_coins |
| 18 | loadtest_fan_19@loadtest60.local | 60 | 2026-04-21T11:05:38.435Z | 2026-04-21T11:18:58.307Z | 799.872 | 0.128 | 0 | yes | insufficient_coins |
| 19 | loadtest_fan_20@loadtest60.local | 60 | 2026-04-21T11:05:38.506Z | 2026-04-21T11:18:58.931Z | 800.425 | 0.425 | 0 | yes | insufficient_coins |
| 20 | loadtest_fan_1@loadtest90.local | 90 | 2026-04-21T11:05:38.220Z | 2026-04-21T11:14:31.612Z | 533.392 | 0.059 | 1 | yes | insufficient_coins |
| 21 | loadtest_fan_2@loadtest90.local | 90 | 2026-04-21T11:05:38.289Z | 2026-04-21T11:14:31.927Z | 533.638 | 0.305 | 1 | yes | insufficient_coins |
| 22 | loadtest_fan_3@loadtest90.local | 90 | 2026-04-21T11:05:38.287Z | 2026-04-21T11:14:31.927Z | 533.640 | 0.307 | 1 | yes | insufficient_coins |
| 23 | loadtest_fan_4@loadtest90.local | 90 | 2026-04-21T11:05:37.956Z | 2026-04-21T11:14:31.298Z | 533.342 | 0.009 | 1 | yes | insufficient_coins |
| 24 | loadtest_fan_5@loadtest90.local | 90 | 2026-04-21T11:05:38.202Z | 2026-04-21T11:14:31.612Z | 533.410 | 0.077 | 1 | yes | insufficient_coins |
| 25 | loadtest_fan_6@loadtest90.local | 90 | 2026-04-21T11:05:38.169Z | 2026-04-21T11:14:31.299Z | 533.130 | 0.203 | 1 | yes | insufficient_coins |
| 26 | loadtest_fan_7@loadtest90.local | 90 | 2026-04-21T11:05:38.190Z | 2026-04-21T11:14:31.442Z | 533.252 | 0.081 | 1 | yes | insufficient_coins |
| 27 | loadtest_fan_8@loadtest90.local | 90 | 2026-04-21T11:05:38.238Z | 2026-04-21T11:14:31.612Z | 533.374 | 0.041 | 1 | yes | insufficient_coins |
| 28 | loadtest_fan_9@loadtest90.local | 90 | 2026-04-21T11:05:38.272Z | 2026-04-21T11:14:31.927Z | 533.655 | 0.322 | 1 | yes | insufficient_coins |
| 29 | loadtest_fan_10@loadtest90.local | 90 | 2026-04-21T11:05:38.009Z | 2026-04-21T11:14:31.298Z | 533.289 | 0.044 | 1 | yes | insufficient_coins |
| 30 | loadtest_fan_11@loadtest90.local | 90 | 2026-04-21T11:05:38.188Z | 2026-04-21T11:14:31.441Z | 533.253 | 0.080 | 1 | yes | insufficient_coins |
| 31 | loadtest_fan_12@loadtest90.local | 90 | 2026-04-21T11:05:38.269Z | 2026-04-21T11:14:31.612Z | 533.343 | 0.010 | 1 | yes | insufficient_coins |
| 32 | loadtest_fan_13@loadtest90.local | 90 | 2026-04-21T11:05:38.274Z | 2026-04-21T11:14:31.926Z | 533.652 | 0.319 | 1 | yes | insufficient_coins |
| 33 | loadtest_fan_14@loadtest90.local | 90 | 2026-04-21T11:05:38.303Z | 2026-04-21T11:14:31.927Z | 533.624 | 0.291 | 1 | yes | insufficient_coins |
| 34 | loadtest_fan_15@loadtest90.local | 90 | 2026-04-21T11:05:38.170Z | 2026-04-21T11:14:31.441Z | 533.271 | 0.062 | 1 | yes | insufficient_coins |
| 35 | loadtest_fan_16@loadtest90.local | 90 | 2026-04-21T11:05:38.187Z | 2026-04-21T11:14:31.441Z | 533.254 | 0.079 | 1 | yes | insufficient_coins |
| 36 | loadtest_fan_17@loadtest90.local | 90 | 2026-04-21T11:05:38.434Z | 2026-04-21T11:14:31.927Z | 533.493 | 0.160 | 1 | yes | insufficient_coins |
| 37 | loadtest_fan_18@loadtest90.local | 90 | 2026-04-21T11:05:38.225Z | 2026-04-21T11:14:31.612Z | 533.387 | 0.054 | 1 | yes | insufficient_coins |
| 38 | loadtest_fan_19@loadtest90.local | 90 | 2026-04-21T11:05:38.432Z | 2026-04-21T11:14:32.237Z | 533.805 | 0.472 | 1 | yes | insufficient_coins |
| 39 | loadtest_fan_20@loadtest90.local | 90 | 2026-04-21T11:05:38.240Z | 2026-04-21T11:14:31.611Z | 533.371 | 0.038 | 1 | yes | insufficient_coins |
| 40 | loadtest_fan_1@loadtest120.local | 120 | 2026-04-21T11:05:37.989Z | 2026-04-21T11:12:17.985Z | 399.996 | 0.004 | 1 | yes | insufficient_coins |
| 41 | loadtest_fan_2@loadtest120.local | 120 | 2026-04-21T11:05:38.185Z | 2026-04-21T11:12:18.605Z | 400.420 | 0.420 | 1 | yes | insufficient_coins |
| 42 | loadtest_fan_3@loadtest120.local | 120 | 2026-04-21T11:05:38.440Z | 2026-04-21T11:12:18.605Z | 400.165 | 0.165 | 1 | yes | insufficient_coins |
| 43 | loadtest_fan_4@loadtest120.local | 120 | 2026-04-21T11:05:38.298Z | 2026-04-21T11:12:18.604Z | 400.306 | 0.306 | 1 | yes | insufficient_coins |
| 44 | loadtest_fan_5@loadtest120.local | 120 | 2026-04-21T11:05:38.307Z | 2026-04-21T11:12:18.604Z | 400.297 | 0.297 | 1 | yes | insufficient_coins |
| 45 | loadtest_fan_6@loadtest120.local | 120 | 2026-04-21T11:05:38.442Z | 2026-04-21T11:12:18.605Z | 400.163 | 0.163 | 1 | yes | insufficient_coins |
| 46 | loadtest_fan_7@loadtest120.local | 120 | 2026-04-21T11:05:38.000Z | 2026-04-21T11:12:17.985Z | 399.985 | 0.015 | 1 | yes | insufficient_coins |
| 47 | loadtest_fan_8@loadtest120.local | 120 | 2026-04-21T11:05:37.982Z | 2026-04-21T11:12:17.976Z | 399.994 | 0.006 | 1 | yes | insufficient_coins |
| 48 | loadtest_fan_9@loadtest120.local | 120 | 2026-04-21T11:05:38.436Z | 2026-04-21T11:12:18.916Z | 400.480 | 0.480 | 1 | yes | insufficient_coins |
| 49 | loadtest_fan_10@loadtest120.local | 120 | 2026-04-21T11:05:38.280Z | 2026-04-21T11:12:18.603Z | 400.323 | 0.323 | 1 | yes | insufficient_coins |
| 50 | loadtest_fan_11@loadtest120.local | 120 | 2026-04-21T11:05:38.284Z | 2026-04-21T11:12:18.604Z | 400.320 | 0.320 | 1 | yes | insufficient_coins |
| 51 | loadtest_fan_12@loadtest120.local | 120 | 2026-04-21T11:05:38.236Z | 2026-04-21T11:12:18.290Z | 400.054 | 0.054 | 1 | yes | insufficient_coins |
| 52 | loadtest_fan_13@loadtest120.local | 120 | 2026-04-21T11:05:38.163Z | 2026-04-21T11:12:17.985Z | 399.822 | 0.178 | 1 | yes | insufficient_coins |
| 53 | loadtest_fan_14@loadtest120.local | 120 | 2026-04-21T11:05:37.992Z | 2026-04-21T11:12:17.985Z | 399.993 | 0.007 | 1 | yes | insufficient_coins |
| 54 | loadtest_fan_15@loadtest120.local | 120 | 2026-04-21T11:05:38.301Z | 2026-04-21T11:12:18.605Z | 400.304 | 0.304 | 1 | yes | insufficient_coins |
| 55 | loadtest_fan_16@loadtest120.local | 120 | 2026-04-21T11:05:38.430Z | 2026-04-21T11:12:18.605Z | 400.175 | 0.175 | 1 | yes | insufficient_coins |
| 56 | loadtest_fan_17@loadtest120.local | 120 | 2026-04-21T11:05:38.237Z | 2026-04-21T11:12:18.291Z | 400.054 | 0.054 | 1 | yes | insufficient_coins |
| 57 | loadtest_fan_18@loadtest120.local | 120 | 2026-04-21T11:05:38.192Z | 2026-04-21T11:12:17.986Z | 399.794 | 0.206 | 1 | yes | insufficient_coins |
| 58 | loadtest_fan_19@loadtest120.local | 120 | 2026-04-21T11:05:38.293Z | 2026-04-21T11:12:18.604Z | 400.311 | 0.311 | 1 | yes | insufficient_coins |
| 59 | loadtest_fan_20@loadtest120.local | 120 | 2026-04-21T11:05:38.200Z | 2026-04-21T11:12:17.986Z | 399.786 | 0.214 | 1 | yes | insufficient_coins |

## 7. Per-session detail (each user)

### loadtest_fan_1@loadtest60.local

- **Creator price:** 60 coins/min
- **Expected duration (approx):** 800.000 s
- **Actual duration:** 800.397 s
- **Skew vs expected:** 0.397 s
- **billingRestStartedAt:** 2026-04-21T11:05:38.221Z
- **forceEndAt:** 2026-04-21T11:18:58.618Z
- **remainingCoins (payload):** 0
- **Auto-ended (insufficient_coins):** yes

### loadtest_fan_2@loadtest60.local

- **Creator price:** 60 coins/min
- **Expected duration (approx):** 800.000 s
- **Actual duration:** 800.112 s
- **Skew vs expected:** 0.112 s
- **billingRestStartedAt:** 2026-04-21T11:05:38.194Z
- **forceEndAt:** 2026-04-21T11:18:58.306Z
- **remainingCoins (payload):** 0
- **Auto-ended (insufficient_coins):** yes

### loadtest_fan_3@loadtest60.local

- **Creator price:** 60 coins/min
- **Expected duration (approx):** 800.000 s
- **Actual duration:** 800.348 s
- **Skew vs expected:** 0.348 s
- **billingRestStartedAt:** 2026-04-21T11:05:38.271Z
- **forceEndAt:** 2026-04-21T11:18:58.619Z
- **remainingCoins (payload):** 0
- **Auto-ended (insufficient_coins):** yes

### loadtest_fan_4@loadtest60.local

- **Creator price:** 60 coins/min
- **Expected duration (approx):** 800.000 s
- **Actual duration:** 800.152 s
- **Skew vs expected:** 0.152 s
- **billingRestStartedAt:** 2026-04-21T11:05:39.399Z
- **forceEndAt:** 2026-04-21T11:18:59.551Z
- **remainingCoins (payload):** 0
- **Auto-ended (insufficient_coins):** yes

### loadtest_fan_5@loadtest60.local

- **Creator price:** 60 coins/min
- **Expected duration (approx):** 800.000 s
- **Actual duration:** 800.029 s
- **Skew vs expected:** 0.029 s
- **billingRestStartedAt:** 2026-04-21T11:05:38.278Z
- **forceEndAt:** 2026-04-21T11:18:58.307Z
- **remainingCoins (payload):** 0
- **Auto-ended (insufficient_coins):** yes

### loadtest_fan_6@loadtest60.local

- **Creator price:** 60 coins/min
- **Expected duration (approx):** 800.000 s
- **Actual duration:** 800.357 s
- **Skew vs expected:** 0.357 s
- **billingRestStartedAt:** 2026-04-21T11:05:37.950Z
- **forceEndAt:** 2026-04-21T11:18:58.307Z
- **remainingCoins (payload):** 0
- **Auto-ended (insufficient_coins):** yes

### loadtest_fan_7@loadtest60.local

- **Creator price:** 60 coins/min
- **Expected duration (approx):** 800.000 s
- **Actual duration:** 800.755 s
- **Skew vs expected:** 0.755 s
- **billingRestStartedAt:** 2026-04-21T11:05:38.177Z
- **forceEndAt:** 2026-04-21T11:18:58.932Z
- **remainingCoins (payload):** 0
- **Auto-ended (insufficient_coins):** yes

### loadtest_fan_8@loadtest60.local

- **Creator price:** 60 coins/min
- **Expected duration (approx):** 800.000 s
- **Actual duration:** 800.411 s
- **Skew vs expected:** 0.411 s
- **billingRestStartedAt:** 2026-04-21T11:05:38.207Z
- **forceEndAt:** 2026-04-21T11:18:58.618Z
- **remainingCoins (payload):** 0
- **Auto-ended (insufficient_coins):** yes

### loadtest_fan_9@loadtest60.local

- **Creator price:** 60 coins/min
- **Expected duration (approx):** 800.000 s
- **Actual duration:** 800.205 s
- **Skew vs expected:** 0.205 s
- **billingRestStartedAt:** 2026-04-21T11:05:40.286Z
- **forceEndAt:** 2026-04-21T11:19:00.491Z
- **remainingCoins (payload):** 0
- **Auto-ended (insufficient_coins):** yes

### loadtest_fan_10@loadtest60.local

- **Creator price:** 60 coins/min
- **Expected duration (approx):** 800.000 s
- **Actual duration:** 799.879 s
- **Skew vs expected:** 0.121 s
- **billingRestStartedAt:** 2026-04-21T11:05:38.428Z
- **forceEndAt:** 2026-04-21T11:18:58.307Z
- **remainingCoins (payload):** 0
- **Auto-ended (insufficient_coins):** yes

### loadtest_fan_11@loadtest60.local

- **Creator price:** 60 coins/min
- **Expected duration (approx):** 800.000 s
- **Actual duration:** 800.016 s
- **Skew vs expected:** 0.016 s
- **billingRestStartedAt:** 2026-04-21T11:05:38.291Z
- **forceEndAt:** 2026-04-21T11:18:58.307Z
- **remainingCoins (payload):** 0
- **Auto-ended (insufficient_coins):** yes

### loadtest_fan_12@loadtest60.local

- **Creator price:** 60 coins/min
- **Expected duration (approx):** 800.000 s
- **Actual duration:** 800.493 s
- **Skew vs expected:** 0.493 s
- **billingRestStartedAt:** 2026-04-21T11:05:38.438Z
- **forceEndAt:** 2026-04-21T11:18:58.931Z
- **remainingCoins (payload):** 0
- **Auto-ended (insufficient_coins):** yes

### loadtest_fan_13@loadtest60.local

- **Creator price:** 60 coins/min
- **Expected duration (approx):** 800.000 s
- **Actual duration:** 800.363 s
- **Skew vs expected:** 0.363 s
- **billingRestStartedAt:** 2026-04-21T11:05:37.944Z
- **forceEndAt:** 2026-04-21T11:18:58.307Z
- **remainingCoins (payload):** 0
- **Auto-ended (insufficient_coins):** yes

### loadtest_fan_14@loadtest60.local

- **Creator price:** 60 coins/min
- **Expected duration (approx):** 800.000 s
- **Actual duration:** 800.343 s
- **Skew vs expected:** 0.343 s
- **billingRestStartedAt:** 2026-04-21T11:05:37.963Z
- **forceEndAt:** 2026-04-21T11:18:58.306Z
- **remainingCoins (payload):** 0
- **Auto-ended (insufficient_coins):** yes

### loadtest_fan_15@loadtest60.local

- **Creator price:** 60 coins/min
- **Expected duration (approx):** 800.000 s
- **Actual duration:** 800.351 s
- **Skew vs expected:** 0.351 s
- **billingRestStartedAt:** 2026-04-21T11:05:38.268Z
- **forceEndAt:** 2026-04-21T11:18:58.619Z
- **remainingCoins (payload):** 0
- **Auto-ended (insufficient_coins):** yes

### loadtest_fan_16@loadtest60.local

- **Creator price:** 60 coins/min
- **Expected duration (approx):** 800.000 s
- **Actual duration:** 800.355 s
- **Skew vs expected:** 0.355 s
- **billingRestStartedAt:** 2026-04-21T11:05:37.952Z
- **forceEndAt:** 2026-04-21T11:18:58.307Z
- **remainingCoins (payload):** 0
- **Auto-ended (insufficient_coins):** yes

### loadtest_fan_17@loadtest60.local

- **Creator price:** 60 coins/min
- **Expected duration (approx):** 800.000 s
- **Actual duration:** 800.575 s
- **Skew vs expected:** 0.575 s
- **billingRestStartedAt:** 2026-04-21T11:05:38.357Z
- **forceEndAt:** 2026-04-21T11:18:58.932Z
- **remainingCoins (payload):** 0
- **Auto-ended (insufficient_coins):** yes

### loadtest_fan_18@loadtest60.local

- **Creator price:** 60 coins/min
- **Expected duration (approx):** 800.000 s
- **Actual duration:** 800.134 s
- **Skew vs expected:** 0.134 s
- **billingRestStartedAt:** 2026-04-21T11:05:38.172Z
- **forceEndAt:** 2026-04-21T11:18:58.306Z
- **remainingCoins (payload):** 0
- **Auto-ended (insufficient_coins):** yes

### loadtest_fan_19@loadtest60.local

- **Creator price:** 60 coins/min
- **Expected duration (approx):** 800.000 s
- **Actual duration:** 799.872 s
- **Skew vs expected:** 0.128 s
- **billingRestStartedAt:** 2026-04-21T11:05:38.435Z
- **forceEndAt:** 2026-04-21T11:18:58.307Z
- **remainingCoins (payload):** 0
- **Auto-ended (insufficient_coins):** yes

### loadtest_fan_20@loadtest60.local

- **Creator price:** 60 coins/min
- **Expected duration (approx):** 800.000 s
- **Actual duration:** 800.425 s
- **Skew vs expected:** 0.425 s
- **billingRestStartedAt:** 2026-04-21T11:05:38.506Z
- **forceEndAt:** 2026-04-21T11:18:58.931Z
- **remainingCoins (payload):** 0
- **Auto-ended (insufficient_coins):** yes

### loadtest_fan_1@loadtest90.local

- **Creator price:** 90 coins/min
- **Expected duration (approx):** 533.333 s
- **Actual duration:** 533.392 s
- **Skew vs expected:** 0.059 s
- **billingRestStartedAt:** 2026-04-21T11:05:38.220Z
- **forceEndAt:** 2026-04-21T11:14:31.612Z
- **remainingCoins (payload):** 1
- **Auto-ended (insufficient_coins):** yes

### loadtest_fan_2@loadtest90.local

- **Creator price:** 90 coins/min
- **Expected duration (approx):** 533.333 s
- **Actual duration:** 533.638 s
- **Skew vs expected:** 0.305 s
- **billingRestStartedAt:** 2026-04-21T11:05:38.289Z
- **forceEndAt:** 2026-04-21T11:14:31.927Z
- **remainingCoins (payload):** 1
- **Auto-ended (insufficient_coins):** yes

### loadtest_fan_3@loadtest90.local

- **Creator price:** 90 coins/min
- **Expected duration (approx):** 533.333 s
- **Actual duration:** 533.640 s
- **Skew vs expected:** 0.307 s
- **billingRestStartedAt:** 2026-04-21T11:05:38.287Z
- **forceEndAt:** 2026-04-21T11:14:31.927Z
- **remainingCoins (payload):** 1
- **Auto-ended (insufficient_coins):** yes

### loadtest_fan_4@loadtest90.local

- **Creator price:** 90 coins/min
- **Expected duration (approx):** 533.333 s
- **Actual duration:** 533.342 s
- **Skew vs expected:** 0.009 s
- **billingRestStartedAt:** 2026-04-21T11:05:37.956Z
- **forceEndAt:** 2026-04-21T11:14:31.298Z
- **remainingCoins (payload):** 1
- **Auto-ended (insufficient_coins):** yes

### loadtest_fan_5@loadtest90.local

- **Creator price:** 90 coins/min
- **Expected duration (approx):** 533.333 s
- **Actual duration:** 533.410 s
- **Skew vs expected:** 0.077 s
- **billingRestStartedAt:** 2026-04-21T11:05:38.202Z
- **forceEndAt:** 2026-04-21T11:14:31.612Z
- **remainingCoins (payload):** 1
- **Auto-ended (insufficient_coins):** yes

### loadtest_fan_6@loadtest90.local

- **Creator price:** 90 coins/min
- **Expected duration (approx):** 533.333 s
- **Actual duration:** 533.130 s
- **Skew vs expected:** 0.203 s
- **billingRestStartedAt:** 2026-04-21T11:05:38.169Z
- **forceEndAt:** 2026-04-21T11:14:31.299Z
- **remainingCoins (payload):** 1
- **Auto-ended (insufficient_coins):** yes

### loadtest_fan_7@loadtest90.local

- **Creator price:** 90 coins/min
- **Expected duration (approx):** 533.333 s
- **Actual duration:** 533.252 s
- **Skew vs expected:** 0.081 s
- **billingRestStartedAt:** 2026-04-21T11:05:38.190Z
- **forceEndAt:** 2026-04-21T11:14:31.442Z
- **remainingCoins (payload):** 1
- **Auto-ended (insufficient_coins):** yes

### loadtest_fan_8@loadtest90.local

- **Creator price:** 90 coins/min
- **Expected duration (approx):** 533.333 s
- **Actual duration:** 533.374 s
- **Skew vs expected:** 0.041 s
- **billingRestStartedAt:** 2026-04-21T11:05:38.238Z
- **forceEndAt:** 2026-04-21T11:14:31.612Z
- **remainingCoins (payload):** 1
- **Auto-ended (insufficient_coins):** yes

### loadtest_fan_9@loadtest90.local

- **Creator price:** 90 coins/min
- **Expected duration (approx):** 533.333 s
- **Actual duration:** 533.655 s
- **Skew vs expected:** 0.322 s
- **billingRestStartedAt:** 2026-04-21T11:05:38.272Z
- **forceEndAt:** 2026-04-21T11:14:31.927Z
- **remainingCoins (payload):** 1
- **Auto-ended (insufficient_coins):** yes

### loadtest_fan_10@loadtest90.local

- **Creator price:** 90 coins/min
- **Expected duration (approx):** 533.333 s
- **Actual duration:** 533.289 s
- **Skew vs expected:** 0.044 s
- **billingRestStartedAt:** 2026-04-21T11:05:38.009Z
- **forceEndAt:** 2026-04-21T11:14:31.298Z
- **remainingCoins (payload):** 1
- **Auto-ended (insufficient_coins):** yes

### loadtest_fan_11@loadtest90.local

- **Creator price:** 90 coins/min
- **Expected duration (approx):** 533.333 s
- **Actual duration:** 533.253 s
- **Skew vs expected:** 0.080 s
- **billingRestStartedAt:** 2026-04-21T11:05:38.188Z
- **forceEndAt:** 2026-04-21T11:14:31.441Z
- **remainingCoins (payload):** 1
- **Auto-ended (insufficient_coins):** yes

### loadtest_fan_12@loadtest90.local

- **Creator price:** 90 coins/min
- **Expected duration (approx):** 533.333 s
- **Actual duration:** 533.343 s
- **Skew vs expected:** 0.010 s
- **billingRestStartedAt:** 2026-04-21T11:05:38.269Z
- **forceEndAt:** 2026-04-21T11:14:31.612Z
- **remainingCoins (payload):** 1
- **Auto-ended (insufficient_coins):** yes

### loadtest_fan_13@loadtest90.local

- **Creator price:** 90 coins/min
- **Expected duration (approx):** 533.333 s
- **Actual duration:** 533.652 s
- **Skew vs expected:** 0.319 s
- **billingRestStartedAt:** 2026-04-21T11:05:38.274Z
- **forceEndAt:** 2026-04-21T11:14:31.926Z
- **remainingCoins (payload):** 1
- **Auto-ended (insufficient_coins):** yes

### loadtest_fan_14@loadtest90.local

- **Creator price:** 90 coins/min
- **Expected duration (approx):** 533.333 s
- **Actual duration:** 533.624 s
- **Skew vs expected:** 0.291 s
- **billingRestStartedAt:** 2026-04-21T11:05:38.303Z
- **forceEndAt:** 2026-04-21T11:14:31.927Z
- **remainingCoins (payload):** 1
- **Auto-ended (insufficient_coins):** yes

### loadtest_fan_15@loadtest90.local

- **Creator price:** 90 coins/min
- **Expected duration (approx):** 533.333 s
- **Actual duration:** 533.271 s
- **Skew vs expected:** 0.062 s
- **billingRestStartedAt:** 2026-04-21T11:05:38.170Z
- **forceEndAt:** 2026-04-21T11:14:31.441Z
- **remainingCoins (payload):** 1
- **Auto-ended (insufficient_coins):** yes

### loadtest_fan_16@loadtest90.local

- **Creator price:** 90 coins/min
- **Expected duration (approx):** 533.333 s
- **Actual duration:** 533.254 s
- **Skew vs expected:** 0.079 s
- **billingRestStartedAt:** 2026-04-21T11:05:38.187Z
- **forceEndAt:** 2026-04-21T11:14:31.441Z
- **remainingCoins (payload):** 1
- **Auto-ended (insufficient_coins):** yes

### loadtest_fan_17@loadtest90.local

- **Creator price:** 90 coins/min
- **Expected duration (approx):** 533.333 s
- **Actual duration:** 533.493 s
- **Skew vs expected:** 0.160 s
- **billingRestStartedAt:** 2026-04-21T11:05:38.434Z
- **forceEndAt:** 2026-04-21T11:14:31.927Z
- **remainingCoins (payload):** 1
- **Auto-ended (insufficient_coins):** yes

### loadtest_fan_18@loadtest90.local

- **Creator price:** 90 coins/min
- **Expected duration (approx):** 533.333 s
- **Actual duration:** 533.387 s
- **Skew vs expected:** 0.054 s
- **billingRestStartedAt:** 2026-04-21T11:05:38.225Z
- **forceEndAt:** 2026-04-21T11:14:31.612Z
- **remainingCoins (payload):** 1
- **Auto-ended (insufficient_coins):** yes

### loadtest_fan_19@loadtest90.local

- **Creator price:** 90 coins/min
- **Expected duration (approx):** 533.333 s
- **Actual duration:** 533.805 s
- **Skew vs expected:** 0.472 s
- **billingRestStartedAt:** 2026-04-21T11:05:38.432Z
- **forceEndAt:** 2026-04-21T11:14:32.237Z
- **remainingCoins (payload):** 1
- **Auto-ended (insufficient_coins):** yes

### loadtest_fan_20@loadtest90.local

- **Creator price:** 90 coins/min
- **Expected duration (approx):** 533.333 s
- **Actual duration:** 533.371 s
- **Skew vs expected:** 0.038 s
- **billingRestStartedAt:** 2026-04-21T11:05:38.240Z
- **forceEndAt:** 2026-04-21T11:14:31.611Z
- **remainingCoins (payload):** 1
- **Auto-ended (insufficient_coins):** yes

### loadtest_fan_1@loadtest120.local

- **Creator price:** 120 coins/min
- **Expected duration (approx):** 400.000 s
- **Actual duration:** 399.996 s
- **Skew vs expected:** 0.004 s
- **billingRestStartedAt:** 2026-04-21T11:05:37.989Z
- **forceEndAt:** 2026-04-21T11:12:17.985Z
- **remainingCoins (payload):** 1
- **Auto-ended (insufficient_coins):** yes

### loadtest_fan_2@loadtest120.local

- **Creator price:** 120 coins/min
- **Expected duration (approx):** 400.000 s
- **Actual duration:** 400.420 s
- **Skew vs expected:** 0.420 s
- **billingRestStartedAt:** 2026-04-21T11:05:38.185Z
- **forceEndAt:** 2026-04-21T11:12:18.605Z
- **remainingCoins (payload):** 1
- **Auto-ended (insufficient_coins):** yes

### loadtest_fan_3@loadtest120.local

- **Creator price:** 120 coins/min
- **Expected duration (approx):** 400.000 s
- **Actual duration:** 400.165 s
- **Skew vs expected:** 0.165 s
- **billingRestStartedAt:** 2026-04-21T11:05:38.440Z
- **forceEndAt:** 2026-04-21T11:12:18.605Z
- **remainingCoins (payload):** 1
- **Auto-ended (insufficient_coins):** yes

### loadtest_fan_4@loadtest120.local

- **Creator price:** 120 coins/min
- **Expected duration (approx):** 400.000 s
- **Actual duration:** 400.306 s
- **Skew vs expected:** 0.306 s
- **billingRestStartedAt:** 2026-04-21T11:05:38.298Z
- **forceEndAt:** 2026-04-21T11:12:18.604Z
- **remainingCoins (payload):** 1
- **Auto-ended (insufficient_coins):** yes

### loadtest_fan_5@loadtest120.local

- **Creator price:** 120 coins/min
- **Expected duration (approx):** 400.000 s
- **Actual duration:** 400.297 s
- **Skew vs expected:** 0.297 s
- **billingRestStartedAt:** 2026-04-21T11:05:38.307Z
- **forceEndAt:** 2026-04-21T11:12:18.604Z
- **remainingCoins (payload):** 1
- **Auto-ended (insufficient_coins):** yes

### loadtest_fan_6@loadtest120.local

- **Creator price:** 120 coins/min
- **Expected duration (approx):** 400.000 s
- **Actual duration:** 400.163 s
- **Skew vs expected:** 0.163 s
- **billingRestStartedAt:** 2026-04-21T11:05:38.442Z
- **forceEndAt:** 2026-04-21T11:12:18.605Z
- **remainingCoins (payload):** 1
- **Auto-ended (insufficient_coins):** yes

### loadtest_fan_7@loadtest120.local

- **Creator price:** 120 coins/min
- **Expected duration (approx):** 400.000 s
- **Actual duration:** 399.985 s
- **Skew vs expected:** 0.015 s
- **billingRestStartedAt:** 2026-04-21T11:05:38.000Z
- **forceEndAt:** 2026-04-21T11:12:17.985Z
- **remainingCoins (payload):** 1
- **Auto-ended (insufficient_coins):** yes

### loadtest_fan_8@loadtest120.local

- **Creator price:** 120 coins/min
- **Expected duration (approx):** 400.000 s
- **Actual duration:** 399.994 s
- **Skew vs expected:** 0.006 s
- **billingRestStartedAt:** 2026-04-21T11:05:37.982Z
- **forceEndAt:** 2026-04-21T11:12:17.976Z
- **remainingCoins (payload):** 1
- **Auto-ended (insufficient_coins):** yes

### loadtest_fan_9@loadtest120.local

- **Creator price:** 120 coins/min
- **Expected duration (approx):** 400.000 s
- **Actual duration:** 400.480 s
- **Skew vs expected:** 0.480 s
- **billingRestStartedAt:** 2026-04-21T11:05:38.436Z
- **forceEndAt:** 2026-04-21T11:12:18.916Z
- **remainingCoins (payload):** 1
- **Auto-ended (insufficient_coins):** yes

### loadtest_fan_10@loadtest120.local

- **Creator price:** 120 coins/min
- **Expected duration (approx):** 400.000 s
- **Actual duration:** 400.323 s
- **Skew vs expected:** 0.323 s
- **billingRestStartedAt:** 2026-04-21T11:05:38.280Z
- **forceEndAt:** 2026-04-21T11:12:18.603Z
- **remainingCoins (payload):** 1
- **Auto-ended (insufficient_coins):** yes

### loadtest_fan_11@loadtest120.local

- **Creator price:** 120 coins/min
- **Expected duration (approx):** 400.000 s
- **Actual duration:** 400.320 s
- **Skew vs expected:** 0.320 s
- **billingRestStartedAt:** 2026-04-21T11:05:38.284Z
- **forceEndAt:** 2026-04-21T11:12:18.604Z
- **remainingCoins (payload):** 1
- **Auto-ended (insufficient_coins):** yes

### loadtest_fan_12@loadtest120.local

- **Creator price:** 120 coins/min
- **Expected duration (approx):** 400.000 s
- **Actual duration:** 400.054 s
- **Skew vs expected:** 0.054 s
- **billingRestStartedAt:** 2026-04-21T11:05:38.236Z
- **forceEndAt:** 2026-04-21T11:12:18.290Z
- **remainingCoins (payload):** 1
- **Auto-ended (insufficient_coins):** yes

### loadtest_fan_13@loadtest120.local

- **Creator price:** 120 coins/min
- **Expected duration (approx):** 400.000 s
- **Actual duration:** 399.822 s
- **Skew vs expected:** 0.178 s
- **billingRestStartedAt:** 2026-04-21T11:05:38.163Z
- **forceEndAt:** 2026-04-21T11:12:17.985Z
- **remainingCoins (payload):** 1
- **Auto-ended (insufficient_coins):** yes

### loadtest_fan_14@loadtest120.local

- **Creator price:** 120 coins/min
- **Expected duration (approx):** 400.000 s
- **Actual duration:** 399.993 s
- **Skew vs expected:** 0.007 s
- **billingRestStartedAt:** 2026-04-21T11:05:37.992Z
- **forceEndAt:** 2026-04-21T11:12:17.985Z
- **remainingCoins (payload):** 1
- **Auto-ended (insufficient_coins):** yes

### loadtest_fan_15@loadtest120.local

- **Creator price:** 120 coins/min
- **Expected duration (approx):** 400.000 s
- **Actual duration:** 400.304 s
- **Skew vs expected:** 0.304 s
- **billingRestStartedAt:** 2026-04-21T11:05:38.301Z
- **forceEndAt:** 2026-04-21T11:12:18.605Z
- **remainingCoins (payload):** 1
- **Auto-ended (insufficient_coins):** yes

### loadtest_fan_16@loadtest120.local

- **Creator price:** 120 coins/min
- **Expected duration (approx):** 400.000 s
- **Actual duration:** 400.175 s
- **Skew vs expected:** 0.175 s
- **billingRestStartedAt:** 2026-04-21T11:05:38.430Z
- **forceEndAt:** 2026-04-21T11:12:18.605Z
- **remainingCoins (payload):** 1
- **Auto-ended (insufficient_coins):** yes

### loadtest_fan_17@loadtest120.local

- **Creator price:** 120 coins/min
- **Expected duration (approx):** 400.000 s
- **Actual duration:** 400.054 s
- **Skew vs expected:** 0.054 s
- **billingRestStartedAt:** 2026-04-21T11:05:38.237Z
- **forceEndAt:** 2026-04-21T11:12:18.291Z
- **remainingCoins (payload):** 1
- **Auto-ended (insufficient_coins):** yes

### loadtest_fan_18@loadtest120.local

- **Creator price:** 120 coins/min
- **Expected duration (approx):** 400.000 s
- **Actual duration:** 399.794 s
- **Skew vs expected:** 0.206 s
- **billingRestStartedAt:** 2026-04-21T11:05:38.192Z
- **forceEndAt:** 2026-04-21T11:12:17.986Z
- **remainingCoins (payload):** 1
- **Auto-ended (insufficient_coins):** yes

### loadtest_fan_19@loadtest120.local

- **Creator price:** 120 coins/min
- **Expected duration (approx):** 400.000 s
- **Actual duration:** 400.311 s
- **Skew vs expected:** 0.311 s
- **billingRestStartedAt:** 2026-04-21T11:05:38.293Z
- **forceEndAt:** 2026-04-21T11:12:18.604Z
- **remainingCoins (payload):** 1
- **Auto-ended (insufficient_coins):** yes

### loadtest_fan_20@loadtest120.local

- **Creator price:** 120 coins/min
- **Expected duration (approx):** 400.000 s
- **Actual duration:** 399.786 s
- **Skew vs expected:** 0.214 s
- **billingRestStartedAt:** 2026-04-21T11:05:38.200Z
- **forceEndAt:** 2026-04-21T11:12:17.986Z
- **remainingCoins (payload):** 1
- **Auto-ended (insufficient_coins):** yes


## 8. Interpretation

- **Stable billing under load:** If all rows show **yes** and per-tier durations cluster near each tier’s expected wall time, concurrent billing ticks and `forceTerminateCall` are keeping up for this scenario.
- **Auto-end:** `insufficient_coins` on `call:force-end` indicates the server terminated the billable session when the wallet could not fund the next second — aligned with product “call ends when user runs out of coins.”
- **Failures / timeouts:** Increase `FORCE_END_TEST_MAX_WAIT_MS`, verify Redis/Mongo/BullMQ, ensure pairs JSON `creatorPricePerMinute` and `SEED_FAN_COINS` match the seeded data, and check server CPU.

---
_Report produced automatically by `socket-force-end-test.mjs`._
