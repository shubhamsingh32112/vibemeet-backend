# Billing Sync Drift Canary Gates

## Objective

Validate that start/recovery churn is reduced without regressing billing start, tick scheduling, or settlement.

## Release Strategy

1. Deploy to staging.
2. Run reconnect stress flows (socket reconnect, HTTP fallback retries, webhook overlap).
3. Roll out to production canary slice.
4. Expand only if all gates pass for two consecutive observation windows.

## Primary Success Gates

- **Start orchestration dedupe**
  - Lower duplicate start attempts per `callId`.
  - Watch: `session_start_duplicate` with reason `suppressed_non_owner`.
- **Recovery churn reduction**
  - Fewer repeated recover bursts per active call.
  - Watch: `state_recovery` vs `state_recovery_suppressed`.
- **Client sync auto-heal effectiveness**
  - Auto-heal should trigger rarely and recover quickly.
  - Watch: `billing_sync_autoheal_triggered`, `billing_sync_autoheal_success`, `billing_sync_warning_deduped`.
- **No start regressions**
  - Stable or improved `session_started`.
  - No rise in `billing_start_latency_ms` p95.
- **No settlement regressions**
  - No rise in `billing_finalize_failure`.
  - Stable settlement throughput and retry counts.

## Guardrail Alerts (Rollback Triggers)

- Sustained increase in:
  - `billing_finalize_failure`,
  - `billing_watchdog_stalled_recovering`,
  - `billing_recovery_dead_letter_total`.
- Drop in `session_started` success or spike in `billing:error` for call start.
- Rapid growth in sync warnings with low auto-heal success.

## Suggested Observation Windows

- **Staging:** 30 minutes reconnect stress + synthetic call churn.
- **Canary production:** 60 minutes minimum before expansion.
- **Post full rollout:** 24-hour watch period.

## Quick Triage Checklist

1. For affected `callId`, inspect:
   - `startCorrelationId`,
   - `startIngress`,
   - `recoveryRequestId`,
   - `recoveryOwnerInstanceId`.
2. Confirm only one orchestrator owner during start TTL.
3. Verify replay guard is suppressing redundant webhook replays.
4. Check whether sync warnings were deduped and auto-heal attempted.
5. If sequence regressions appear, inspect `billing_emit_tuple_regression`.

