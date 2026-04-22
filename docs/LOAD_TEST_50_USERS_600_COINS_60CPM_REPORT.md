# Load test: concurrent billing until coin exhaustion

**Generated:** 2026-04-18T20:37:34.558Z  
**Harness:** `scripts/load-test/socket-force-end-test.mjs` (multi mode)  
**JSON:** `scripts/load-test/force-end-multi-results-2026-04-18T20-37-34-558Z.json`

## 0. Executive summary (answers to your questions)

### Was the “video call” stable?

This run does **not** carry real WebRTC video; it exercises **billing + Socket.IO** the same way the app does for session lifecycle (50 concurrent billable calls, distinct fan/creator pairs). On that dimension the system behaved **stably**:

- **50 / 50** sessions completed without timeout or HTTP/socket errors after billing started.
- Measured billed-session duration stayed in a **tight band** (about **600.77 s–602.23 s** wall time from `call-started` to `call:force-end`), with **standard deviation ~0.48 s** across 50 parallel calls.
- **Interpretation:** Under 50-way concurrent load, tick scheduling and `forceTerminateCall` kept up; no evidence of runaway drift or stuck sessions in this harness.

For **actual video** stability (frames, reconnects, Stream), run separate tests with real clients or Stream monitoring.

### How long was each call?

| Measure | Seconds | Minutes (approx.) |
|---------|---------|-------------------|
| Expected (600 coins at 60 coins/min) | 600 | 10.0 |
| **Mean** observed | **601.62** | **~10.03** |
| **Median** | **601.35** | **~10.02** |
| **Min** | 600.77 | ~10.01 |
| **Max** | 602.23 | ~10.04 |

So each simulated call ran **about ten minutes** until the wallet was exhausted, with roughly **±2 s** variation versus the nominal 600 s (tick quantization and concurrent batch processing).

### Did the call automatically end when user coins reached zero?

**Yes.** Every session ended with Socket.IO `call:force-end` and payload reason **`insufficient_coins`**, and **`remainingCoins: 0`** in the captured payloads. The harness **does not** call `POST /billing/call-ended`; termination was driven entirely by the server when the balance could not fund the next second—matching the product rule for auto-ending a billable call when coins run out.

### Environment notes (this run)

- **Seed:** `SEED_COUNT=50`, `SEED_FAN_COINS=600`, `SEED_CREATOR_PRICE=60` → output `scripts/load-test/pairs.generated.json`.
- **API:** `BASE_URL=http://127.0.0.1:3000`.
- **Redis:** Local dev required **`REDIS_URL`** pointing at a reachable Redis (e.g. `REDIS_PUBLIC_URL` from Railway); the default `redis.railway.internal` hostname does not resolve on a desktop—without a public Redis URL, `call-started` can return HTTP 500.
- **Wall-clock runtime of the test command:** ~**604 s** (~10 min 4 s) for all 50 sessions in parallel (longest call dominates).

---

## 1. Configuration

| Parameter | Value |
|-----------|--------|
| Concurrent fan sessions | 50 |
| Fan coins (seed) | 600 |
| Creator price (coins/min) | 60 |
| Expected time to wallet exhaustion | ~600.0 s (~10.00 min) |
| Billing end condition | Server emits `call:force-end` with `reason: insufficient_coins` (no client `call-ended`) |
| BASE_URL | http://127.0.0.1:3000 |

## 2. Scope (what this proves)

- **Proves:** Concurrent **billing + Socket.IO** behavior: each fan starts one billable session; the server drains the seeded wallet at the creator rate until balance cannot cover the next second, then emits `call:force-end`.
- **Does not prove:** WebRTC video stability, packet loss, or Stream video quality — there is no real media in this harness. Treat “call stability” below as **billing/socket/session** stability; production video should be validated separately (e.g. real devices + Stream dashboards).

## 3. Overall outcome

**All sessions auto-ended on zero coins (socket signal):** **YES** — every fan received `call:force-end` / `insufficient_coins` within the wait budget.

## 4. Duration statistics (successful sessions only)

| Metric | Value (seconds) |
|--------|-----------------|
| Count | 50 |
| Min | 600.770 |
| Max | 602.226 |
| Mean | 601.616 |
| Median | 601.348 |
| Std dev | 0.480 |

Expected center: ~600.0 s (600 coins at 60 coins/min). Spread is mostly billing tick quantization (~default 450 ms) and concurrent load.

## 5. Per-session results

| Index | callId | Duration (s) | Skew vs expected (s) | Auto-ended | Notes |
|-------|--------|----------------|----------------------|------------|-------|
| 0 | E8uEv9lNjhZKxNrdbqw7SpegWxr1_69e3e84daa1dc9907bd2b40f_1776544051232 | 602.180 | 2.180 | yes | insufficient_coins |
| 1 | CjcPfk4amrUksUjCBdoJ8Krlu0G3_69e3e84faa1dc9907bd2b41a_1776544051345 | 601.339 | 1.339 | yes | insufficient_coins |
| 2 | w2T0pkM332c688Bh1SrFMetygzB2_69e3e851aa1dc9907bd2b425_1776544051345 | 602.223 | 2.223 | yes | insufficient_coins |
| 3 | YA0rMx9tteVy9vyvAF1UIq6sRlp1_69e3e853aa1dc9907bd2b430_1776544051345 | 601.288 | 1.288 | yes | insufficient_coins |
| 4 | 2WsZGt71FYQUDjJDaBVN8f4WJdB3_69e3e855aa1dc9907bd2b43b_1776544051345 | 602.175 | 2.175 | yes | insufficient_coins |
| 5 | 9cLa8EOfVQQ7fuETXjgjw3pGop12_69e3e857aa1dc9907bd2b446_1776544051345 | 602.168 | 2.168 | yes | insufficient_coins |
| 6 | 96YLazrKkjRcWLw2e0k5hRWv0E12_69e3e85aaa1dc9907bd2b451_1776544051345 | 601.363 | 1.363 | yes | insufficient_coins |
| 7 | wZfAYLXGqOYakqfZK8iyHT3tkaj2_69e3e85caa1dc9907bd2b45c_1776544051345 | 601.293 | 1.293 | yes | insufficient_coins |
| 8 | BywmwsvVe8alZOowzuHwiJBv3wz1_69e3e85eaa1dc9907bd2b467_1776544051345 | 600.770 | 0.770 | yes | insufficient_coins |
| 9 | Kt4WkyoX0megIklMUNiJJCT5xs13_69e3e860aa1dc9907bd2b472_1776544051345 | 601.271 | 1.271 | yes | insufficient_coins |
| 10 | 1KzGX6Ax6CW2qORjX9NTUiVR8eF2_69e3e862aa1dc9907bd2b47d_1776544051345 | 602.171 | 2.171 | yes | insufficient_coins |
| 11 | 79BlAZcyVTNXBNCHU1XRUJz1IDo1_69e3e864aa1dc9907bd2b488_1776544051345 | 601.275 | 1.275 | yes | insufficient_coins |
| 12 | ED5jcglisNOS2F62W6RykicfYLn2_69e3e867aa1dc9907bd2b493_1776544051345 | 602.170 | 2.170 | yes | insufficient_coins |
| 13 | VkEc5ulFAaMRNR8Fz8nikN6Byse2_69e3e869aa1dc9907bd2b49e_1776544051345 | 601.345 | 1.345 | yes | insufficient_coins |
| 14 | wzNU8xBSe4eam0u1heD06s76ENf1_69e3e86baa1dc9907bd2b4a9_1776544051345 | 602.167 | 2.167 | yes | insufficient_coins |
| 15 | km14c5s6vhQKvJEoX3Gtx0CZu9o1_69e3e86daa1dc9907bd2b4b4_1776544051345 | 601.273 | 1.273 | yes | insufficient_coins |
| 16 | pzUuInan3eOQDQPLrwzJw9b9Q2z2_69e3e86faa1dc9907bd2b4bf_1776544051345 | 601.344 | 1.344 | yes | insufficient_coins |
| 17 | vneqcoCrq9hKaxP8BI2OtlzBH2K2_69e3e872aa1dc9907bd2b4ca_1776544051345 | 601.298 | 1.298 | yes | insufficient_coins |
| 18 | HGSvvlqweiZKEP5fNqJW3VTPIE03_69e3e874aa1dc9907bd2b4d5_1776544051345 | 601.278 | 1.278 | yes | insufficient_coins |
| 19 | oTAJpzjEAbczY51xv62xnHzk06a2_69e3e876aa1dc9907bd2b4e0_1776544051345 | 601.360 | 1.360 | yes | insufficient_coins |
| 20 | MsxrtnBeoNdwatSHOxlSIfQpdha2_69e3e878aa1dc9907bd2b4eb_1776544051345 | 601.351 | 1.351 | yes | insufficient_coins |
| 21 | nAf3xKoMAXXzF7YuHPHhVIurO483_69e3e87aaa1dc9907bd2b4f6_1776544051345 | 602.161 | 2.161 | yes | insufficient_coins |
| 22 | 5qTz7YbqjXQwP9COU3Ov3eEMamk2_69e3e87caa1dc9907bd2b501_1776544051345 | 602.175 | 2.175 | yes | insufficient_coins |
| 23 | CPB0jemRtdX5VQkPs1ClQA5ufew1_69e3e87faa1dc9907bd2b50c_1776544051345 | 601.290 | 1.290 | yes | insufficient_coins |
| 24 | XwvojfiFQcN8oEATUvZOUmmjzwx2_69e3e881aa1dc9907bd2b517_1776544051345 | 602.173 | 2.173 | yes | insufficient_coins |
| 25 | 56E0EV7tRaRvwnCxQyNycafW3um1_69e3e883aa1dc9907bd2b522_1776544051345 | 601.368 | 1.368 | yes | insufficient_coins |
| 26 | ZZvhRF9s7DS4qwZbKgSgkTW7Blu1_69e3e885aa1dc9907bd2b52d_1776544051345 | 601.363 | 1.363 | yes | insufficient_coins |
| 27 | UEsn7n0LUchD0UZXtHhWqDCi55A3_69e3e887aa1dc9907bd2b538_1776544051345 | 602.182 | 2.182 | yes | insufficient_coins |
| 28 | hTdpz3gHCHc1NnPXccEWfb8V4a63_69e3e889aa1dc9907bd2b543_1776544051345 | 600.801 | 0.801 | yes | insufficient_coins |
| 29 | t62WjL6evzQMQpD5Sp4gPWP4ZKk2_69e3e88baa1dc9907bd2b54e_1776544051345 | 601.279 | 1.279 | yes | insufficient_coins |
| 30 | 3tTaqUrfEKhdeFhIje5L41I5S6d2_69e3e88daa1dc9907bd2b559_1776544051345 | 600.809 | 0.809 | yes | insufficient_coins |
| 31 | ZsJFRh6DIxZbEGgUj6ryX64eeyF3_69e3e890aa1dc9907bd2b564_1776544051345 | 601.277 | 1.277 | yes | insufficient_coins |
| 32 | Yjtks8RtXDZcEXr8iejqaiXbJtu2_69e3e892aa1dc9907bd2b56f_1776544051345 | 601.282 | 1.282 | yes | insufficient_coins |
| 33 | KnMe9Ro2MDUtl29WsBZNt7NYDc52_69e3e894aa1dc9907bd2b57a_1776544051345 | 602.163 | 2.163 | yes | insufficient_coins |
| 34 | 9QrLa9geF4YkpgDTtX6aspxsveU2_69e3e896aa1dc9907bd2b585_1776544051345 | 602.184 | 2.184 | yes | insufficient_coins |
| 35 | sJUICYk81cetqsRTu3ntMVdCMk82_69e3e898aa1dc9907bd2b590_1776544051345 | 602.166 | 2.166 | yes | insufficient_coins |
| 36 | xmFc9vfI6OfTBNSnfrI7I7G2rk93_69e3e89aaa1dc9907bd2b59b_1776544051345 | 601.274 | 1.274 | yes | insufficient_coins |
| 37 | vPMXr5QTmnUvMLZZNpqhuASMg2v2_69e3e89caa1dc9907bd2b5a6_1776544051345 | 602.164 | 2.164 | yes | insufficient_coins |
| 38 | ktLx30fymKTqsPjles5I6EsHQc03_69e3e89eaa1dc9907bd2b5b1_1776544051345 | 600.803 | 0.803 | yes | insufficient_coins |
| 39 | ANoudpnFkXMYPKz1EfBGz1Efbpw2_69e3e8a0aa1dc9907bd2b5bc_1776544051345 | 601.285 | 1.285 | yes | insufficient_coins |
| 40 | 0PUXAcU5DRglNTvtVMMN2SEYJV33_69e3e8a2aa1dc9907bd2b5c7_1776544051345 | 602.190 | 2.190 | yes | insufficient_coins |
| 41 | P19V7AlITHYGUl1LOeT2YP7pwbM2_69e3e8a4aa1dc9907bd2b5d2_1776544051345 | 601.306 | 1.306 | yes | insufficient_coins |
| 42 | Oern39uh6JXjoF1oUdb0dB3uRoU2_69e3e8a6aa1dc9907bd2b5dd_1776544051345 | 601.292 | 1.292 | yes | insufficient_coins |
| 43 | Zgb8z2FYOJMGykJsgXKb8cQfRTi2_69e3e8a8aa1dc9907bd2b5e8_1776544051345 | 602.226 | 2.226 | yes | insufficient_coins |
| 44 | Y3uJxI6uTYcyzAYJJaA3t2MsLyJ3_69e3e8aaaa1dc9907bd2b5f3_1776544051345 | 601.341 | 1.341 | yes | insufficient_coins |
| 45 | JTSbcfPZALOiXy6PoKuyimUQgYL2_69e3e8acaa1dc9907bd2b5fe_1776544051345 | 601.282 | 1.282 | yes | insufficient_coins |
| 46 | uaIpm6LEzMZGt23xZuATTAibJhd2_69e3e8afaa1dc9907bd2b609_1776544051345 | 602.183 | 2.183 | yes | insufficient_coins |
| 47 | hlIrp1g69qO4Kh5s4ut4qHvX7cA3_69e3e8b1aa1dc9907bd2b614_1776544051345 | 602.186 | 2.186 | yes | insufficient_coins |
| 48 | D4Nin5oJ9MUt1M5OgglUwBX1tr63_69e3e8b3aa1dc9907bd2b61f_1776544051345 | 601.295 | 1.295 | yes | insufficient_coins |
| 49 | 2CaWGHo5cBhvRkimiOZU966FLRq2_69e3e8b5aa1dc9907bd2b62a_1776544051345 | 602.177 | 2.177 | yes | insufficient_coins |

## 6. Interpretation

- **Stable billing under load:** If all rows show **yes** and durations cluster near the expected wall time (~10.0 min here), concurrent billing ticks and `forceTerminateCall` are keeping up for this scenario.
- **Auto-end:** `insufficient_coins` on `call:force-end` indicates the server terminated the billable session when the wallet could not fund the next second — aligned with product “call ends when user runs out of coins.”
- **Failures / timeouts:** Increase `FORCE_END_TEST_MAX_WAIT_MS`, verify Redis/Mongo/BullMQ, ensure `SEED_FAN_COINS`/`SEED_CREATOR_PRICE` match the seeded data, and check server CPU.

---
_Report produced automatically by `socket-force-end-test.mjs`._
