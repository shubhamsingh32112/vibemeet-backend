Below is a technical review + execution guidance, focusing on whether you should proceed and how to implement safely.

1) Go/No-Go on implementing top 2 fixes

Conclusion: Proceed immediately with both.

Why these two first
DLQ SMEMBERS → SSCAN
This is a latent failure amplifier. It won’t hurt during normal ops, but under backlog it degrades Redis globally.
Fix is low-risk and isolated.
Call-start termination retry pipeline
This is a correctness bug, not just scalability.
Violates your core invariant: backend is authoritative for call termination.

These two directly impact:

correctness under failure
recovery behavior
system stability under spikes
2) Critical review of your proposed implementations
2.1 DLQ fix (SSCAN)

Your implementation is mostly correct:

const [nextCursor, members] = await redis.sscan(dlqSetKey, cursor, 'COUNT', 200);
Required adjustments
A. Avoid full scan when not needed

Right now:

do {
  ...
} while (cursor !== '0');

This still scans entire set if maxItems is large relative to density.

Better pattern (early exit priority):

if (items.length >= maxItems) return items;

You already have this — good.

B. Add hard runtime cap

Prevent reconciliation from monopolizing event loop:

const start = Date.now();
const MAX_MS = 200;

do {
  ...
  if (Date.now() - start > MAX_MS) break;
} while (cursor !== '0');
C. Randomize starting cursor (optional but useful)

Prevents always hitting same subset under heavy load:

let cursor = Math.floor(Math.random() * 1000).toString();
2.2 Termination retry pipeline

Your design is solid, but there is one architectural gap:

Problem: retry state stored as Redis key
billing:termination:retry:<callId>

This becomes:

non-atomic
hard to schedule precisely
no visibility into queue lag
Recommended architecture change (important)

Use BullMQ delayed jobs instead of raw Redis keys.

Why
You already depend on BullMQ
You get:
retry scheduling
backoff
observability
deduplication via jobId
Correct implementation pattern
Enqueue retry job
await terminationQueue.add(
  'retry-mark-ended',
  {
    callId,
    userFirebaseUid,
    creatorFirebaseUid,
    reason,
  },
  {
    jobId: `terminate:${callId}`,
    attempts: 6,
    backoff: {
      type: 'exponential',
      delay: 2000,
    },
    removeOnComplete: true,
    removeOnFail: false,
  }
);
Worker
worker.process('retry-mark-ended', async (job) => {
  const { callId } = job.data;

  const stillActive = await isCallActiveForUser(redis, callId);

  if (!stillActive) {
    return; // already resolved
  }

  await streamClient.video.call('default', callId).end({
    reason: 'retry-hard-stop',
  });
});
Key improvement over your version
No manual attempts tracking
No nextAttemptAt
No polling loop
Fully managed retry lifecycle
3) Hidden issue you did NOT call out (important)
Race condition: retry vs successful termination

Scenario:

First mark_ended succeeds
Retry job still exists
Retry fires → duplicate termination
Fix

Make termination idempotent at your layer, not just Stream:

const alreadyEnded = await redis.get(`call:ended:${callId}`);
if (alreadyEnded) return;

await streamCall.end(...);

await redis.set(`call:ended:${callId}`, '1', 'EX', 300);
4) Risk assessment after these fixes

Once implemented:

Area	Status
Billing correctness	High confidence
Queue stability	Stable under spikes
Redis pressure	Controlled
Failure recovery	Convergent
Call-start guarantee	Strong
5) What you should NOT do yet

Do not:

Implement rolling metrics first → low impact vs above
Optimize reconciliation parallelism further → premature
Add more caching layers → adds complexity now
6) Execution order (refined)

Follow this exact sequence:

SSCAN DLQ fix
deploy independently
verify no regression
Termination retry via BullMQ
include idempotency guard
simulate Stream failure locally
Add jobId dedupe (quick win)
prevents silent queue buildup
Then move to:
active-call predicate unification
rolling metrics
7) Production readiness verdict

Based on your doc:

“close to production-grade”

This is accurate.

After the two fixes:

You are safe to launch with:

~100 concurrent calls
~1000 DAU
moderate failure scenarios

Without them:

system works in happy path
but breaks under partial outages
8) Final recommendation

Proceed with implementation, but:

Use BullMQ for retry, not raw Redis keys
Add idempotency guard for termination
Add runtime cap to SSCAN loop