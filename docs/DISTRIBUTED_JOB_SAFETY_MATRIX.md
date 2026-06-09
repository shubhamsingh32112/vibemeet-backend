# Distributed Job Safety Matrix

Post–Milestone A state (2026-06-08). Source: code in `backend/src` after P0 security + distributed lock hardening.

## Legend

| Category | Meaning |
|----------|---------|
| Distributed-safe | Multiple replicas may run concurrently without duplicate side effects |
| Singleton | Exactly one replica should run per tick (Redis cluster lock) |
| Claim-based | Atomic Mongo claim per row; lock optional defense-in-depth |
| Unsafe | Multiple replicas can duplicate work — do not scale until fixed |
| Documented only | Idempotent duplicates acceptable |

## Background jobs

| Job | File | Interval | Category | Lock key | Notes |
|-----|------|----------|----------|----------|-------|
| BullMQ billing cycle | `billing.queue.ts` | per-call | Distributed-safe | per-call cycle lock | BullMQ + Redis |
| BullMQ termination retry | `billing-termination.queue.ts` | queue-driven | Distributed-safe | job idempotency | |
| Billing reconciliation | `billing-reconciliation.ts` | 5 min | Singleton | `lock:reconciliation:billing` | Shared `distributed-lock.ts` |
| Call reconciliation | `call-reconciliation.ts` | 5 min | Singleton | `lock:reconciliation:call` | Existing lock |
| Billing watchdog | `billing-watchdog.service.ts` | 5s | Singleton | `lock:billing:watchdog` | Bypass: `BILLING_WATCHDOG_CLUSTER_LOCK=false` |
| VIP reconciliation | `vip-scheduling.reconciliation.ts` | 60s | Singleton + claim | `lock:vip:reconciliation` | `findOneAndUpdate` before emit |
| Domain event worker | `domain-event.worker.ts` | 5s | Singleton + claim | `lock:domain_events:worker` | Off unless `DOMAIN_EVENTS_ENABLED=true` |
| Staff wallet recon | `staff-wallet-reconciliation.scheduler.ts` | 24h | **Unsafe** | none | Defer unless enabled in staging |
| Moments story expiry | various | periodic | Documented only | — | Idempotent |
| Stream upload sweeper | `stream-upload-session.service.ts` | periodic | Documented only | — | Idempotent |
| Presence heartbeat sweep | `availability.gateway.ts` | 30s | **Safe when `PRESENCE_REDIS_SOCKET_REGISTRY_ENABLED=true`** | Redis socket registry | Unsafe with local Maps only |
| API hygiene intervals | `bootstrap-core.ts` | varies | Per-replica safe | — | |

## Lock observability

All cluster locks via [`distributed-lock.ts`](../src/utils/distributed-lock.ts) emit structured logs:

- `lock.acquired` / `lock.released` / `lock.skipped` (info)
- `lock.expired` / `lock.heartbeat_failed` (warn)

Fields: `instanceId`, `lockKey`, `event`.

## Scaling guidance

- **billing-worker:** Safe to run ≥2 tasks after Milestone A (watchdog + VIP recon singleton).
- **api-ws:** With `PRESENCE_REDIS_SOCKET_REGISTRY_ENABLED=true`, heartbeat sweep uses cluster-wide `hasAnySocket`; ALB stickiness optional.
- **DOMAIN_EVENTS_ENABLED:** Only enable after Milestone A staging validates claim + lock behavior.
