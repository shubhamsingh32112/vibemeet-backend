# Video Call Instantness Runbook

## Scope

This runbook operationalizes the production validation and rollout phases for:

- 1000 users/day
- 200 creators
- 50 concurrent 1:1 calls

It uses the metrics now emitted in billing, presence, and settlement code paths.

## Metrics To Watch

Track these Redis-persisted metric names from `backend/src/utils/monitoring.ts`:

- `system.event_loop_lag_ms`
- `billing.tick_duration_ms`
- `billing.tick_drift_ms`
- `billing.redis_write_ms`
- `billing.redis_ops`
- `billing.redis_pipeline_success`
- `billing.redis_pipeline_failure`
- `billing.backpressure_stage`
- `billing.new_call_admission_rejected`
- `billing.emit_update_sent`
- `billing.emit_update_suppressed`
- `billing.settlement_transaction_ms`
- `billing.settlement_post_commit_ms`
- `billing.settlement_total_ms`
- `billing.settlement_redis_session_earned_diff_micros`
- `billing.settlement_redis_session_earned_diff_alert`
- `billing.settlement_final_flush_marker_present`
- `billing.settlement_final_flush_marker_missing`
- `call.presence.creator_status_emit`
- `call.presence.creator_status_noop`
- `call.presence.creator_status_propagation_ms`
- `call.presence.ttl_fallback_applied`

## SLO Targets

- Event loop lag p95 (`system.event_loop_lag_ms`): `<= 50ms`
- Tick drift p95/p99 (`billing.tick_drift_ms`): `<= 100ms / <= 300ms`
- Presence update (`creator:status`) p95: `<= 500ms`, p99: `<= 1500ms`
- Billing update visual cadence: `~1s`, no gaps `> 2s`
- Settlement p95 (`billing.settlement_total_ms`): `<= 5000ms`
- Tick duration p95 (`billing.tick_duration_ms`): `< 120ms`
- Redis write p95 (`billing.redis_write_ms`): `< 80ms`
- Redis pipeline failure rate (5m): `<= 2%`

## Feature Flags / Tunables

These environment variables control rollout safely without code changes:

- `BILLING_EMIT_INTERVAL_MS` (default `1000`)
- `BILLING_REDIS_BACKPRESSURE_MS` (default `250`)
- `BILLING_BP_STAGE2_EMIT_INTERVAL_MS` (default `2000`)
- `BILLING_BP_*` backpressure thresholds (event loop, redis write, queue lag, tick drift)
- `MAX_BILLING_DELTA_MS`
- `BILLING_PROCESS_INTERVAL_MS` (code constant)

## Load Validation Sequence

1. **Warm-up**: 10 concurrent calls for 10 minutes.
2. **Target soak**: 50 concurrent calls for 30 minutes.
3. **Burst-end**: end 25+ calls inside 60 seconds.
4. **Recovery**: verify reconciliation and no stuck active sessions.

Record:

- metric summaries every minute,
- Redis error rate,
- socket disconnect/reconnect count,
- forced-end reasons.

## Failure Injection Checklist

- Drop socket connection mid-call (caller and creator).
- Delay Redis operations / simulate temporary Redis outage.
- Send duplicate `call.session_ended` and `call.ended` webhooks.
- Force Stream `mark_ended` failure and verify retry path.

## Go/No-Go Gates

Before moving past canary (or before production rollout), require all:

- event loop lag p95 `<= 50ms` for 30 continuous minutes
- tick drift p95 `<= 100ms` and p99 `<= 300ms` for 30 continuous minutes
- settlement p95 `<= 5000ms`
- creator status propagation p95 `<= 500ms`
- Redis pipeline failure rate (5m) `<= 2%`

## Rollout Plan

1. Enable frontend instant UX changes.
2. Enable telemetry first (event loop lag, tick drift, redis ops/pipeline, presence propagation).
3. Enable staged backpressure policy and monitor `billing.backpressure_stage`.
4. Verify settlement flush markers and discrepancy alerts remain healthy.
5. Roll out presence authority/TTL fallback hardening.
6. Keep each stage live for at least one traffic peak window before next stage.

## Rollback Triggers

Rollback latest stage if any condition persists for > 5 minutes:

- `billing.tick_duration_ms` p95 > 300ms
- `billing.settlement_total_ms` p95 > 8000ms
- `system.event_loop_lag_ms` p95 > 75ms
- `billing.tick_drift_ms` p99 > 500ms
- `billing.redis_pipeline_failure` rolling 5m failure rate > 3%
- `billing.new_call_admission_rejected` sustained non-zero outside load test windows
- force-ended calls increase > 2x baseline
- repeated Redis write errors in billing path

### Stage-Specific Escalation / Rollback

- **Stage 1 (mild):** if active > 10m with worsening lag, rollback latest config change.
- **Stage 2 (sustained):** if active > 10m and UX degrade unacceptable, rollback to Stage 1 thresholds.
- **Stage 3 (severe admission control):** if active > 5m, trigger incident response and rollback newest rollout step after active-call settlement stabilizes.

## Notes

- Financial correctness remains the primary invariant.
- If performance tuning conflicts with correctness, keep correctness and throttle fanout first.
