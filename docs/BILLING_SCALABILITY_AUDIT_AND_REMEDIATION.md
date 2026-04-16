# Billing Scalability Audit and Remediation Guide

## Scope and target

This document reviews billing and call-termination reliability for:

- ~1000 users/day
- ~200 creators
- 50-100 concurrent video calls

It is based on the current implementation of:

- BullMQ billing driver
- server-side force termination (`mark_ended`)
- billing + call reconciliation workers
- `/metrics` observability output

The goal is to move from "mostly working" to "high production confidence."

---

## Executive summary

### What is already strong

- BullMQ billing mode exists and is integrated in runtime wiring.
- Hard-stop billing conditions route through a centralized termination service.
- Server-side Stream `mark_ended` call is implemented with idempotency key.
- Reconciliation has distributed lock + heartbeat + bounded runtime controls.
- Metrics exposure includes force-termination and queue-lag signals.

### What still blocks high confidence

1. **DLQ recovery** — **remediated:** bounded **`SSCAN`** via `getDlqBatch` in `billing-reconciliation.ts` (see §1 below; audit text kept for history).
2. **Call-start hard-stop is single-shot**; failed `mark_ended` may not be retried.
3. **BullMQ cycle jobs are not deduped per call** (`jobId` missing), enabling queue amplification.
4. **Active-call predicate is partially implemented** vs `callSession OR activeCallByUser`.
5. **Alert thresholds are lifetime aggregates**, not rolling-window health.

---

## Detailed findings and remediations

## 1) High: DLQ reconciliation still unbounded on backlog

**Update:** Production code now uses **`getDlqBatch` → `SSCAN`** with `BILLING_DLQ_SSCAN_CURSOR_KEY`, plus `dlq_batch_fetch_ms` metrics. The snippet below describes the **prior** pattern kept for context.

### Prior behavior (fixed)

`billing-reconciliation.ts` used to load all set members:

```ts
const allItems = await redis.smembers(dlqSetKey);
const dlqItems = allItems.slice(0, DLQ_BATCH_SIZE);
```

Even though processing is batch-limited, retrieval is still O(n) memory/time.

### Why this is risky at target load

- During Redis/network incidents, failed ticks can spike quickly.
- `SMEMBERS` on large sets increases Redis latency for all consumers.
- Recovery loop can become self-throttling and delay settlement.

### Recommended fix

Switch to cursor-based `SSCAN` and stop as soon as bounded batch size is collected.

```ts
async function getDlqBatch(redis: Redis, dlqSetKey: string, maxItems: number): Promise<string[]> {
  const items: string[] = [];
  let cursor = '0';
  do {
    const [nextCursor, members] = await redis.sscan(dlqSetKey, cursor, 'COUNT', 200);
    cursor = nextCursor;
    for (const member of members) {
      items.push(member);
      if (items.length >= maxItems) return items;
    }
  } while (cursor !== '0');
  return items;
}
```

Then replace `smembers(...).slice(...)` with `getDlqBatch(...)`.

### Additional hardening

- Add `dlq_batch_fetch_ms` metric.
- Add `dlq_set_size_estimate` metric periodically.
- Cap reconciliation run by both time and processed item count.

---

## 2) High: start-of-call hard-stop is not strongly guaranteed on `mark_ended` failure

### Current behavior

When user is below threshold at start:

- Session is not created.
- `forceTerminateCall(...)` runs asynchronously once.
- If Stream API fails, no billing tick path exists to retry.

### Why this is risky

- A transient Stream outage can leave call media active briefly.
- This violates "backend-authoritative termination" intent at call-start gate.

### Recommended fix: add termination retry queue

Create a lightweight retry mechanism for call-start hard stops:

1. Write retry intent key on failure:

```ts
// key: billing:termination:retry:<callId>
{
  callId,
  reason,
  userFirebaseUid,
  creatorFirebaseUid,
  attempts,
  nextAttemptAt
}
```

2. Process retries via BullMQ delayed queue or periodic worker.
3. Stop retries when:
   - `mark_ended` succeeds, or
   - Stream webhook confirms ended, or
   - max attempts/backoff exhausted.

### Suggested retry/backoff policy

- Attempts: 6
- Backoff: exponential with jitter (e.g. 2s, 4s, 8s, 16s, 32s, 64s)
- Max retry window: <= 2 minutes

### Optional safety net

In call reconciliation, if call is active but payer is under minimum threshold and no billing session exists, force-end call again server-side.

---

## 3) Medium: BullMQ cycle jobs are not deduplicated per call

### Current behavior

`scheduleBillingJob()` enqueues delayed jobs without `jobId`.

### Risk

- Retries/races can create multiple pending jobs per call.
- Per-call lock avoids double charge, but queue load and lag still increase.

### Recommended fix

Use deterministic `jobId` per call and replace scheduling with "upsert-like" behavior.

```ts
await q.add(
  'cycle',
  { callId },
  {
    jobId: `billing-cycle:${callId}`,
    delay: delayMs,
    removeOnComplete: 500,
    removeOnFail: 200,
  }
);
```

If needed, remove old job then add with updated delay:

```ts
const existing = await q.getJob(`billing-cycle:${callId}`);
if (existing) await existing.remove();
await q.add(...);
```

### Metrics to add

- `bullmq_cycle_enqueue_attempted`
- `bullmq_cycle_enqueue_deduped`
- `bullmq_cycle_jobs_active`

---

## 4) Medium: active-call predicate is partially implemented vs plan

### Intended predicate

For BullMQ mode, "active call" should be treated as:

- `callSessionKey(callId)` exists **OR**
- either user has `activeCallByUserKey(userFirebaseUid)` pointing to this call

### Current gap

Some paths still gate mainly by session existence.

### Recommended fix

Introduce shared helper in billing module:

```ts
export async function isCallActiveForUser(
  redis: Redis,
  callId: string,
  userFirebaseUid?: string,
  creatorFirebaseUid?: string
): Promise<boolean> {
  const session = await redis.get(callSessionKey(callId));
  if (session) return true;
  if (userFirebaseUid) {
    const call = await redis.get(activeCallByUserKey(userFirebaseUid));
    if (call === callId) return true;
  }
  if (creatorFirebaseUid) {
    const call = await redis.get(activeCallByUserKey(creatorFirebaseUid));
    if (call === callId) return true;
  }
  return false;
}
```

Use this helper in:

- `billing.gateway.ts`
- `billing-socket.gateway.ts`
- `video.routes.ts`

This avoids logic drift and ensures consistent BullMQ behavior.

---

## 5) Low: alert thresholds are lifetime aggregates, not rolling windows

### Current behavior

`/metrics` computes rates from in-memory totals since process start.

### Risk

- Recent failure spikes can be diluted after long uptime.
- Alert sensitivity decreases over time.

### Recommended fix

Calculate rolling-window rates from Redis-backed timestamps or bucketed counters.

#### Option A: Redis sorted-set windows

- Store events as zset with timestamp score.
- For `/metrics`, query count in last 5m:

```ts
const now = Date.now();
const from = now - 5 * 60 * 1000;
const requested5m = await redis.zcount('metrics:billing_force_terminate_requested', from, now);
const failed5m = await redis.zcount('metrics:billing_force_terminate_stream_failed', from, now);
```

#### Option B: fixed-minute buckets

- Increment `metrics:billing:terminate:failed:YYYYMMDDHHmm`.
- Aggregate latest 5 buckets.

Use rolling values for alert decisions; keep lifetime values for trend reporting.

---

## Scalability analysis for target traffic

## Billing tick throughput

With 100 concurrent calls and ~300ms cycle:

- ~333 cycle executions/sec theoretical.
- Safe if:
  - per-tick Redis ops stay low-latency,
  - queue lag remains bounded,
  - settlement path is decoupled from hot tick loop.

Current system is close, but queue dedupe and DLQ bounded fetch are required to avoid blowups during incidents.

## Reconciliation capacity

Current improvements are good:

- distributed lock prevents cross-replica duplicate sweeps,
- bounded runtime and parallelism reduce stampede risk.

Still needed:

- `SSCAN` DLQ fetch to avoid O(n) retrieval pressure.

## Failure domains to validate

- Stream API intermittent failures (especially call-start hard-stop).
- Redis transient latency and reconnect storms.
- Worker restart while many calls active.

---

## Additional relevant production recommendations

## 1) Enforce explicit production startup guard

Current startup logs warning if not BullMQ in production. For strict reliability, fail fast unless explicitly overridden:

```ts
if (process.env.NODE_ENV === 'production' && process.env.BILLING_DRIVER !== 'bullmq') {
  throw new Error('Production requires BILLING_DRIVER=bullmq');
}
```

If you need migration flexibility, gate with `ALLOW_NON_BULLMQ_IN_PROD=true`.

## 2) Add correlation ids for call lifecycle

Include `callId`, `sessionId`, webhook event id, and termination attempt id in logs to make incident triage fast.

## 3) Tighten webhook-to-billing convergence checks

Add periodic assertion metric:

- active calls in Stream
- active billing sessions in Redis
- open calls in Mongo status

Alert on sustained divergence.

## 4) Security/ops hygiene

- Rotate any committed secrets immediately.
- Keep `/metrics` token mandatory in production.
- Add rate limits for expensive admin/reconciliation-trigger endpoints.

---

## Suggested implementation order (remaining work)

1. Replace DLQ `SMEMBERS` with `SSCAN` bounded batch.
2. Add termination retry pipeline for start-of-call hard-stop failures.
3. Add BullMQ per-call deduped `jobId` scheduling.
4. Centralize active-call predicate helper and apply consistently.
5. Move alerts to rolling 5-minute computations.
6. Run staged fault-injection tests and verify SLOs.

---

## Validation matrix (must pass before full rollout)

## Functional

- insufficient coins at call start always ends Stream call (including transient failure retry path).
- duration-limit hard-stop ends call and settles exactly once.
- duplicate hard-stop events do not duplicate settlement.

## Scalability

- 50 concurrent calls x 20 minutes: no queue runaway, no stuck sessions.
- 100 concurrent calls x 20 minutes: queue lag stable, reconciliation within budget.

## Fault-injection

- 5-10% forced Stream `mark_ended` failures: retry path converges.
- Redis latency spikes: no data corruption, eventual settlement.
- worker restart: active sessions recover and continue or settle safely.

## SLO checks

- settlement success >= 99.9%
- forced termination failure rate (5m rolling) <= 2%
- reconciliation runtime < 80% interval on average

---

## Conclusion

The implementation is **close** to production-grade for your target load and already has strong foundations.  
To reach high confidence for 50-100 concurrent calls with incident resilience, prioritize the two high-severity fixes first:

- bounded DLQ retrieval (`SSCAN`),
- reliable retry path for call-start hard-stop `mark_ended` failures.

After those are completed and validated with fault-injection, the architecture is well positioned for 1000 users/day and 200 creators.

