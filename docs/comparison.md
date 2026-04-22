# Comparison: 20 min sustain run (2026-04-18) vs prior findings report

This document compares the run documented in [`detailed.md`](./detailed.md) (same calendar day, later execution) with [`LOAD_TEST_BILLING_FINDINGS_2026-04-18.md`](./LOAD_TEST_BILLING_FINDINGS_2026-04-18.md), which described an earlier **15-minute** sustain configuration and slightly different seed balances.

---

## 1. Parameter matrix

| Parameter | Prior findings (§6.1) | This run ([`detailed.md`](./detailed.md)) |
|-----------|------------------------|-------------------------------------------|
| Pairs | 50 | 50 |
| Creator `price` | 60 coins/min | 60 coins/min |
| Fan balances | **600–649** (spread by index) | **600** flat for all fans |
| `LOAD_TEST_RAMP_UP_MS` | 0 (simultaneous) | 0 |
| `LOAD_TEST_SUSTAIN_MS` | **900000** (15 min) | **1200000** (20 min) |
| `LOAD_TEST_RAMP_DOWN_MS` | 0 (per successful run JSON in §6.2) | **0** (explicitly set; avoids default **120000** stagger) |
| `LOAD_TEST_SUSTAIN_JITTER_MS` | 0 | 0 |
| Results JSON (cited) | `load-test-results-2026-04-18T15-31-19-489Z.json` | `load-test-results-2026-04-18T17-33-33-514Z.json` |

---

## 2. Harness wall time vs billed time

| Aspect | Prior findings | This run |
|--------|----------------|----------|
| Per-worker **`durationMs`** | ~912–914 s (~15.2 min), matching **15 min** sustain | ~1,204–1,205 s (~20.1 min), matching **20 min** sustain |
| **Billed** duration (`CallHistory.durationSeconds` for user rows) | Not tabulated in the findings doc; coins went to **0** with no negatives | **599 s** for all 50 rows (query via `query-callhistory-durations.mjs`) |

Both runs share the same structural behavior: the harness **sleeps the full sustain** then calls `call-ended`. **Billed** duration (~10 minutes for ~600 coins at 60/min) is **shorter** than the sustain window whenever sustain exceeds time-to-depletion. The findings doc §6.3 already noted that exact “10:00” wall time is not asserted by the harness alone; **`durationSeconds` in Mongo** provides that evidence when needed.

---

## 3. Outcome parity

| Check | Prior findings (§6.2–6.3) | This run |
|-------|---------------------------|----------|
| `call-started` / `call-ended` HTTP success | 50 / 50; 0 harness errors | 50 / 50; 0 harness errors |
| Fan **`coinsAfter`** | 0 for every fan; no negatives | 0 for every fan; no negatives |
| Redis | Successful run used reachable Redis (public URL session override) | Same pattern (`REDIS_URL` override to public proxy for local dev) |

---

## 4. Documentation and artifacts

| Topic | Prior findings | This run |
|-------|----------------|----------|
| Primary write-up | Single findings report + referenced JSON/CSV paths | [`detailed.md`](./detailed.md) + this comparison |
| Coin snapshots | `coins-before.json` / `coins-after.json` | `coins-before-2026-04-18-20min.json` / `coins-after-2026-04-18-20min.json` |
| Billed duration proof | Relied on coin diff + narrative | Coin diff **plus** `CallHistory.durationSeconds` aggregate (**599 s**) |

---

## 5. Summary

- The **20 min sustain** run is **stricter in wall-clock terms** (longer intentional hold) but **matches the same billing story**: full coin depletion, no negative balances, and **~10 minutes** of **billed** time at 60 coins/min for 600 coins, confirmed numerically via **`callhistories`**.
- The main **configuration deltas** versus the earlier April 18 report are **flat 600 coins** (vs 600–649 spread), **20 min** sustain (vs 15 min), and explicit documentation of **`durationSeconds`** and client **`endedAt`** timestamps.
