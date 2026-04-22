# Billing Load Test Recreation Guide (Historical Reference)

This file is retained as a **historical record** of how billing load tests were designed and executed in this repository.

## Status

- Runnable load-test code paths have been removed from the active backend surface.
- Historical reports/artifacts are intentionally preserved.

## What was fixed before the final run

The main blocker was MongoDB SRV DNS resolution:

- Error: `querySrv ECONNREFUSED _mongodb._tcp.cluster0.jr3n411.mongodb.net`
- Root cause: local DNS resolver path intermittently blocked Atlas SRV lookups.
- Mitigation: optional DNS override via `LOAD_TEST_DNS_SERVERS` (example: `8.8.8.8,1.1.1.1`) was added to the load-test flow at the time.

It was wired in:

- `backend/src/scripts/seed-load-test-users.ts`
- `backend/src/scripts/revert-load-test-users.ts`
- `backend/scripts/load-test/snapshot-coins.mjs`
- `backend/src/config/database.ts`

## Final validated execution strategy

The successful run used **seed separately, test together**:

1. Seed `20` users @ `60` CPM -> `backend/scripts/load-test/pairs.60.json`
2. Seed `20` users @ `90` CPM -> `backend/scripts/load-test/pairs.90.json`
3. Seed `20` users @ `120` CPM -> `backend/scripts/load-test/pairs.120.json`
4. Merge to one input file:
   - `backend/scripts/load-test/pairs.60_90_120.merged.json`
   - Distribution validated as `20 / 20 / 20`
5. Run one combined socket force-end test with `FORCE_END_TEST_MULTI_N=60`.

## Final run results (60 sessions)

- Total sessions: `60`
- Passed: `60`
- Failed: `0`
- End condition: all sessions ended with `call:force-end` and `reason: insufficient_coins`

Per-tier duration summary:

- `60 CPM`: min `799.872s`, max `800.755s`, mean `800.279s`
- `90 CPM`: min `533.130s`, max `533.805s`, mean `533.429s`
- `120 CPM`: min `399.786s`, max `400.480s`, mean `400.137s`

Expected theoretical durations for 800 coins:

- `60 CPM` -> `~800s`
- `90 CPM` -> `~533.33s`
- `120 CPM` -> `400s`

Observed values were aligned with expected depletion timing.

## Preserved historical artifacts

- JSON run output:
  - `backend/scripts/load-test/force-end-multi-results-2026-04-21T11-19-00-492Z.json`
- Detailed report:
  - `backend/docs/LOAD_TEST_60_USERS_800_COINS_60_90_120CPM_REPORT.md`

Additional historical load-test files under `backend/docs/` and `backend/scripts/load-test/` are preserved for audit/reference.

## Reimplementation note

If load testing is needed again, reintroduce dedicated seed/harness scripts and npm commands in a staging-only workflow, then validate:

- per-session start/end timestamps
- forced end on wallet depletion
- per-tier duration convergence under concurrency
