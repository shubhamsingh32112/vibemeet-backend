# Billing Production Rollout (50-100 Concurrent Calls)

## Required environment configuration

- `BILLING_DRIVER=bullmq`
- `BILLING_BULLMQ_CONCURRENCY=50` (initial)
- `BILLING_SERVER_FORCE_END_ENABLED=true`
- `BILLING_FORCE_END_TTL_SECONDS=120`
- `MIN_COINS_TO_CALL=10` (or your policy)
- Reconciliation tuning:
  - `BILLING_RECON_DLQ_BATCH_SIZE=200`
  - `BILLING_RECON_DLQ_PARALLELISM=8`
  - `BILLING_RECON_MAX_RUN_MS=45000`
  - `CALL_RECONCILIATION_PARALLELISM=6`
  - `RECONCILIATION_LOCK_TTL_MS=90000`

## Canary rollout

1. Deploy to one replica with BullMQ + server force-end enabled.
2. Validate `/metrics` for:
   - `billing.force_terminate_stream_failed` remains near zero
   - `billing.bullmq_queue_lag_ms` average remains stable
   - `billing.reconciliation_run_ms` below interval budget
3. Increase to 50% replicas after one stable monitoring window (30-60 minutes).
4. Increase to 100% replicas after a second stable window.
5. Roll back quickly by setting `BILLING_SERVER_FORCE_END_ENABLED=false` if needed while keeping BullMQ enabled.

## Load and failure test checklist

Run these in staging before full production:

1. Simulate 50 concurrent calls for 20 minutes.
2. Simulate 100 concurrent calls for 20 minutes.
3. Inject Redis latency spikes and worker restarts.
4. Inject Stream API timeout faults for forced termination calls.
5. Verify:
   - no stuck active calls
   - no negative balances
   - settlement completes for all ended calls
   - force-termination failures are recovered by settlement/reconciliation

## Alerting thresholds

- Trigger warning if force-termination Stream failure rate > 2%.
- Trigger warning if BullMQ queue lag average > 5000ms.
- Trigger warning if reconciliation run average exceeds 80% of interval.
- Trigger warning on sustained settlement retry spikes.
