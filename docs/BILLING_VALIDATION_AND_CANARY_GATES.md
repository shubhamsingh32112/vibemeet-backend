# Billing Validation and Canary Gates

This runbook defines explicit validation gates for the billing reliability rollout.

## Pre-check (local CI gate)

Run from `backend/`:

- `npm run type-check`
- `npm run build`

Both must pass before staging deploy.

## Staging load and fault validation

Run in this exact order:

1. **50 concurrent calls / 20 minutes**
   - Expected: no stuck active calls, no negative balances, queue lag stable.
2. **100 concurrent calls / 20 minutes**
   - Expected: same as above with no sustained degradation.
3. **Fault injection**
   - Stream `mark_ended` failures: 5-10%
   - Redis latency spikes and reconnects
   - Billing worker restart during active calls
4. **Partial success / timeout (critical)**
   - Simulate: Stream accepts `mark_ended` (HTTP 2xx) but the backend **does not** persist the Redis completion marker (e.g. process crash, timeout after response, or test harness that skips `setCallEndedMarker`).
   - Expected: a termination retry job is enqueued (or lease released so retry can run); the retry path acquires the lease again; **at most one** successful `mark_ended` side effect (assert via Stream mock call count = 1, or dedupe metrics such as `force_terminate_deduped` / `lease_not_acquired` on the second attempt).

## Gate criteria (must all pass)

- Settlement success rate >= 99.9%
- Rolling 5m force-termination failure rate <= 2%
- Rolling 5m BullMQ queue lag average <= 5000ms
- Rolling 5m reconciliation runtime <= 80% of interval
- No duplicate settlements for the same call
- No calls left active in Stream after hard-stop trigger window

## Metrics checkpoints

Use `/metrics` and validate:

- `billing.forceTermination.rolling5m`
- `billing.bullmq.rolling5m`
- `billing.reconciliation.rolling5m`
- `alerts.active` should remain empty during steady-state

## Canary rollout

Billing is **stateful per call**. Prefer **cohort rollout by call session start time**, not by traffic percentage alone (which can mix logic versions within the same call).

1. Set **`BILLING_ROLLOUT_MIN_SESSION_START_MS`** to the deployment epoch (milliseconds). Only sessions with `startTime >=` this value are in the rollout cohort for optional skew (e.g. backpressure delay adjustment). Omit or clear the variable for 100% cohort.
2. Deploy the canary build and observe one stable window (30–60 minutes); verify all gate criteria.
3. Widen the cohort by lowering the threshold or removing it after validation.
4. For infrastructure-level canary (e.g. subset of app servers), still use session-time gating when toggling billing behavior.

## Rollback policy

If any gate fails:

1. Set `BILLING_SERVER_FORCE_END_ENABLED=false` (retain BullMQ billing).
2. Keep reconciliation workers enabled for convergence.
3. Investigate metrics and logs for:
   - `force_terminate_retry_failed`
   - `bullmq_queue_lag_ms`
   - `reconciliation_error`

Promote only after gate criteria are green again.

## Operational environment (reference)

| Variable | Purpose |
|----------|---------|
| `BILLING_ROLLOUT_MIN_SESSION_START_MS` | Epoch ms; optional rollout cohort for session `startTime` |
| `BILLING_BACKPRESSURE_LAG_MS` | Lag threshold before increasing next cycle delay (default 5000) |
| `BILLING_BACKPRESSURE_DELAY_FACTOR` | Multiplier for next delay when above threshold (default 1.5) |
| `BILLING_BACKPRESSURE_DELAY_CAP_MS` | Upper bound for delayed reschedule (default 30000) |
| `BILLING_CYCLE_EMERGENCY_REMOVE_DEDUPE` | Set `true` to restore remove-before-add for cycle jobs if needed |
| `BILLING_MARK_ENDED_LEASE_TTL_SECONDS` | Lease TTL for atomic `mark_ended` (default 120; caps crash window before marker write) |
