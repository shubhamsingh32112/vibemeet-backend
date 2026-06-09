# Milestone B Implementation Report — Phase 3 Presence Socket Registry

**Date:** 2026-06-09  
**Scope:** Phase 3 (Redis-authoritative presence socket registry) — Milestone B  
**Baseline:** [MILESTONE_A_IMPLEMENTATION_REPORT.md](./MILESTONE_A_IMPLEMENTATION_REPORT.md)  
**Migration runbook:** [PRESENCE_REGISTRY_MIGRATION.md](./PRESENCE_REGISTRY_MIGRATION.md)  
**Job safety matrix:** [DISTRIBUTED_JOB_SAFETY_MATRIX.md](./DISTRIBUTED_JOB_SAFETY_MATRIX.md)

This document records every code change shipped for Milestone B, with **before** and **after** snippets, runtime impact, distributed behavior, rollback knobs, and new tests.

---

## Summary

| PR | Change | Risk addressed |
|----|--------|----------------|
| PR1 | `presence-socket-registry.service.ts` + Redis key helpers | Socket counts node-local only; multi `api-ws` stale presence |
| PR2–PR4 | `presence-socket-tracker.ts` + `availability.gateway.ts` refactor | Cross-node connect/disconnect/grace/heartbeat incorrect |
| PR5 | HEARTBEAT TTL skip in `presence.service.ts` | Redundant Redis MULTI on every heartbeat tick |
| PR6 | Chaos harness + multinode tests + docs | No automated multi-node presence validation |
| PR7 | Shadow removal; registry when flag on | Simplified rollout path post-stabilization |

**Files touched:** 8 modified, 9 new  
**Out of scope (unchanged):** billing, BullMQ, watchdog, reconciliation, VIP workers, `transitionCreatorPresence` event semantics, `creator:status` / `user:status` emit shapes

---

## Architecture — before vs after

### Before (Milestone A)

```
api-ws task A                          api-ws task B
┌─────────────────────┐               ┌─────────────────────┐
│ creatorSocketCounts │               │ creatorSocketCounts │  ← independent
│ activeSocketsBy*    │               │ activeSocketsBy*    │
│ heartbeat intervals │               │ heartbeat intervals │
└─────────┬───────────┘               └─────────┬───────────┘
          │                                       │
          └─────────── Redis (presence state) ────┘
                      creator:availability:{uid}
                      user:availability:{uid}
```

Effective **status** was Redis-authoritative; **socket ownership** was per-process. Multi-tab across nodes → premature offline, missed heartbeats, grace timers blind to cross-node reconnects.

### After (Milestone B, flag enabled)

```
api-ws task A                          api-ws task B
┌─────────────────────┐               ┌─────────────────────┐
│ presence-socket-    │               │ presence-socket-    │
│ tracker (local      │               │ tracker (local      │
│  fallback only)    │               │  fallback only)     │
└─────────┬───────────┘               └─────────┬───────────┘
          │                                       │
          └──── Redis socket registry (shared) ───┘
                presence:sockets:{uid}     ← HSET socketId → record
                presence:hb:owner:{uid}    ← heartbeat lease
                presence:disconnect:grace:{uid}
                creator:availability:{uid} ← unchanged writer
```

---

## New files (PR1–PR7)

| File | Purpose |
|------|---------|
| `src/modules/availability/presence-instance-id.ts` | `getPresenceInstanceId()` for registry ownership |
| `src/modules/availability/presence-registry-flags.ts` | `PRESENCE_REDIS_SOCKET_REGISTRY_ENABLED` gate |
| `src/modules/availability/presence-socket-registry.service.ts` | Lua-backed cluster socket registry |
| `src/modules/availability/presence-socket-tracker.ts` | Local maps + registry routing |
| `src/modules/availability/presence-socket-registry.behavior.test.ts` | Registry unit tests |
| `src/modules/availability/presence-socket-registry.contract.test.ts` | Source contract tests |
| `src/modules/availability/presence-registry-multinode.behavior.test.ts` | Multi-instance simulation |
| `scripts/presence-chaos-harness.ts` | Staging chaos scenarios |
| `docs/PRESENCE_REGISTRY_MIGRATION.md` | Rollout runbook |

---

## PR1 — Registry foundation

### 1. Redis key helpers

**File:** `src/config/redis.ts`

**Before:** No socket-registry keys; only `creator:availability:*`, `creator:presence:*`.

**After:**

```typescript
export const PRESENCE_SOCKETS_KEY_PREFIX = 'presence:sockets:';
export const PRESENCE_HB_OWNER_KEY_PREFIX = 'presence:hb:owner:';
export const PRESENCE_DISCONNECT_GRACE_KEY_PREFIX = 'presence:disconnect:grace:';

export const presenceSocketsKey = (firebaseUid: string): string =>
  `${PRESENCE_SOCKETS_KEY_PREFIX}${firebaseUid}`;

export const presenceHbOwnerKey = (firebaseUid: string): string =>
  `${PRESENCE_HB_OWNER_KEY_PREFIX}${firebaseUid}`;

export const presenceDisconnectGraceKey = (firebaseUid: string): string =>
  `${PRESENCE_DISCONNECT_GRACE_KEY_PREFIX}${firebaseUid}`;
```

**Runtime:** Three new Redis namespaces for cross-node socket coordination. Presence state keys unchanged.

---

### 2. Instance ID helper

**File:** `src/modules/availability/presence-instance-id.ts` (new)

```typescript
export function getPresenceInstanceId(): string {
  const configured = process.env.PRESENCE_INSTANCE_ID?.trim();
  if (configured) return configured;
  return getBillingInstanceId();
}
```

**Runtime:** Each `api-ws` task identifies itself in registry records and heartbeat leases. Defaults to `hostname:pid` via billing instance ID pattern.

---

### 3. Feature flags

**File:** `src/modules/availability/presence-registry-flags.ts` (new)

**Before:** No presence registry flags.

**After:**

```typescript
export function isPresenceRegistryEnabled(): boolean {
  return process.env.PRESENCE_REDIS_SOCKET_REGISTRY_ENABLED === 'true';
}

export function useRegistryAsAuthoritative(): boolean {
  return isPresenceRegistryEnabled();
}
```

| Env var | Default | Effect |
|---------|---------|--------|
| `PRESENCE_REDIS_SOCKET_REGISTRY_ENABLED` | `false` | Registry authoritative for socket lifecycle |
| `PRESENCE_REGISTRY_SHADOW` | `false` | Dual-write + mismatch telemetry only; local tracker stays authoritative |
| `PRESENCE_INSTANCE_ID` | billing instance id | Override per-task identity |
| `PRESENCE_SOCKET_REGISTRY_TTL_SECONDS` | `CREATOR_PRESENCE_TTL + 30` | Registry hash TTL (see Operational semantics) |
| `PRESENCE_HEARTBEAT_TTL_SKIP_ENABLED` | `true` | Skip redundant HEARTBEAT MULTI |

**Rollback:** `PRESENCE_REDIS_SOCKET_REGISTRY_ENABLED=false` on all `api-ws` tasks → local-map behavior via tracker.

---

### 4. Registry service (Lua-backed)

**File:** `src/modules/availability/presence-socket-registry.service.ts` (new)

**Before:** No Redis socket registry. Socket.IO Redis adapter handled **broadcasts only**, not connection ownership.

**After — Redis schema:**

| Key | Type | Purpose |
|-----|------|---------|
| `presence:sockets:{uid}` | HASH | `socketId → {instanceId, version, connectedAt, role}` |
| `presence:hb:owner:{uid}` | STRING + PX | Heartbeat lease (one writer per uid cluster-wide) |
| `presence:disconnect:grace:{uid}` | STRING + PX | Coordinated disconnect grace token |

**After — public API:**

```typescript
registerSocket(uid, socketId, role): Promise<{ count, version, isFirst }>
unregisterSocket(uid, socketId, version): Promise<{ count, removed }>
getSocketCount(uid): Promise<number>
hasAnySocket(uid): Promise<boolean>
tryAcquireHeartbeatLease(uid): Promise<boolean>
renewHeartbeatLease(uid): Promise<boolean>   // also EXPIREs hash when HLEN > 0
releaseHeartbeatLease(uid): Promise<void>
isHeartbeatLeaseHolder(uid): Promise<boolean>
startDisconnectGrace(uid): Promise<{ token }>
cancelDisconnectGrace(uid, token): Promise<boolean>
isDisconnectGraceActive(uid): Promise<boolean>
listSocketIds(uid)  // DEBUG/TESTS ONLY — gated by PRESENCE_REGISTRY_DEBUG
```

**TTL authority rules (non-negotiable):** `EXPIRE presence:sockets:{uid}` only in:
1. `registerSocket` (Lua: HSET + EXPIRE)
2. `renewHeartbeatLease` when lease holder and HLEN > 0
3. `unregisterSocket` when partial HDEL leaves HLEN > 0; `DEL` when last socket

**Registry TTL vs presence TTL (`+30s` margin):** Registry hash TTL defaults to `CREATOR_PRESENCE_TTL_SECONDS + 30`. This is intentional — the socket registry must **outlive** `creator:availability:{uid}` presence-state keys so connected sockets are not orphaned during heartbeat gaps, HEARTBEAT TTL skip windows, or transient lease handoffs. **Do not equalize these TTLs** without a full regression review; shortening registry TTL to match presence TTL can cause premature hash expiry while sockets are still connected.

**Stale disconnect protection:** `unregisterSocket` ignores HDEL if stored `version` does not match (reconnect incremented version).

---

## PR2–PR4 — Gateway integration

### 5. Socket tracker abstraction

**File:** `src/modules/availability/presence-socket-tracker.ts` (new)

**Before:** Gateway owned all local Maps directly.

**After:** Tracker owns local Maps; when `useRegistryAsAuthoritative()`:

```typescript
// Connect path
const local = incrementLocal(uid, socketId, role);
if (!useRegistryAsAuthoritative()) return local;
const reg = await registry.registerSocket(uid, socketId, role);
return { count: reg.count, isFirstSocket: reg.isFirst, socketVersion: reg.version, ... };

// Disconnect path — same pattern with unregisterSocket(uid, socketId, version)
```

**Distributed behavior:** Local maps remain for rollback (`flag=false`) and narrow race-window fallback on this node. Registry is source of truth when flag is on.

---

### 6. Gateway state — Maps removed from gateway

**File:** `src/modules/availability/availability.gateway.ts`

**Before:**

```typescript
const creatorSocketCounts = new Map<string, number>();
const userSocketCounts = new Map<string, number>();
const activeSocketsByUser = new Map<string, Set<string>>();
const activeSocketsByCreator = new Map<string, Set<string>>();
// ... heartbeat intervals, last heartbeat timestamps
```

**After:**

```typescript
// Heartbeat / grace timers (per-process scheduling; socket counts live in presence-socket-tracker)
const creatorHeartbeatIntervals = new Map<string, NodeJS.Timeout>();
const creatorDisconnectTimers = new Map<string, NodeJS.Timeout>();
const userHeartbeatIntervals = new Map<string, NodeJS.Timeout>();
const lastCreatorHeartbeatAtMs = new Map<string, number>();
const lastUserHeartbeatAtMs = new Map<string, number>();
const creatorGraceTokens = new Map<string, string>();

import { onCreatorConnect, onCreatorDisconnect, hasAnyConnectedSocket, registry, ... } from './presence-socket-tracker';
```

Socket ref-counts moved to tracker; gateway keeps only interval/timer scheduling state.

---

### 7. `creatorHasAnyConnectedSocket` → cluster-wide check

**Before:**

```typescript
function creatorHasAnyConnectedSocket(io: Server, firebaseUid: string): boolean {
  const tracked = activeSocketsByCreator.get(firebaseUid);
  // ... scan local activeSocketsByCreator ...
  for (const [, socketInstance] of io.sockets.sockets) {
    // ... full local io.sockets scan ...
  }
  return false;
}
```

**After:** Removed. Replaced by async `hasAnyConnectedSocket(io, uid, role)` from tracker:

```typescript
export async function hasAnyConnectedSocket(io, uid, role): Promise<boolean> {
  if (useRegistryAsAuthoritative()) {
    if (await registry.hasAnySocket(uid)) return true;
    return localConnectedCheckOnThisNode(io, uid, role); // narrow race-window fallback
  }
  // legacy local-only path when flag=false
}
```

**Distributed behavior:** With flag on, disconnect grace and heartbeat use cluster-wide `HLEN`, not single-node socket scan.

---

### 8. Connect / disconnect handlers

**Before (creator connect):**

```typescript
const currentCount = creatorSocketCounts.get(firebaseUid) ?? 0;
creatorSocketCounts.set(firebaseUid, currentCount + 1);
activeSocketsByCreator.get(firebaseUid)!.add(socket.id);
if (currentCount === 0) {
  await restoreCreatorRuntimeFromIntent(io, firebaseUid, '...');
}
```

**After:**

```typescript
const connectResult = await onCreatorConnect(firebaseUid, socket.id);
if (connectResult.socketVersion != null) {
  storeSocketVersion(socket, connectResult.socketVersion);
}
if (connectResult.isFirstSocket) {
  clearCreatorDisconnectTimer(firebaseUid);
  const graceToken = creatorGraceTokens.get(firebaseUid);
  if (graceToken && useRegistryAsAuthoritative()) {
    await registry.cancelDisconnectGrace(firebaseUid, graceToken);
    creatorGraceTokens.delete(firebaseUid);
  }
  await restoreCreatorRuntimeFromIntent(io, firebaseUid, 'availability.gateway.connect_first_socket');
}
```

**Before (creator disconnect last socket):**

```typescript
if (nextCount === 0) {
  stopCreatorHeartbeat(uid);
  if (creatorHasAnyConnectedSocket(io, uid)) { /* skip */ }
  else scheduleCreatorDisconnectTransition(io, uid, '...');
}
```

**After:**

```typescript
const disconnectResult = await onCreatorDisconnect(uid, socket.id, getSocketVersion(socket));
if (disconnectResult.isLastSocket) {
  stopCreatorHeartbeat(uid);
  if (await hasAnyConnectedSocket(io, uid, 'creator')) { /* skip */ }
  else scheduleCreatorDisconnectTransition(io, uid, 'availability.gateway.disconnect_last_socket');
}
```

User connect/disconnect follows the same tracker pattern. Inline user heartbeat `setInterval` replaced by extracted `startUserHeartbeat()`.

---

### 9. Redis-coordinated disconnect grace

**Before:**

```typescript
function scheduleCreatorDisconnectTransition(io, firebaseUid, source): void {
  clearCreatorDisconnectTimer(firebaseUid);
  const timer = setTimeout(async () => {
    if (creatorHasAnyConnectedSocket(io, firebaseUid)) return;
    await transitionCreatorPresence(io, firebaseUid, 'DISCONNECTED', source);
  }, CREATOR_DISCONNECT_GRACE_MS);
  creatorDisconnectTimers.set(firebaseUid, timer);
}
```

**After:**

```typescript
function scheduleCreatorDisconnectTransition(io, firebaseUid, source): void {
  void (async () => {
    let graceToken: string | undefined;
    if (useRegistryAsAuthoritative()) {
      const grace = await registry.startDisconnectGrace(firebaseUid);
      graceToken = grace.token;
      creatorGraceTokens.set(firebaseUid, graceToken);
    }
    const timer = setTimeout(async () => {
      if (await hasAnyConnectedSocket(io, firebaseUid, 'creator')) {
        recordCallMetric('presence.grace_callback_skipped', 1, { reason: 'has_socket' });
        return;
      }
      if (useRegistryAsAuthoritative()) {
        const graceStillActive = await registry.isDisconnectGraceActive(firebaseUid);
        if (!graceStillActive) {
          recordCallMetric('presence.grace_callback_skipped', 1, { reason: 'grace_cancelled' });
          return;
        }
      }
      await transitionCreatorPresence(io, firebaseUid, 'DISCONNECTED', source);
    }, CREATOR_DISCONNECT_GRACE_MS);
    creatorDisconnectTimers.set(firebaseUid, timer);
  })();
}
```

**Triple guard before `DISCONNECTED`:** `hasAnySocket` + grace token active + idempotent transition.

**Grace coordination hierarchy (explicit):**

| Layer | Role | On Redis failure |
|-------|------|------------------|
| **`hasAnySocket(uid)`** | **Authoritative** — must pass before `DISCONNECTED` | Fail-safe: if Redis read fails, local-node connected check used as narrow fallback |
| **Grace token (`presence:disconnect:grace:{uid}`)** | **Secondary** — cross-node coordination aid | **Best-effort** — `startDisconnectGrace` returns token even if Redis SET fails; local timer still schedules |
| **Local `setTimeout`** | Per-process scheduling primitive | Always runs; guarded by checks above |

If grace token write fails but reconnect occurs on another node, `hasAnySocket` still blocks false offline. Grace token absence means `isDisconnectGraceActive` may return false and emit `presence.grace_callback_skipped` with `reason=grace_cancelled` — safe because the authoritative socket check runs first.

---

### 10. Heartbeat lease — creator and user

**Before:**

```typescript
function startCreatorHeartbeat(io, firebaseUid): void {
  const heartbeatInterval = setInterval(async () => {
    const activeSockets = activeSocketsByCreator.get(firebaseUid);
    // ... local socket verification ...
    await transitionCreatorPresence(io, firebaseUid, 'HEARTBEAT', '...');
  }, HEARTBEAT_INTERVAL);
}
```

**After:**

```typescript
async function startCreatorHeartbeat(io, firebaseUid): Promise<void> {
  if (useRegistryAsAuthoritative()) {
    const acquired = await registry.tryAcquireHeartbeatLease(firebaseUid);
    if (!acquired) return;
  }
  const heartbeatInterval = setInterval(async () => {
    // Check #1 — tick start
    if (useRegistryAsAuthoritative() && !(await registry.isHeartbeatLeaseHolder(firebaseUid))) {
      stopCreatorHeartbeat(firebaseUid); return;
    }
    await registry.renewHeartbeatLease(firebaseUid);

    if (!(await hasAnyConnectedSocket(io, firebaseUid, 'creator'))) {
      await transitionCreatorPresence(io, firebaseUid, 'DISCONNECTED', '...');
      return;
    }

    // Check #2 — immediately before write (split-brain guard)
    if (useRegistryAsAuthoritative() && !(await registry.isHeartbeatLeaseHolder(firebaseUid))) {
      recordCallMetric('presence.heartbeat_lease_lost_before_write', 1, { role: 'creator' });
      stopCreatorHeartbeat(firebaseUid); return;
    }
    await transitionCreatorPresence(io, firebaseUid, 'HEARTBEAT', '...');
  }, HEARTBEAT_INTERVAL);
}
```

`startUserHeartbeat()` mirrors the same two lease checks before `refreshUserAvailability()`.

**Lease renew failure policy (explicit):**

| Condition | Behavior | Rationale |
|-----------|----------|-----------|
| `renewHeartbeatLease` returns `false` (not holder / stale lease) | **Stop interval immediately** | Avoid double writers; next tick must not write without lease |
| `renewHeartbeatLease` throws (Redis timeout, partition, connection error) | **Stop interval immediately** + `presence.heartbeat_lease_renew_failed` metric | Same as above — retrying on next tick risks split-brain writes |
| `isHeartbeatLeaseHolder` false before write | **Stop interval** + `presence.heartbeat_lease_lost_before_write` | Split-brain guard |
| Other heartbeat errors (e.g. `transitionCreatorPresence` throw) | **Log + retry next tick** | Presence state write failure does not imply lease loss; next holder may recover |

Implementation: `renewHeartbeatLeaseOrStop()` in `availability.gateway.ts` wraps renew in try/catch and always calls `stopCreatorHeartbeat` / `stopUserHeartbeat` on failure.

**Distributed behavior:** Exactly one task holds `presence:hb:owner:{uid}` and runs heartbeat per uid at steady state.

---

### 11. Sweeps — cluster-wide socket checks

**Before (`sweepStaleHeartbeats`):**

```typescript
const sockets = activeSocketsByCreator.get(uid);
const hasConnectedSocket = !!sockets && Array.from(sockets).some((socketId) => {
  const s = io.sockets.sockets.get(socketId);
  return Boolean(s && s.connected);
});
```

**After:**

```typescript
const hasConnectedSocket = await hasAnyConnectedSocket(io, uid, 'creator');
```

**Before (`cleanupStaleSocketTracking`):** Scanned local Maps; could force offline based on single-node state.

**After (flag on):** Compares registry `getSocketCount` vs local tracker orphans; cleans local Maps only — **never** `EXPIRE`s registry hashes from sweeps.

---

## PR5 — HEARTBEAT TTL skip

**File:** `src/modules/availability/presence.service.ts`

**Before:** Every `HEARTBEAT` event ran full Redis MULTI (3 keys) regardless of remaining TTL.

**After:**

```typescript
if (
  eventType === 'HEARTBEAT' &&
  process.env.PRESENCE_HEARTBEAT_TTL_SKIP_ENABLED !== 'false'
) {
  const ttl = await redis.ttl(availabilityKey(firebaseUid));
  if (
    ttl > PRESENCE_TTL_SECONDS * 0.5 &&
    nextState === current.state &&
    nextBase === current.base
  ) {
    recordCallMetric('presence.heartbeat_ttl_skip', 1, { endpointMode });
    return { state: current.state, updatedAt: current.updatedAt, source: current.source, version: current.version };
  }
}
```

**Runtime:** Skips redundant presence-state writes when TTL > 50% and state unchanged. Safe because `HEARTBEAT` preserves base availability. Registry hash TTL maintained by lease holder via `renewHeartbeatLease`.

**Rollback:** `PRESENCE_HEARTBEAT_TTL_SKIP_ENABLED=false`

---

## PR6 — Observability, chaos, docs

### 12. Metrics handler

**File:** `src/bootstrap/metrics-handler.ts`

**Before:**

```typescript
const creatorStatusPropagation = byName['presence.creator_status_propagation_ms'];
// (wrong prefix — metric emitted as call.presence.*)
```

**After:**

```typescript
const creatorStatusPropagation = byName['call.presence.creator_status_propagation_ms'];
const registryShadowMismatch = byName['call.presence.registry.shadow_mismatch'];
const registryRegister = byName['call.presence.registry.register'];
const registryUnregister = byName['call.presence.registry.unregister'];
const heartbeatLeaseLost = byName['call.presence.heartbeat_lease_lost_before_write'];
const graceCallbackSkipped = byName['call.presence.grace_callback_skipped'];
const heartbeatTtlSkip = byName['call.presence.heartbeat_ttl_skip'];

// presence JSON block includes:
registryShadowMismatch, registryRegister, registryUnregister,
heartbeatLeaseLostBeforeWrite, graceCallbackSkipped, heartbeatTtlSkip
```

---

### 13. Job safety matrix

**File:** `docs/DISTRIBUTED_JOB_SAFETY_MATRIX.md`

**Before:**

```markdown
| Presence heartbeat sweep | ... | **Unsafe** | none | Blocked until Milestone B (Phase 3) |
- **api-ws:** Keep ALB stickiness until Phase 3 presence registry; heartbeat sweep remains unsafe across tasks.
```

**After:**

```markdown
| Presence heartbeat sweep | ... | **Safe when `PRESENCE_REDIS_SOCKET_REGISTRY_ENABLED=true`** | Redis socket registry | Unsafe with local Maps only |
- **api-ws:** With `PRESENCE_REDIS_SOCKET_REGISTRY_ENABLED=true`, heartbeat sweep uses cluster-wide `hasAnySocket`; ALB stickiness optional.
```

---

### 14. Chaos harness

**File:** `scripts/presence-chaos-harness.ts` (new)  
**Script:** `npm run chaos:presence`

Formal pass/fail matrix:

| Outcome | Verdict |
|---------|---------|
| Transient count skew (±1, <1s) | Allow |
| Duplicate online emits | Allow |
| Negative registry count | **Fail** |
| False offline > grace while connected | **Fail** |
| Stuck online > TTL + grace + 5s | **Fail** |

Scenarios: ECS task death budget, 1k reconnect storm, ALB rebalance, grace + rolling deploy, grace + reconnect storm, Redis brief outage (manual staging).

---

## PR7 — Cleanup (partial; shadow telemetry retained)

**Before:** Shadow dual-write path planned (`PRESENCE_REGISTRY_SHADOW`); gateway owned socket Maps.

**Shipped:**
- Gateway socket Maps removed from `availability.gateway.ts`; tracker owns local state for rollback
- Full `io.sockets` cluster scan removed when registry enabled
- `shouldDualWriteRegistry()` drives registry writes when shadow **or** full registry flag is on

**Deferred (safer for first production release):**
- **Shadow telemetry retained but dormant** — `PRESENCE_REGISTRY_SHADOW=true` dual-writes registry + emits `presence.registry.shadow_mismatch` while local tracker remains authoritative. Default `false`. Recommended for one release after full cutover to catch mobile reconnect storms, ALB rebalance, deploy churn, and regional Redis latency that staging may miss.
- Shadow does **not** change runtime decisions when `PRESENCE_REDIS_SOCKET_REGISTRY_ENABLED=true` (registry stays authoritative; mismatch metrics still emitted if both flags set during canary).

**Not removed:** `PRESENCE_REGISTRY_SHADOW` env, `emitShadowMismatch` in tracker, shadow metrics in `/metrics`.

---

## Operational edge semantics (explicit)

These are **operational edge concerns**, not architecture flaws. Documented so future changes do not regress safety.

### 1. Lease renew failure

**Policy: stop interval immediately — never retry lease renew on the next tick.**

| Condition | Behavior |
|-----------|----------|
| `renewHeartbeatLease` returns `false` | Stop interval immediately |
| `renewHeartbeatLease` throws (timeout, partition) | Stop interval + `presence.heartbeat_lease_renew_failed` |
| Other heartbeat errors (presence write) | Log + retry next tick |

Wrong retry → double writers. Implementation: `renewHeartbeatLeaseOrStop()` in `availability.gateway.ts`.

### 2. Registry TTL > presence TTL (+30s)

Registry hash intentionally **outlives** `creator:availability:{uid}` so socket records survive heartbeat gaps and HEARTBEAT TTL skip. **Do not equalize TTLs** without chaos re-validation.

### 3. Grace token vs hasAnySocket

| Layer | Role |
|-------|------|
| `hasAnySocket(uid)` | **Authoritative** before `DISCONNECTED` |
| Grace token | **Best-effort** secondary; safe if Redis SET fails |
| Local timer | Scheduling only; guarded by `hasAnySocket` |

### 4. Shadow telemetry (dormant, available)

`PRESENCE_REGISTRY_SHADOW=true` — telemetry-only dual-write for one release post-cutover. Default off. Monitor `call.presence.registry.shadow_mismatch`.

---

## Unchanged contracts (explicitly preserved)

| Contract | Status |
|----------|--------|
| `transitionCreatorPresence` event types | Unchanged |
| Redis keys `creator:availability:*`, `creator:presence:*`, `user:availability:*` | Unchanged |
| Socket events `creator:online`, `creator:offline`, `availability:get` | Unchanged |
| Emits `creator:status`, `user:status` | Unchanged |
| Room joins `creators`, `consumers` | Unchanged |
| `presence-lookup-access.ts` auth | Untouched |
| Billing / BullMQ / watchdog | Untouched |

---

## New and updated tests

| File | Type | Coverage |
|------|------|----------|
| `presence-socket-registry.behavior.test.ts` | Behavior | register/unregister, version stale disconnect, lease, grace, TTL authority |
| `presence-socket-registry.contract.test.ts` | Contract | redis key helpers, Lua version check, no `listSocketIds` in gateway, no sweep EXPIRE |
| `presence-registry-multinode.behavior.test.ts` | Behavior | cross-node register, grace cancel, lease split-brain |
| `presence-disconnect.contract.test.ts` | Contract | tracker import, double lease check, grace metrics |
| `presence-resilience.behavior.test.ts` | Behavior | HEARTBEAT TTL skip when TTL > 50% |

**Verification run:**

```powershell
npm run type-check
npx tsx --test src/modules/availability/presence-socket-registry.behavior.test.ts `
  src/modules/availability/presence-socket-registry.contract.test.ts `
  src/modules/availability/presence-registry-multinode.behavior.test.ts `
  src/modules/availability/presence-disconnect.contract.test.ts
```

All presence registry tests pass (22 total across the four files above).

---

## Rollout checklist

1. Deploy code with flag **off** (default) — behavior identical to Milestone A
2. Enable `PRESENCE_REDIS_SOCKET_REGISTRY_ENABLED=true` on staging `api-ws` (≥2 tasks)
3. Run `npm run chaos:presence` on staging
4. Rolling deploy during live creator session — verify no false offline
5. Enable on all production `api-ws` tasks
6. Monitor `/metrics` → `presence.registryRegister`, `presence.graceCallbackSkipped`, `presence.heartbeat_lease_lost_before_write`

**Instant rollback:** `PRESENCE_REDIS_SOCKET_REGISTRY_ENABLED=false` on all `api-ws` tasks.

---

## File change index

| Path | Change |
|------|--------|
| `src/config/redis.ts` | +14 lines (registry key helpers) |
| `src/modules/availability/presence-instance-id.ts` | **new** |
| `src/modules/availability/presence-registry-flags.ts` | **new** |
| `src/modules/availability/presence-socket-registry.service.ts` | **new** (~310 lines) |
| `src/modules/availability/presence-socket-tracker.ts` | **new** (~248 lines) |
| `src/modules/availability/availability.gateway.ts` | refactored (~607 lines changed) |
| `src/modules/availability/presence.service.ts` | +20 lines (HEARTBEAT TTL skip) |
| `src/bootstrap/metrics-handler.ts` | +14 lines (registry metrics + prefix fix) |
| `scripts/presence-chaos-harness.ts` | **new** |
| `docs/PRESENCE_REGISTRY_MIGRATION.md` | **new** |
| `docs/DISTRIBUTED_JOB_SAFETY_MATRIX.md` | heartbeat sweep row updated |
| `package.json` | +3 test files, `chaos:presence` script |
