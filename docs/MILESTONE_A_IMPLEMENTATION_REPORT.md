# Milestone A Implementation Report

**Date:** 2026-06-08  
**Scope:** Phase 1 (P0 security) + Phase 2 (distributed singleton locks)  
**Baseline audit:** [FULL_BACKEND_REALITY_AUDIT.md](./FULL_BACKEND_REALITY_AUDIT.md)  
**Staging runbook:** [MILESTONE_A_STAGING_RUNBOOK.md](./MILESTONE_A_STAGING_RUNBOOK.md)  
**Job safety matrix:** [DISTRIBUTED_JOB_SAFETY_MATRIX.md](./DISTRIBUTED_JOB_SAFETY_MATRIX.md)

This document records every code change shipped for Milestone A, with **before** and **after** snippets, runtime impact, rollback knobs, and new tests.

---

## Summary

| Phase | Change | Risk addressed |
|-------|--------|----------------|
| P1 | Socket `call:started` auth parity | Billing fraud / slot exhaustion via arbitrary `callId` |
| P1 | VIP webhook raw body | Razorpay HMAC failure on JSON-parsed body |
| P1 | `media:ready` room fix | Event delivered to wrong Socket.IO room |
| P1 | Presence lookup auth | Any socket could batch-query arbitrary UIDs |
| P2 | `distributed-lock.ts` | Inconsistent lock patterns; no ownership logs |
| P2 | Billing watchdog cluster lock | N× recovery on multi billing-worker |
| P2 | VIP reconciliation lock + claim | Duplicate `vip:scheduled_call:due` emits |
| P2 | Domain event worker lock + claim | Duplicate outbox processing when enabled |

**Files touched:** 22 modified, 10 new  
**Explicitly deferred:** Phase 3 presence Redis registry, Mongo bounds, Terraform, load/chaos suite

---

## Phase 1 — P0 Security Fixes

### 1. Socket billing auth parity

**Files**
- `src/modules/billing/billing-socket.gateway.ts`
- `src/modules/billing/billing-rest-access.contract.test.ts`

**Problem**  
HTTP billing start (`billing.routes.ts`) called `assertBillingRestCallStartedAccess` before starting a session. The socket path trusted any authenticated user and derived payer as `data.userFirebaseUid || firebaseUid` with no authorization check.

**Before** (`billing-socket.gateway.ts`)

```typescript
socket.on('call:started', async (data) => {
  try {
    const payerFirebaseUid = data.userFirebaseUid || firebaseUid;
    // ... logging ...
    const rateLimitCheck = await checkCallRateLimit(payerFirebaseUid);
    if (!rateLimitCheck.allowed) { /* emit RATE_LIMIT_EXCEEDED */ return; }
    await billingService.startBillingSession(io, payerFirebaseUid, data, { ... });
  } catch (err) { /* ... */ }
});
```

**After** (`billing-socket.gateway.ts`)

```typescript
import { assertBillingRestCallStartedAccess } from './billing-rest-access';

socket.on('call:started', async (data) => {
  try {
    const access = assertBillingRestCallStartedAccess(
      firebaseUid,
      data.callId,
      data.creatorFirebaseUid,
      data.creatorMongoId,
      data.userFirebaseUid
    );
    if (!access.ok) {
      socket.emit('billing:error', {
        callId: data.callId,
        error: 'UNAUTHORIZED',
        message: access.error,
        status: access.status,
      });
      return;
    }
    const payerFirebaseUid = access.payerFirebaseUid;

    const rateLimitCheck = await checkCallRateLimit(payerFirebaseUid);
    // ... unchanged rate limit + startBillingSession ...
  } catch (err) { /* ... */ }
});
```

**Runtime behavior**
- Unauthorized socket attempts receive structured `billing:error` with HTTP-equivalent status codes (400/403).
- Authorized flows unchanged; payer resolved by shared `assertBillingRestCallStartedAccess` logic (creator-initiated requires explicit `userFirebaseUid`).

**Rollback**  
Revert handler block only; HTTP path unaffected.

**Tests added** (`billing-rest-access.contract.test.ts`)
- Unauthorized third party → 403
- Payer same as creator → 400
- Fan-origin with matching initiator → allowed

---

### 2. VIP webhook raw body fix

**Files**
- `src/server.ts`
- `src/server.signed-webhook.contract.test.ts` (new)

**Problem**  
`isSignedWebhookPost()` did not include `/api/v1/vip/webhook`. VIP route uses `verifyRazorpayWebhookSignature`, which requires the raw request body (`Buffer`). Without the guard, `express.json()` could parse the body first and break HMAC verification.

**Before** (`server.ts`)

```typescript
function isSignedWebhookPost(req: Request): boolean {
  if (req.method !== 'POST') return false;
  const pathOnly = req.originalUrl.split('?')[0];
  return (
    pathOnly === '/api/v1/video/webhook' ||
    pathOnly === '/api/v1/chat/webhook' ||
    pathOnly === '/api/v1/payment/webhook' ||
    pathOnly === '/api/v1/stream/webhook'
  );
}
```

**After** (`server.ts`)

```typescript
function isSignedWebhookPost(req: Request): boolean {
  if (req.method !== 'POST') return false;
  const pathOnly = req.originalUrl.split('?')[0];
  return (
    pathOnly === '/api/v1/video/webhook' ||
    pathOnly === '/api/v1/chat/webhook' ||
    pathOnly === '/api/v1/payment/webhook' ||
    pathOnly === '/api/v1/stream/webhook' ||
    pathOnly === '/api/v1/vip/webhook'
  );
}
```

**Runtime behavior**  
VIP webhook POSTs now receive `express.raw({ type: '*/*' })` and skip JSON/urlencoded parsers — same as payment webhook.

**Rollback**  
Single-line revert in `server.ts`.

---

### 3. `media:ready` room fix

**Files**
- `src/modules/moments/moments.gateway.ts`
- `src/modules/stream/stream-upload-session.service.ts`
- `src/modules/stream/stream.controller.ts`
- `src/modules/moments/moments.gateway.contract.test.ts` (new)

**Problem**  
`emitMediaReady` emitted to `io.to(userId)` where `userId` was a Mongo `_id`. Clients join billing/personal rooms as `user:{firebaseUid}`.

**Before** (`moments.gateway.ts`)

```typescript
export function emitMediaReady(userId: string, sessionId: string): void {
  ioRef?.to(userId).emit('media:ready', { sessionId });
}
```

**After** (`moments.gateway.ts`)

```typescript
export function emitMediaReady(firebaseUid: string, sessionId: string): void {
  ioRef?.to(`user:${firebaseUid}`).emit('media:ready', { sessionId });
}
```

**Before** (`stream-upload-session.service.ts`)

```typescript
export interface StreamUploadSession {
  sessionId: string;
  userId: string;
  contentClass: ContentClass;
  // ...
}

export async function createStreamUploadSession(input: {
  userId: string;
  contentClass: ContentClass;
  streamVideoId: string;
  ttlSeconds?: number;
}): Promise<StreamUploadSession> {
  const session: StreamUploadSession = {
    sessionId,
    userId: input.userId,
    contentClass: input.contentClass,
    // ...
  };
}
```

**After** (`stream-upload-session.service.ts`)

```typescript
export interface StreamUploadSession {
  sessionId: string;
  userId: string;
  firebaseUid: string;
  contentClass: ContentClass;
  // ...
}

export async function createStreamUploadSession(input: {
  userId: string;
  firebaseUid: string;
  contentClass: ContentClass;
  streamVideoId: string;
  ttlSeconds?: number;
}): Promise<StreamUploadSession> {
  const session: StreamUploadSession = {
    sessionId,
    userId: input.userId,
    firebaseUid: input.firebaseUid,
    contentClass: input.contentClass,
    // ...
  };
}
```

**Before** (`stream.controller.ts`)

```typescript
const session = await createStreamUploadSession({
  userId: user._id.toString(),
  contentClass,
  streamVideoId: cf.uid,
});

// webhook handler:
emitMediaReady(session.userId, session.sessionId);
```

**After** (`stream.controller.ts`)

```typescript
const session = await createStreamUploadSession({
  userId: user._id.toString(),
  firebaseUid: user.firebaseUid,
  contentClass,
  streamVideoId: cf.uid,
});

// webhook handler:
if (session.processingStatus === 'ready' && session.firebaseUid) {
  emitMediaReady(session.firebaseUid, session.sessionId);
}
```

**Runtime behavior**  
`firebaseUid` is denormalized at session create (no extra Mongo read on webhook hot path). Event name and payload unchanged.

**Backward compatibility**  
Legacy Redis sessions without `firebaseUid` skip emit until replaced by a new upload session.

**Rollback**  
Revert emit signature + session field; old clients already listen on `user:{firebaseUid}`.

---

### 4. Presence lookup auth restriction

**Files**
- `src/modules/availability/presence-lookup-access.ts` (new)
- `src/modules/availability/availability.gateway.ts`
- `src/modules/availability/presence-lookup-access.contract.test.ts` (new)

**Problem**  
`user:availability:get` allowed any authenticated socket to batch-query arbitrary user Firebase UIDs. HTTP `getOnlineUsers` restricted to creator/admin.

**Before** (`availability.gateway.ts` — `user:availability:get`)

```typescript
socket.on('user:availability:get', async (firebaseUids: string[]) => {
  try {
    if (!Array.isArray(firebaseUids)) {
      socket.emit('user:availability:batch', {});
      return;
    }
    const availability = await getBatchUserAvailability(firebaseUids);
    socket.emit('user:availability:batch', availability);
  } catch (err) { /* ... */ }
});
```

**After** (`presence-lookup-access.ts` — new module)

```typescript
export function isPresenceLookupAuthEnforced(): boolean {
  return process.env.PRESENCE_LOOKUP_AUTH_ENFORCED !== 'false';
}

export async function assertCreatorOrAdminForPresenceLookup(firebaseUid: string) {
  if (!isPresenceLookupAuthEnforced()) return { ok: true };
  const caller = await User.findOne({ firebaseUid }).select('role').lean();
  const isCreator = caller?.role === 'creator' || caller?.role === 'admin';
  if (!isCreator) return { ok: false, error: 'FORBIDDEN' };
  return { ok: true };
}

export function capPresenceLookupBatch<T>(items: T[]): T[] {
  return items.slice(0, PRESENCE_BATCH_LOOKUP_MAX); // default 100
}

export async function checkPresenceLookupRateLimit(socketId: string) {
  // Redis INCR per socketId, default 20 req / 60s
}
```

**After** (`availability.gateway.ts` — `user:availability:get`)

```typescript
socket.on('user:availability:get', async (firebaseUids: string[]) => {
  const uid = socket.data.firebaseUid;
  if (!uid) return;

  const auth = await assertCreatorOrAdminForPresenceLookup(uid);
  if (!auth.ok) {
    socket.emit('user:availability:error', { error: auth.error });
    socket.emit('user:availability:batch', {});
    return;
  }

  const rateLimit = await checkPresenceLookupRateLimit(socket.id);
  if (!rateLimit.allowed) {
    socket.emit('user:availability:error', { error: 'RATE_LIMIT_EXCEEDED' });
    socket.emit('user:availability:batch', {});
    return;
  }

  const cappedUids = capPresenceLookupBatch(firebaseUids);
  const availability = await getBatchUserAvailability(cappedUids);
  socket.emit('user:availability:batch', availability);
});
```

**Also applied to** `availability:get` (creator presence batch) — same guard, cap, and rate limit; returns empty batches on deny (no new error event on that handler).

**Environment variables**

| Variable | Default | Purpose |
|----------|---------|---------|
| `PRESENCE_LOOKUP_AUTH_ENFORCED` | `true` | Set `false` for one-release rollback |
| `PRESENCE_BATCH_LOOKUP_MAX` | `100` | Max UIDs per batch |
| `PRESENCE_LOOKUP_RATE_LIMIT_MAX` | `20` | Requests per socket per window |
| `PRESENCE_LOOKUP_RATE_LIMIT_WINDOW_SECONDS` | `60` | Rate limit window |

**Rollback**  
`PRESENCE_LOOKUP_AUTH_ENFORCED=false`

---

## Phase 2 — Distributed Safety Hardening

### Foundation — Shared distributed lock utility

**Files**
- `src/utils/distributed-lock.ts` (new)
- `src/config/redis.ts`
- `src/modules/billing/billing-reconciliation.ts`
- `src/utils/distributed-lock.contract.test.ts` (new)

**Problem**  
Lock logic was duplicated inline in `billing-reconciliation.ts` with no structured ownership logging. Watchdog, VIP recon, and domain worker had no cluster locks.

**New lock keys** (`redis.ts`)

```typescript
export const BILLING_WATCHDOG_LOCK_KEY = 'lock:billing:watchdog';
export const VIP_RECONCILIATION_LOCK_KEY = 'lock:vip:reconciliation';
export const DOMAIN_EVENT_WORKER_LOCK_KEY = 'lock:domain_events:worker';
```

**Before** (`billing-reconciliation.ts` — inline lock)

```typescript
const RELEASE_LOCK_LUA = `if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) end return 0`;

async function withBillingReconciliationLock(task: () => Promise<void>): Promise<void> {
  const token = randomUUID();
  const lockResult = await redis.set(BILLING_RECONCILIATION_LOCK_KEY, token, 'PX', TTL, 'NX');
  if (lockResult !== 'OK') {
    recordBillingMetric('reconciliation_skipped_lock_busy', 1, {});
    return;
  }
  const heartbeat = setInterval(() => {
    redis.set(BILLING_RECONCILIATION_LOCK_KEY, token, 'PX', TTL, 'XX').catch(() => {});
  }, TTL / 3);
  try { await task(); } finally {
    clearInterval(heartbeat);
    await redis.eval(RELEASE_LOCK_LUA, 1, BILLING_RECONCILIATION_LOCK_KEY, token);
  }
}
```

**After** (`distributed-lock.ts` — shared utility)

```typescript
export async function acquireDistributedLock(options: DistributedLockOptions): Promise<DistributedLockHandle | null> {
  const lockResult = await redis.set(options.key, token, 'PX', options.ttlMs, 'NX');
  if (lockResult !== 'OK') {
    logLockEvent('lock.skipped', options.key, options.ownerId);
    options.onSkipped?.();
    return null;
  }
  logLockEvent('lock.acquired', options.key, options.ownerId, { ttlMs: options.ttlMs });
  // optional heartbeat with lock.heartbeat_failed on renewal failure
  return { key, token, ownerId, release: async () => { /* lock.released */ } };
}

export async function withDistributedLock(options, task): Promise<boolean> {
  const handle = await acquireDistributedLock(options);
  if (!handle) return false;
  try { await task(); return true; } finally { await handle.release(); }
}
```

**After** (`billing-reconciliation.ts` — migrated)

```typescript
import { withDistributedLock } from '../../utils/distributed-lock';
import { getBillingInstanceId } from './billing-instance-id';

async function withBillingReconciliationLock(task: () => Promise<void>): Promise<void> {
  await withDistributedLock(
    {
      key: BILLING_RECONCILIATION_LOCK_KEY,
      ttlMs: RECONCILIATION_LOCK_TTL_MS,
      ownerId: getBillingInstanceId(),
      heartbeat: true,
      onSkipped: () => recordBillingMetric('reconciliation_skipped_lock_busy', 1, {}),
    },
    task
  );
}
```

**Lock log events** (all locks via shared utility)

| Event | Level | Fields |
|-------|-------|--------|
| `lock.acquired` | info | `instanceId`, `lockKey`, `ttlMs` |
| `lock.released` | info | `instanceId`, `lockKey` |
| `lock.skipped` | info | `instanceId`, `lockKey` |
| `lock.expired` | warn | `instanceId`, `lockKey`, `reason` |
| `lock.heartbeat_failed` | warn | `instanceId`, `lockKey` |

**Owner token**  
`getBillingInstanceId()` → `BILLING_INSTANCE_ID` env or `hostname:pid`.

---

### 1. Billing watchdog cluster safety

**Files**
- `src/modules/billing/billing-watchdog.service.ts`
- `src/modules/billing/billing-watchdog.lock.contract.test.ts` (new)

**Problem**  
Every `billing-worker` replica ran `setInterval(runWatchdogPass)` — concurrent recovery attempts when scaled horizontally.

**Before**

```typescript
export function startBillingWatchdog(io: Server): void {
  watchdogTimer = setInterval(() => {
    runWatchdogPass(io).catch((err) => logError('Billing watchdog pass failed', err, {}));
  }, WATCHDOG_INTERVAL_MS);
}

export function stopBillingWatchdog(): void {
  if (!watchdogTimer) return;
  clearInterval(watchdogTimer);
  watchdogTimer = null;
}
```

**After**

```typescript
let activeWatchdogLock: DistributedLockHandle | null = null;

function isWatchdogClusterLockEnabled(): boolean {
  return process.env.BILLING_WATCHDOG_CLUSTER_LOCK !== 'false';
}

async function runWatchdogPassWithLock(io: Server): Promise<void> {
  if (!isWatchdogClusterLockEnabled()) {
    await runWatchdogPass(io);
    return;
  }
  const handle = await acquireDistributedLock({
    key: BILLING_WATCHDOG_LOCK_KEY,
    ttlMs: WATCHDOG_INTERVAL_MS * 3,
    ownerId: getBillingInstanceId(),
    heartbeat: true,
    onSkipped: () => recordBillingMetric('billing.watchdog.lock_skipped', 1, {}),
  });
  if (!handle) return;

  recordBillingMetric('billing.watchdog.lock_acquired', 1, {});
  activeWatchdogLock = handle;
  try {
    await runWatchdogPass(io);
  } finally {
    await handle.release();
    if (activeWatchdogLock === handle) activeWatchdogLock = null;
  }
}

export function startBillingWatchdog(io: Server): void {
  watchdogTimer = setInterval(() => {
    runWatchdogPassWithLock(io).catch(/* ... */);
  }, WATCHDOG_INTERVAL_MS);
}

export function stopBillingWatchdog(): void {
  clearInterval(watchdogTimer);
  watchdogTimer = null;
  const lock = activeWatchdogLock;
  if (lock) {
    void lock.release();
    activeWatchdogLock = null;
  }
}
```

**Rollback**  
`BILLING_WATCHDOG_CLUSTER_LOCK=false`

---

### 2. VIP reconciliation cluster lock + idempotency

**File** `src/modules/vip/vip-scheduling.reconciliation.ts`

**Problem**  
No cluster lock; emit happened **before** `reminderSentAt` update — duplicate `vip:scheduled_call:due` across replicas.

**Before**

```typescript
for (const call of dueCalls) {
  const io = getIO();
  io.to(`user:${call.creatorFirebaseUid}`).emit('vip:scheduled_call:due', { ... });

  await ScheduledCall.updateOne(
    { _id: call._id },
    { $set: { reminderSentAt: now } },
  );
}

async function tick(): Promise<void> {
  await expireStaleQueueEntries();
  await processDueScheduledCalls();
}

timer = setInterval(() => { void tick(); }, intervalMs);
```

**After**

```typescript
for (const call of dueCalls) {
  const claimed = await ScheduledCall.findOneAndUpdate(
    { _id: call._id, reminderSentAt: null },
    { $set: { reminderSentAt: now } },
    { new: true }
  ).lean();
  if (!claimed) continue;

  const io = getIO();
  io.to(`user:${claimed.creatorFirebaseUid}`).emit('vip:scheduled_call:due', { ... });
}

async function tickWithLock(intervalMs: number): Promise<void> {
  await withDistributedLock(
    {
      key: VIP_RECONCILIATION_LOCK_KEY,
      ttlMs: Math.max(intervalMs * 2, 30_000),
      ownerId: getBillingInstanceId(),
      heartbeat: true,
    },
    tick
  );
}

timer = setInterval(() => { void tickWithLock(intervalMs); }, intervalMs);
```

**Defense in depth**  
Atomic Mongo claim ensures only one replica emits even if lock TTL races.

---

### 3. Domain event worker safety

**Files**
- `src/modules/events/domain-event.worker.ts`
- `src/modules/events/domain-event.service.ts`
- `src/modules/events/domain-event.model.ts`
- `src/modules/events/domain-event.types.ts`

**Problem**  
`DomainEvent.find({ status: 'pending' })` returned the same batch on every replica when `DOMAIN_EVENTS_ENABLED=true` (off by default).

**Before** (`domain-event.service.ts`)

```typescript
export async function processPendingDomainEvents(limit = 50): Promise<number> {
  const batch = await DomainEvent.find({ status: 'pending' })
    .sort({ createdAt: 1 })
    .limit(limit)
    .lean();

  for (const doc of batch) {
    await dispatchDomainEventPayload(doc.eventType, doc.payload);
    await DomainEvent.updateOne({ _id: doc._id }, { $set: { status: 'processed', ... } });
  }
}
```

**Before** (`domain-event.worker.ts`)

```typescript
timer = setInterval(() => {
  processPendingDomainEvents(50)
    .then((n) => { lastProcessedCount = n; lastProcessAt = new Date(); })
    .catch(/* ... */);
}, intervalMs);
```

**After** (`domain-event.model.ts`)

```typescript
status: {
  enum: ['pending', 'processing', 'processed', 'failed', 'dead'],
},
claimedBy: { type: String },
claimedAt: { type: Date },
```

**After** (`domain-event.service.ts`)

```typescript
async function resetStaleDomainEventClaims(): Promise<void> {
  const cutoff = new Date(Date.now() - DOMAIN_EVENT_CLAIM_TTL_MS); // default 120s
  await DomainEvent.updateMany(
    { status: 'processing', claimedAt: { $lt: cutoff } },
    { $set: { status: 'pending' }, $unset: { claimedBy: 1, claimedAt: 1 } }
  );
}

async function claimNextPendingDomainEvent(instanceId: string) {
  return DomainEvent.findOneAndUpdate(
    { status: 'pending' },
    { $set: { status: 'processing', claimedBy: instanceId, claimedAt: now } },
    { sort: { createdAt: 1 }, new: true }
  ).lean();
}

export async function processPendingDomainEvents(limit = 50): Promise<number> {
  await resetStaleDomainEventClaims();
  const instanceId = getBillingInstanceId();
  for (let i = 0; i < limit; i++) {
    const doc = await claimNextPendingDomainEvent(instanceId);
    if (!doc) break;
    // dispatch → processed, or retry → pending/dead
  }
}
```

**After** (`domain-event.worker.ts`)

```typescript
timer = setInterval(() => {
  withDistributedLock(
    {
      key: DOMAIN_EVENT_WORKER_LOCK_KEY,
      ttlMs: Math.max(intervalMs * 3, 15_000),
      ownerId: getBillingInstanceId(),
      heartbeat: true,
    },
    async () => {
      const n = await processPendingDomainEvents(50);
      lastProcessedCount = n;
      lastProcessAt = new Date();
    }
  ).catch(/* ... */);
}, intervalMs);
```

**Note**  
Do not enable `DOMAIN_EVENTS_ENABLED=true` in production until Milestone A staging validates claim + lock behavior.

---

## New documentation and staging tooling

| File | Purpose |
|------|---------|
| `docs/DISTRIBUTED_JOB_SAFETY_MATRIX.md` | Post–Milestone A job safety categories and lock keys |
| `docs/MILESTONE_A_STAGING_RUNBOOK.md` | Deploy checklist, rolling deploy test, Redis disconnect test |
| `scripts/assert-no-double-settlement.ts` | Mongo aggregation — zero duplicate billing debits per `callId` + `billingSequence` |

**Double-settlement assertion**

```bash
tsx scripts/assert-no-double-settlement.ts
```

```javascript
db.cointransactions.aggregate([
  { $match: { type: 'debit', source: 'billing' } },
  { $group: { _id: { callId: '$callId', bucket: '$billingSequence' }, count: { $sum: 1 } } },
  { $match: { count: { $gt: 1 } } }
])
```

---

## New and updated tests

Added to `package.json` `test` script:

| Test file | Validates |
|-----------|-----------|
| `billing-rest-access.contract.test.ts` | Auth parity cases (extended) |
| `server.signed-webhook.contract.test.ts` | VIP path in `isSignedWebhookPost` |
| `moments.gateway.contract.test.ts` | `user:{firebaseUid}` room |
| `presence-lookup-access.contract.test.ts` | Guard + env flag wiring |
| `distributed-lock.contract.test.ts` | Lock logging + recon migration |
| `billing-watchdog.lock.contract.test.ts` | Cluster lock + SIGTERM release |

**Verification run**

```bash
npm run type-check
npx tsx --test src/modules/billing/billing-rest-access.contract.test.ts \
  src/server.signed-webhook.contract.test.ts \
  src/modules/moments/moments.gateway.contract.test.ts \
  src/modules/availability/presence-lookup-access.contract.test.ts \
  src/utils/distributed-lock.contract.test.ts \
  src/modules/billing/billing-watchdog.lock.contract.test.ts
```

---

## Complete file manifest

### Modified (22)

```
src/modules/billing/billing-socket.gateway.ts
src/modules/billing/billing-rest-access.contract.test.ts
src/server.ts
src/modules/moments/moments.gateway.ts
src/modules/stream/stream-upload-session.service.ts
src/modules/stream/stream.controller.ts
src/modules/availability/availability.gateway.ts
src/config/redis.ts
src/modules/billing/billing-reconciliation.ts
src/modules/billing/billing-watchdog.service.ts
src/modules/vip/vip-scheduling.reconciliation.ts
src/modules/events/domain-event.worker.ts
src/modules/events/domain-event.service.ts
src/modules/events/domain-event.model.ts
src/modules/events/domain-event.types.ts
package.json
```

### Created (10)

```
src/modules/availability/presence-lookup-access.ts
src/utils/distributed-lock.ts
src/server.signed-webhook.contract.test.ts
src/modules/moments/moments.gateway.contract.test.ts
src/modules/availability/presence-lookup-access.contract.test.ts
src/utils/distributed-lock.contract.test.ts
src/modules/billing/billing-watchdog.lock.contract.test.ts
docs/DISTRIBUTED_JOB_SAFETY_MATRIX.md
docs/MILESTONE_A_STAGING_RUNBOOK.md
scripts/assert-no-double-settlement.ts
```

---

## Rollback reference

| Change | Rollback |
|--------|----------|
| Socket auth | Revert `billing-socket.gateway.ts` handler block |
| VIP raw body | Remove `/api/v1/vip/webhook` from `isSignedWebhookPost()` |
| Media room | Revert `emitMediaReady` + remove `firebaseUid` from session |
| Presence auth | `PRESENCE_LOOKUP_AUTH_ENFORCED=false` |
| Watchdog lock | `BILLING_WATCHDOG_CLUSTER_LOCK=false` |
| VIP/domain locks | Revert lock wrappers (atomic VIP claim safe to keep) |

---

## What remains unsafe (intentionally deferred)

| Item | Milestone | Mitigation until fixed |
|------|-----------|------------------------|
| Presence heartbeat sweep (node-local maps) | B — Phase 3 | ALB stickiness on multi `api-ws` |
| Staff wallet reconciliation | Optional P2 | Do not enable `STAFF_WALLET_RECONCILE_ENABLED` at scale |
| Unbounded Mongo queries | C — Phase 4 | — |
| Terraform / ECS infra | D — Phase 6 | — |

---

## Next steps (ops)

1. Merge PR1 (security) and PR2 (locks) per recommended sequence.
2. Deploy to staging with `billing-worker` ≥ 2 tasks.
3. Run [MILESTONE_A_STAGING_RUNBOOK.md](./MILESTONE_A_STAGING_RUNBOOK.md):
   - Static validation checklist
   - Rolling deploy during active WS + billing + BullMQ
   - Redis disconnect simulation
   - `tsx scripts/assert-no-double-settlement.ts`
4. Obtain stakeholder sign-off before starting Milestone B (Phase 3 presence refactor).
