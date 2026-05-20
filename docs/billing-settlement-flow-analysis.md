# Billing settlement flow analysis

**Status:** Reference document for orchestration hardening (2026).

> **Important:** Production settlement gaps observed in load tests are caused by **orchestration races** (concurrent triggers, lock-loser abandonment, Stream-gated settlement)—**not** initiator-specific persistence logic in `settleCall`. Both User→Creator and Creator→User paths use the same financial writer.

## Target architecture (post-refactor)

| Layer | Entry | Module |
|-------|--------|--------|
| Orchestration | `finalizeCallSession({ callId, reason, source })` | `billing-session-finalization.service.ts` |
| Persistence | `persistCallSettlement(io, callId, ctx)` | `billing-settlement.service.ts` |

Only the finalizer may call `persistCallSettlement`.

---

## Settlement triggers (pre-refactor)

| Trigger | File | Function | Calls |
|---------|------|----------|--------|
| Wallet exhausted | `billing.service.ts` | `_processBillingCycleInternal` | `forceTerminateCall` + returns `stop_needs_settlement` |
| Tick stop | `billing-batch.processor.ts`, `billing.queue.ts` | batch/worker | `settleCall` on `stop_needs_settlement` |
| Force-end | `billing-termination.service.ts` | `forceTerminateCall` | `void settleCall` **after Stream `mark_ended` success** |
| Socket `call:ended` | `billing-socket.gateway.ts` | handler | `finalizeCallEnd` → `settleCall` |
| HTTP `call-ended` | `billing.routes.ts` | POST | `settleCallHttp` → `finalizeCallEnd` |
| Deferred end | `billing.gateway.ts`, socket gateway | pending key on `call-started` | `settleCall` |
| Stream webhooks | `call-lifecycle.service.ts` | `handleCallEnded` / `handleSessionEnded` | `finalizeCallEnd` |
| Video reconciliation | `call-reconciliation.ts` | Stream vs DB | `finalizeCallEnd` |
| Billing reconciliation | `billing-reconciliation.ts` | DLQ + stale watchdog | `settleCall` |

**Socket `disconnect`:** intentionally does **not** settle (`billing-socket.gateway.ts`).

---

## Redis keys

| Key | Purpose |
|-----|---------|
| `call:session:{callId}` | Billing session JSON |
| `call:user_intro_micros:`, `call:user_wallet_micros:`, `call:creator_earnings:` | Running balances |
| `billing:active_calls` | ZSET next tick time |
| `settle:lock:{callId}` | Settlement mutex (legacy, coordinated by finalizer) |
| `settled:call:{callId}` | Idempotency marker (TTL 5 min) |
| `billing:final_flush:{callId}` | Post-flush marker |
| `settlement:claim:{callId}` | Ownership claim JSON `{ token, instanceId, acquiredAt }` |
| `billing:settlement-retry` | ZSET retry queue |
| `call:finalize:lock:`, `call:finalize:done:` | Call end dedup |
| `pending:call:ends:{callId}` | Deferred `call-ended` |
| `dlq:billing:failed:*` | Failed tick DLQ |
| `lock:reconciliation:billing` | Reconciliation global lock |

---

## Race conditions (root cause)

1. **Dual trigger on exhaustion:** `emitSoon(forceTerminateCall)` and tick `stop_needs_settlement` → both attempt settlement.
2. **Lock loser abandonment:** Second caller gets `settle:lock` NX miss and **returns without retry** (`billing-settlement.service.ts`).
3. **Stream coupling:** If Stream `mark_ended` fails, `forceTerminateCall` does not call `settleCall`; reliance on tick path only.
4. **Stale `settling`:** Without `BILLING_MAX_SETTLING_MS` takeover, crashed worker can leave Mongo `settlement.status === 'settling'` forever.

---

## `forceTerminateCall` (pre-refactor)

1. Emit `call:force-end` to fan + creator rooms (always).
2. If `BILLING_SERVER_FORCE_END_ENABLED=false`, stop.
3. Dedup via `hasCallEndedMarker` / lease.
4. `markStreamCallEnded` — **settlement only on success**.
5. `void settleCall(io, callId)`.

**Post-refactor:** `finalizeCallSession` immediately; Stream `mark_ended` best-effort async.

---

## `finalizeCallEnd`

1. Redis dedup `call:finalize:done:{callId}`.
2. Restore creator availability / release lock.
3. `Call.status = ended`, `isSettled = true`.
4. `settleCall` (or `finalizeCallSession` post-refactor).

---

## Reconciliation

`billing-reconciliation.ts` — interval `RECONCILIATION_INTERVAL_MS` (5 min):

- DLQ batch retry → `processBillingTick` → `settleCall` on stop
- Stale ZSET watchdog
- BullMQ lost-job watchdog
- **Post-refactor:** orphan settlement repair + stale `settling` takeover via `finalizeCallSession`

---

## Failure modes

| Symptom | Likely cause |
|---------|----------------|
| `call:force-end` but no `CallHistory` | Lock loser abandoned; Stream path skipped settle |
| `recordCount: 0` in load tests | Same race under HTTP-only harness (`postsCallEnded: false`) |
| Stuck `settling` | Worker crash mid-finalize without takeover |
| Duplicate earnings | Rare; existing Mongo idempotency keys mitigate |

---

## Multi-instance scaling assumptions

| Concern | Mitigation |
|---------|------------|
| Duplicate settlement workers | Per-`callId` `settlement:claim` + `settle:lock` + `settled:call:` |
| Retries | Shared `billing:settlement-retry` ZSET / BullMQ |
| Stale settling | `BILLING_MAX_SETTLING_MS` + reconciliation takeover |
| Ownership debug | `Call.settlement.ownerToken`, `ownerInstanceId` |
| Socket emits | `@socket.io/redis-adapter` required for multi-node |
| Reconciliation | Global lock `lock:reconciliation:billing` |

**Future:** dedicated settlement-retry worker pool; shard reconciliation by `callId`; dashboards on `billing_finalize_retry_total` / `billing_finalize_stale_claim_total`.

**Out of scope for this refactor:** CPM math, Redis tick loop, billing batch interval changes.
