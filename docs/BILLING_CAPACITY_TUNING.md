# Billing Capacity Tuning (Phase 5B)

Controlled concurrency tuning for multi billing-worker ECS deployments.

## Policy

- Maximum **25–30% increase** per tuning iteration
- Hold each change under staging load **≥ 24 hours** before next increase
- **Never** combine concurrency increases with worker count increases in the same deploy
- Document rollback value before every change

## Required metrics (from `/metrics`)

- `billing.runtime.eventLoopLagP95` — abort tuning if > 50ms
- `billing.bullmq.queueLagAvgMs` / rolling p95
- `billing.settlementTotalMs.p95Ms`
- `billing.tickDriftMs.p95Ms`
- `billing.dlq.size`
- `billing.locks.*` rolling 5m

## Starting worksheet

| billing-worker tasks | Starting concurrency | Max parallel handlers |
|---------------------|---------------------|----------------------|
| 1 | 80–100 | 80–100 |
| 2 | **50** (code default) | 100 |
| 4 | 25–30 | 100–120 |

## Default change (staging first)

`BILLING_BULLMQ_CONCURRENCY` fallback lowered from 130 → **50** in `billing.queue.ts`.

Production deploy of new default requires Milestone B signoff.

## Rollback

Restore prior env per task:

```bash
BILLING_BULLMQ_CONCURRENCY=130  # legacy single-worker Railway-style
```

Target rollback time: **< 15 minutes** (ECS rolling deploy).

## Load model

```bash
npm run billing:load-model
```

Validates stability and tuning guidance — not saturation testing.

## Deferred (forbidden in Phases 4–5)

- Adaptive / auto-scaling concurrency
- Predictive queue scaling
- Queue self-throttling
- Dynamic retry timing
- Auto backpressure mutation
