# Deep Infrastructure & Scale Readiness Audit — zztherapy Backend

**Audit date:** 2026-06-07  
**Scope:** Actual implementation in `backend/src` (not generic advice)  
**Target load:** 100k DAU · 10k concurrent active users · 500 concurrent billed video calls · instant creator presence · realtime Moments feed  
**Target infra:** ECS Fargate · ElastiCache Redis · MongoDB Atlas  

---

## Executive Summary

The backend is a **single monolithic Node.js process** that colocates HTTP API, Socket.IO (with Redis adapter), BullMQ billing workers, and numerous `setInterval` background loops. Core billing and presence logic is **Redis-authoritative** with per-call distributed locks and BullMQ job chaining — this is genuinely production-oriented for horizontal billing.

However, **ECS horizontal scaling is only partially safe today**. Socket.IO multi-node works via `@socket.io/redis-adapter`, but **graceful shutdown is incomplete** (no `httpServer.close()`, immediate `process.exit`), **every replica runs redundant watchdog/reconciliation scans**, and **Moments uses global Socket.IO broadcasts** that amplify fanout at scale.

| Target | Realistic today? | Primary blocker |
|--------|------------------|-----------------|
| 500 concurrent billed calls | **Yes, with tuning** | BullMQ worker concurrency × replica count; Redis ops |
| 10k concurrent active users | **Partial** | Firebase auth on every WS connect; presence heartbeat Redis write rate; event-loop contention |
| 100k DAU | **Yes** (with architecture split) | Mostly API/WS connection count + Mongo pool × replicas |
| Instant creator presence | **Mostly yes** | Cross-instance propagation via Redis adapter adds ~50–500ms p95 (instrumented) |
| Realtime Moments feed | **Partial** | Global `io.emit` storms; fanout queue throughput for celebrity creators |

---

# SECTION 1 — Runtime Topology Reality Check

## 1.1 Initialization order (`server.ts`)

Actual startup sequence in `startServer()`:

| Order | Component | File | Function |
|-------|-----------|------|----------|
| 1 | Firebase Admin | `config/firebase.ts` | `initializeFirebase()` |
| 2 | Security / pricing validation | `server.ts` | `assertProductionSecurity()`, `assertProductionRedis()`, `enforceProductionBillingDriverSafety()` |
| 3 | Event-loop probe | `server.ts` | `setInterval` 1000ms → `recordSystemMetric('event_loop_lag_ms')` |
| 4 | MongoDB | `config/database.ts` | `connectDatabase()` — default `maxPoolSize=50` |
| 5 | Stale creator locks | `video/video.webhook.ts` | `cleanupStaleCreatorLocks()` |
| 6 | CreatorTaskProgress index migration | `server.ts` | inline |
| 7 | Stream Chat push | `config/stream.ts` | `configureStreamPush()` |
| 8 | HTTP + Socket.IO server | `server.ts` | `createServer(app)` + `new SocketIOServer(...)` |
| 9 | Socket.IO Redis adapter | `server.ts` | `createAdapter(pubClient, subClient)` when `SOCKET_IO_REDIS_ADAPTER !== 'false'` |
| 10 | Availability gateway | `availability/availability.gateway.ts` | `setupAvailabilityGateway(io)` |
| 11 | Moments gateway (stub) | `moments/moments.gateway.ts` | `setupMomentsGateway(io)` |
| 12 | Creator presence startup audit | `availability/creator-presence-audit.service.ts` | `auditCreatorPresenceOnStartup()` |
| 13 | Billing socket gateway | `billing/billing-socket.gateway.ts` | `setupBillingGateway(io)` |
| 14 | BullMQ billing worker | `billing/billing-batch.processor.ts` → `billing.queue.ts` | `startGlobalBillingProcessor(io)` → `startBillingBullWorker()` |
| 15 | Termination retry worker | `billing/billing-termination.queue.ts` | `startTerminationRetryWorker()` |
| 16 | Billing reconciliation | `billing/billing-reconciliation.ts` | `startReconciliationJob(io)` — interval **5 min** |
| 17 | Billing watchdog | `billing/billing-watchdog.service.ts` | `startBillingWatchdog(io)` — interval **5s default** |
| 18 | Staff wallet reconciliation | `billing/staff-wallet-reconciliation.scheduler.ts` | `startStaffWalletReconciliationScheduler()` |
| 19 | Domain event worker | `events/domain-event.worker.ts` | `startDomainEventWorker()` — only if `DOMAIN_EVENTS_ENABLED=true` |
| 20 | Billing startup recovery | `billing/billing-recovery.ts` | `verifyStartupRecovery(io)` |
| 21 | Active call slot repair | `video/call-reconciliation.ts` | `repairStaleActiveCallSlotsOnStartup()` |
| 22 | Call reconciliation | `video/call-reconciliation.ts` | `startCallReconciliationJob(io)` — interval **5 min default** |
| 23 | VIP reconciliation | `vip/vip-scheduling.reconciliation.ts` | `startVipReconciliationJob()` |
| 24 | Payment webhook retry | `payment/payment-webhook-retry.service.ts` | `startPaymentWebhookRetryWorker()` |
| 25 | Image pipeline workers | `images/images.bootstrap.ts` | `startImagePipelineWorkers()` — BullMQ blurhash + orphan cleanup |
| 26 | Moments workers | `moments/moments.bootstrap.ts` | `startMomentsWorkers()` |
| 27 | Admin/staff gateway | `admin/admin.gateway.ts` | `setupAdminGateway(io)` — `/admin` namespace |
| 28 | Redis health probe | `server.ts` | ping + setex/get/del |
| 29 | Listen | `server.ts` | `httpServer.listen(PORT, '0.0.0.0')` |

**Module-level intervals** (start before/with server, not inside `startServer`):

| Interval | Period | File |
|----------|--------|------|
| `cleanupOldTaskProgress` | 6 hours | `server.ts` |
| `cleanupStaleCreatorLocks` | 5 minutes | `server.ts` |

## 1.2 Systems in the same Node.js process

Everything below shares **one event loop**:

1. Express HTTP (`/api/v1/*`, `/health`, `/ready`, `/metrics`)
2. Socket.IO main namespace (availability + billing + moments emitters)
3. Socket.IO `/admin` namespace (staff dashboards)
4. BullMQ worker: queue `billing-cycle` (concurrency default **130**)
5. BullMQ worker: queue `billing-termination-retry`
6. BullMQ workers: blurhash + orphan cleanup (when Cloudflare images enabled)
7. Billing reconciliation loop (5 min, Redis lock `lock:reconciliation:billing`)
8. Billing watchdog (5s, **no global lock**)
9. Call reconciliation (5 min, Redis lock `lock:reconciliation:call`)
10. VIP scheduling reconciliation
11. Payment webhook retry worker
12. Moments: analytics drain (30s), fanout drain (5s), feed warm (10s), story expiry (30min), thumbnail HEAD checks (10min), stream session sweeper (15min)
13. Domain event worker (optional, 5s)
14. Staff wallet reconciliation scheduler

## 1.3 Workload classification

| Workload | Event-loop | CPU-bound | Redis-heavy | WS-heavy | Blocking-risk | Latency-sensitive |
|----------|------------|-----------|-------------|----------|---------------|-------------------|
| Billing BullMQ ticks | ✓ | moderate (JSON) | ✓✓✓ | ✓ (throttled emits) | Mongo checkpoint | ✓✓✓ |
| Socket connect + Firebase verify | ✓ | ✓ (crypto) | — | ✓ | Firebase RTT | ✓✓ |
| Presence heartbeats | ✓ | low | ✓✓ | low (no emit on HB) | Mongo on status change | ✓✓ |
| `availability:get` batch | ✓ | low | ✓ (3× MGET) | unicast only | Mongo if card snapshot | ✓ |
| Moments fanout worker | ✓ | low | ✓✓✓ | — | Mongo follower scan | medium |
| Reconciliation SCAN passes | ✓ | low | ✓✓ | — | long SCAN loops | low |
| Thumbnail validation | ✓ | — | — | — | **HTTP HEAD to Cloudflare** | low |
| Blurhash worker | separate BullMQ | ✓✓ | ✓ | — | image decode | low |

## 1.4 What should become separate ECS services first

Based on actual coupling and contention:

1. **`billing-worker` service** — BullMQ `billing-cycle` + `billing-termination-retry` + billing reconciliation + watchdog (no HTTP, no Socket.IO except optional read-only `getIO` refactor)
2. **`moments-worker` service** — `startMomentsWorkers()` + fanout/analytics drains (currently LPOP-competes across replicas but wastes CPU repeating interval loops)
3. **`api-ws` service** — Express + Socket.IO gateways only; scale on connection count
4. **Defer:** image blurhash worker (already BullMQ-isolated; can stay on worker tier)

---

# SECTION 2 — Socket.IO Scalability Audit

## 2.1 Setup (`server.ts`)

```typescript
// server.ts:1219-1227
const io = new SocketIOServer(httpServer, {
  pingTimeout: 60000,
  pingInterval: 25000,
  transports: ['websocket', 'polling'],
});
```

- **Redis adapter:** enabled when Redis configured and `SOCKET_IO_REDIS_ADAPTER !== 'false'`
- Dedicated pub/sub clients (`socket_adapter_pub`, `socket_adapter_sub`) — separate from billing singleton
- **Sticky sessions:** **NOT mandatory** with Redis adapter; room joins work cross-node

## 2.2 Gateways

| Gateway | File | Auth | Rooms |
|---------|------|------|-------|
| Availability | `availability.gateway.ts` | Firebase `verifyIdToken` in `io.use` | `creators`, `consumers` |
| Billing | `billing-socket.gateway.ts` | reuses availability middleware | `user:{firebaseUid}` |
| Moments | `moments.gateway.ts` | none (emit-only helpers) | `userId` for `media:ready` |
| Admin | `admin.gateway.ts` | JWT on `/admin` namespace | `admin`, `bd:{id}`, `agency:{id}` |

## 2.3 Event emit paths (verified)

### `creator:status`

**Single writer:** `transitionCreatorPresence()` in `presence.service.ts:709-710`

```typescript
io.to('consumers').emit('creator:status', statusPayload);
io.to('creators').emit('creator:status', statusPayload);
```

- Emitted when status **changes**, or on `CONNECTED`, `CALL_STARTED`, `CALL_ENDED`, `RECOVERED`
- **NOT emitted on `HEARTBEAT`** (debug log only) — good for scale
- Payload may include `creatorSummary` from `getCreatorFeedCardSnapshot()` — **adds Mongo read on hot path**
- Redis adapter fanout: each emit → pub/sub to all nodes → deliver to all sockets in room

**Scaling risk:** O(connected consumers) per status change. With 10k consumers online, each creator toggle = 10k+ deliveries cluster-wide.

### `availability:get` / `availability:batch`

- Handler: `availability.gateway.ts:648-731`
- Client → server: `availability:get { creatorIds[] }`
- Server → client: `availability:batch` + `availability:batch:v2`
- **Unicast** to requesting socket only — no broadcast storm
- Backend: `getBatchCreatorPresence()` → 3× `MGET` (base, meta, active call keys)

### `user:status`

- `io.to('creators').emit('user:status', ...)` — targeted to creators room only
- Fired on user connect/disconnect/heartbeat-fail — **not** on every user heartbeat refresh

### `billing:update`

- `billing-emitter.service.ts:99-100`

```typescript
io.to(`user:${userFirebaseUid}`).emit('billing:update', userSnapshot);
io.to(`user:${creatorFirebaseUid}`).emit('billing:update', creatorSnapshot);
```

- Throttled: `getBillingEmitIntervalMs()` default **1000ms** (`billing.constants.ts:84-97`)
- Keepalive floor: `getBillingEmitKeepaliveMs()` default **2500ms**
- Emits deferred via `setImmediate` (`emitSoon` in `billing.service.ts:1116-1123`) to reduce event-loop blocking
- **Per active call:** ~2 emits/sec max to 2 rooms (4 socket deliveries if both parties have 1 socket)

### `coins_updated`

- Targeted: `io.to(\`user:${firebaseUid}\`)` from `user.controller.ts`, `payment.controller.ts`, `billing-settlement.service.ts`, `withdrawal-processing.service.ts`, `referral.service.ts`
- Not global — scales linearly with purchase/settlement events

### `media:ready`

- `moments.gateway.ts:27-28`: `ioRef?.to(userId).emit('media:ready', { sessionId })`
- **Targeted** to room named by Mongo `userId` string — clients must join that room (verify client-side)

### Moments global broadcasts (**high risk**)

`moments.gateway.ts` uses **`ioRef?.emit(...)`** (no room filter):

| Event | Trigger |
|-------|---------|
| `moment:uploaded` | `emitMomentUploaded()` |
| `story:uploaded` | `emitStoryUploaded()` |
| `moment:purchased` | `emitMomentPurchased()` |
| `creator:followed` | `emitCreatorFollowed()` |

**These are O(all connected clients) broadcast storms** amplified by Redis adapter to every node.

## 2.4 Reconnect & auth behavior

- **Auth:** every connection runs `admin.auth().verifyIdToken(token)` — `availability.gateway.ts:466-499`
- **No token caching** on socket reconnect — Firebase RTT on every reconnect
- **Role lookup:** Mongo `User.findOne({ firebaseUid }).select('role')` on every connect — `availability.gateway.ts:511`
- **Billing reconnect:** explicitly does **not** settle calls on disconnect — `billing-socket.gateway.ts:960-966`
- Engine.IO heartbeats: 25s ping interval × all connections → baseline WS traffic

## 2.5 Horizontal scaling safety

| Question | Answer |
|----------|--------|
| ECS horizontal scaling safe? | **Mostly yes** for room-targeted events; **risky** for global Moments emits |
| Sticky sessions mandatory? | **No** (Redis adapter) |
| Room fanout expensive? | **`consumers` room** is the fanout bottleneck for `creator:status` |
| Auth bottleneck? | **Yes** — Firebase + Mongo on every connect |
| Heartbeat intervals scalable? | Creator/user app heartbeats **45s default**; engine.io **25s** — acceptable; creator heartbeat still writes Redis MULTI every interval |

## 2.6 Estimated emits per active user (steady state)

| User type | Inbound events/sec (approx) | Outbound events/sec (approx) |
|-----------|----------------------------|------------------------------|
| Consumer (idle) | 0.04 (engine.io ping) | 0.04 + occasional `creator:status` |
| Consumer (on home feed) | + polling `availability:get` (client-driven) | batch responses |
| User in call | + `billing:update` ~1/sec | + `billing:update` ~1/sec |
| Creator online | + heartbeat (none emit) | `creator:status` on changes only |

---

# SECTION 3 — Presence System Deep Audit

## 3.1 Redis key patterns

| Key | Purpose | TTL |
|-----|---------|-----|
| `creator:availability:{uid}` | Base online/offline | `PRESENCE_TTL_SECONDS` (default **180s**, env `CREATOR_PRESENCE_TTL_SECONDS`) |
| `creator:presence:{uid}` | Legacy JSON state | same |
| `creator:presence:meta:{uid}` | Canonical meta (version, source) | same |
| `active:call:user:{uid}` | Active callId → drives `on_call` | 7200s |
| `user:availability:{uid}` | Regular user online | TTL-backed (`user-availability.service.ts`) |
| `presence:online_creators` | Dashboard SET | — |
| `presence:online_by_bd:{bdId}` | Dashboard SET | — |
| `presence:online_by_agency:{agencyId}` | Dashboard SET | — |

## 3.2 Is Redis authoritative?

**Yes.** `transitionCreatorPresence()` writes all three creator keys atomically via `redis.multi()` — `presence.service.ts:594-617`. Mongo `Creator.isOnline` is **intent only** (REST toggle); runtime reads come from Redis via `getBatchCreatorPresence()`.

## 3.3 Heartbeat configuration

From `availability.gateway.ts:22-31`:

- TTL: min(600, max(90, `CREATOR_PRESENCE_TTL_SECONDS`)) → default **180s**
- Heartbeat interval: min(max(20s, TTL−15s), env `CREATOR_HEARTBEAT_INTERVAL_MS`) → default **45s**
- Disconnect grace: `CREATOR_DISCONNECT_GRACE_MS` default **3000ms**
- Stale sweep: every **30s** (`sweepStaleHeartbeats`)
- Socket tracking cleanup: every **10 min**

## 3.4 Race conditions & stale states

| Scenario | Handling | Gap |
|----------|----------|-----|
| Multi-tab creator | In-memory `creatorSocketCounts` per **instance** | Cross-instance relies on Redis TTL + grace |
| Instance crash mid-call | TTL expires → offline | Up to **180s** stale if no other instance picks up |
| Heartbeat succeeds but emit fails | Redis still updated | Clients stale until next `availability:get` |
| Active call slot stale | `clearCreatorActiveCallSlotIfStale` on read paths | Extra Redis/Mongo on hot path |
| `on_call` without active slot | Logged warning `creator_presence_on_call_without_active_call` | Possible transient inconsistency |

**Debouncing:** Heartbeats call `transitionCreatorPresence(..., 'HEARTBEAT')` which **always writes Redis** even when status unchanged — TTL refresh only, no socket emit. Not debounced at Redis layer.

## 3.5 Batch efficiency

`getBatchCreatorPresence()` — 3 parallel `MGET` for N creators — **O(1) round-trips**, not N+1. Optional meta self-heal capped at **3 per batch** (`META_SELF_HEAL_MAX_PER_BATCH`).

## 3.6 Hot keys

- Per-UID keys — **good distribution**
- `presence:online_creators` — single SET updated on every creator online/offline transition — **moderate hot key** for admin dashboards only

## 3.7 Redis ops/sec estimates (presence only)

Assumptions: heartbeat 45s; each creator heartbeat = 1× MULTI (3 SETEX) + 1× GET active call; user heartbeat = 1 SETEX.

| Scale | ~Online creators | ~Online users | Creator HB ops/s | User HB ops/s | Total HB ops/s |
|-------|------------------|---------------|------------------|---------------|----------------|
| 1k active | 150 | 850 | 150/45×4 ≈ **13** | 850/45 ≈ **19** | **~32** |
| 10k active | 1,500 | 8,500 | ≈ **133** | ≈ **189** | **~322** |
| 50k active | 7,500 | 42,500 | ≈ **667** | ≈ **944** | **~1,611** |

Add ~10–30% for status-change writes, `availability:get` MGET (client-driven), and dashboard SET updates.

## 3.8 ECS multi-instance safety

- **Safe** for reads/writes: Redis is shared; last writer wins on version
- **In-memory maps** (`creatorSocketCounts`, heartbeat intervals) are **instance-local** — disconnect on instance A doesn't know about sockets on instance B until grace/TTL
- **Redis adapter** propagates `creator:status` to all nodes — **correct cross-instance**

---

# SECTION 4 — Billing System Production Audit

## 4.1 Driver topology

`billing-driver.ts` **hardcodes** `isBullmqBillingEnabled(): true` — ZSET batch mode is retired (`billing-batch.processor.ts` records `batch_processor_noop`).

**Queue:** `billing-cycle` (`billing.queue.ts:25`)  
**Worker concurrency:** `BILLING_BULLMQ_CONCURRENCY` default **130** (max 200)  
**Tick interval:** `BILLING_PROCESS_INTERVAL_MS` default **450ms**  
**Per-call lock:** `billing:cycle_lock:{callId}` NX + PX TTL 3500ms with heartbeat extend — `billing.service.ts:2531-2544`

## 4.2 Duplicate billing protection

| Mechanism | Key / implementation |
|-----------|---------------------|
| Cycle lock | `billing:cycle_lock:{callId}` — only one tick mutates session |
| Max delta cap | `MAX_BILLING_DELTA_MS` default 5000ms — bounds catch-up |
| Schedule gate | `billing:cycle:scheduled:{callId}` NX — one outstanding BullMQ job |
| Settlement claim | `settlement:claim:{callId}` NX — `billing-session-finalization.service.ts:1051` |
| Settle lock | `settle:lock:{callId}` NX |
| Settled tombstone | `settled:call:{callId}`, terminal session keys |
| Idempotent Mongo writes | `CallHistory` unique `{ callId, ownerUserId }` |

**Duplicate billing possible?** Only if locks TTL-expire during long event-loop stalls (>3.5s cycle lock) **and** second worker processes same window — mitigated by `MAX_BILLING_DELTA_MS` and watchdog. Low probability, non-zero.

## 4.3 Settlement flow

1. `finalizeCallSession()` acquires `settlement:claim` + `settle:lock`
2. `flushBillingToQuiescence()` drains pending ticks
3. `settleCall()` persists to Mongo (User coins, CoinTransaction, CallHistory)
4. Emits `billing:settled`, `coins_updated`
5. Redis cleanup via `ensureTerminalBillingTeardown`
6. Retry queue: `billing:settlement-retry` ZSET + payload keys

## 4.4 BullMQ on ECS

- Each replica starts `startBillingBullWorker()` — **correct** for BullMQ (competing consumers)
- **Risk:** 4 replicas × concurrency 130 = **520 parallel tick handlers** competing — can spike Redis/Mongo; tune `BILLING_BULLMQ_CONCURRENCY` per replica count
- Job IDs are unique per cycle: `billing-{callId}-{timestamp}-{random}` — no duplicate job rejection by ID alone; schedule gate prevents enqueue storms

## 4.5 Websocket billing emit frequency

- Normal: max **~1 emit/sec/call** to 2 users (`getBillingEmitIntervalMs`)
- Keepalive: at least every **2.5s** if no other emit (`getBillingEmitKeepaliveMs`)
- **500 calls:** ~500–1000 `billing:update` emits/sec cluster-wide (manageable)

## 4.6 Redis ops/sec for 500 concurrent calls

Per tick (~2.2 ticks/sec/call at 450ms):

| Operation | Ops/tick (approx) |
|-----------|-------------------|
| Cycle lock SET/extend/DEL | 2–4 |
| Session GET + 3 balance keys | 4 |
| Session MULTI persist | 4–6 |
| Schedule gate + heartbeat | 2–3 |
| BullMQ internal | 2–4 |

**~15–20 Redis ops × 2.2 × 500 ≈ 16,500–22,000 ops/s** at full load (upper bound; deferrals reduce)

## 4.7 Event-loop sensitivity

- Tick work is async but **sequential per call** in worker
- `emitSoon(setImmediate)` offloads socket emits
- Backpressure stages in `billing-backpressure.ts` respond to event-loop lag, Redis write latency, queue lag — **instrumented in `/metrics`**

## 4.8 Websocket disconnect vs settlement

**Explicit design:** disconnect does not settle — `billing-socket.gateway.ts:962-965`. Settlement via `call:ended`, Stream webhooks, watchdog, reconciliation.

## 4.9 Maximum theoretical concurrent calls

Limited by:

- BullMQ throughput: `(replicas × concurrency) / avg_tick_duration`
- Redis ops ceiling (ElastiCache node size)
- Mongo checkpoint writes every 15s default (`BILLING_CHECKPOINT_INTERVAL_MS`)

With 2 replicas × 130 concurrency, avg tick 50ms → ~5200 ticks/sec theoretical → **~2300 calls at 2.2 ticks/sec each** before worker saturation (rough upper bound).

**500 calls is realistic** with 2–4 Fargate tasks and cache.r6g.large or better Redis.

---

# SECTION 5 — Moments Feed Scalability Audit

## 5.1 Feature gate

`USE_MOMENTS=true` required (`config/moments.ts:50-51`). Workers no-op otherwise.

## 5.2 Queue names & Redis structures

| Name | Type | File |
|------|------|------|
| `moments:fanout:queue` | LIST | `feed-fanout.service.ts:14` |
| `moments:fanout:dead_letter` | LIST | `:15` |
| `moments:feed:warm:queue` | LIST | `:16` |
| `feed:following:{userId}` | ZSET (max 500 entries) | `:13` |
| `moments:following:warm:{userId}:{offset}:{limit}` | STRING cache | `:18-19` |
| `moments:feed:{userId}:{cursor}:{limit}` | STRING cache | `moments.controller.ts:186` |
| `analytics:events` | LIST | `analytics-emitter.service.ts` |

## 5.3 Worker loops (`moments.bootstrap.ts`)

| Loop | Interval | Batch |
|------|----------|-------|
| `drainAnalyticsQueue` | 30s | 50 |
| `drainFanoutQueue` | **5s** | **10** |
| `drainFeedWarmQueue` | 10s | 5 |
| `expireStoriesJob` | 30min | — |
| `validateThumbnailsBatch` | 10min | 20 Mongo docs + HTTP HEAD |
| `sweepStaleStreamSessions` | 15min | — |

**Multiple replicas:** LPOP is atomic — safe, but duplicates interval work (wasted CPU).

## 5.4 Fanout model

`fanoutOnMomentUploaded()` (`feed-fanout.service.ts:112-158`):

1. Paginate followers: `CreatorFollow.find({ creatorId }).sort({ _id: 1 }).limit(500)` in loop
2. Per batch: Redis pipeline — for each follower: `ZADD`, `ZREMRANGEBYRANK 0 -501`, `EXPIRE`
3. Optional feed warm enqueue if followers ≥ `feedWarmerFollowerThreshold` (default **1000**)

**Celebrity creator (1M followers):** single upload = 2000 Mongo pages + 1M ZADD ops — **will backlog** `moments:fanout:queue` (alert threshold default 500 in `/metrics`).

**Default:** `MOMENTS_FANOUT_ON_UPLOAD` must be `'true'` (`config/moments.ts:78`) — **off by default**.

## 5.5 Feed retrieval (`moments.controller.ts`)

- **Global feed:** `CreatorMoment.find().sort({ feedScore: -1 })` — index `{ feedScore: -1, _id: -1 }` exists
- **Following feed (cache miss):** loads all follows then `CreatorMoment.find({ creatorId: { $in } })` — **no pagination on follow list** — breaks for users following thousands
- **Cache hit path:** ZREVRANGE on `feed:following:{userId}` then `$in` query — efficient

## 5.6 Realtime updates

Socket events are **global** (`io.emit`) — not per-follower. Clients filter locally. At 10k WS connections, each upload triggers 10k deliveries.

## 5.7 Redis memory

- Each follower ZSET capped at **500** moment IDs
- 100k users × 500 × ~24 bytes ≈ **1.2GB** order-of-magnitude for following caches alone (excluding overhead)
- Bounded per key; **unbounded key count** (one ZSET per active follower)

---

# SECTION 6 — Redis Architecture Audit

## 6.1 Connection topology

| Client | Purpose |
|--------|---------|
| `getRedis()` singleton | Billing, presence, moments, locks, caches |
| BullMQ `sharedConnection` × duplicates | `billing-cycle`, `billing-termination-retry` |
| Socket.IO pub/sub | Dedicated pair in `server.ts` |
| Image workers | `image-workers.connection.ts` |
| Rate limit stores | Separate prefix namespaces |

**Estimated connections per Fargate task:** 6–12+ to ElastiCache — multiply by replica count.

## 6.2 Hottest keys

1. `billing:cycle_lock:{callId}` — high churn during calls
2. `call:session:{callId}` — read/write every tick
3. BullMQ internal keys (`bull:billing-cycle:*`) — queue metadata
4. `creator:availability:{uid}` — heartbeats
5. Metrics ZSETs `metrics:{name}` — written every 30s (`METRICS_PERSIST_INTERVAL_MS`)

## 6.3 Cluster mode compatibility

**NOT safe without hash tags.** Multi-key operations:

- `transitionCreatorPresence` MULTI across 3 key prefixes
- `reserveActiveCallSlots` Lua with 2 `active:call:user:*` keys
- Fanout pipelines touching many `feed:following:{userId}` keys

**Recommendation:** ElastiCache **primary/replica** (single shard) or Redis Cloud single shard — not Cluster mode.

## 6.4 Memory growth

| Area | Bounded? |
|------|----------|
| Call session keys | Yes — TTL 7200s |
| Following ZSETs | Per-key cap 500 |
| DLQ sets | TTL on `dlq:billing:failed:*` 86400s |
| Metrics ZSETs | **Unbounded samples** — monitor memory |
| BullMQ completed jobs | `removeOnComplete: 200` per queue |

## 6.5 Transactions / Lua usage

- Release-if-match Lua on locks — **correct pattern**
- No MULTI for financial balance mutation in Redis — balances in separate keys merged at read — **good**

---

# SECTION 7 — MongoDB Scalability Audit

## 7.1 Pool configuration (`database.ts`)

- Default `maxPoolSize=50`, `minPoolSize=5` per process
- **4 ECS replicas → up to 200 connections** — must fit Atlas tier limit

## 7.2 Fastest-growing collections

| Collection | Growth driver | Index status |
|------------|---------------|--------------|
| `CallHistory` | 2 docs per settled call | `{ ownerUserId, createdAt }`, unique `{ callId, ownerUserId }`, task agg index |
| `CoinTransaction` | billing + purchases | verify per-model |
| `CreatorMoment` | uploads | `{ creatorId, createdAt }`, `{ feedScore, _id }` |
| `CreatorFollow` | follows | `{ followerUserId, creatorId }` unique, `{ creatorId, createdAt }` |
| `CallBillingCheckpoint` | in-flight billing | if checkpoint enabled |

## 7.3 High-risk queries

1. **Following feed cache miss** — unbounded `$in` on creatorIds (`moments.controller.ts:249-257`)
2. **Creator dashboard aggregations** — multiple `CallHistory.aggregate` pipelines per request (`creator.controller.ts`)
3. **`getAllOnlineCreators()`** — SCAN + MGET (`availability.service.ts:142-193`) — admin-only but O(creators)
4. **Fanout follower pagination** — OK with `_id` cursor + index on `{ creatorId }`

## 7.4 Missing indexes (potential)

- `CreatorFollow.find({ followerUserId })` — covered by unique compound index ✓
- `CreatorMoment` following query sorts `createdAt` — compound `{ creatorId, createdAt }` exists ✓
- **Call** collection — verify `{ status, updatedAt }` for reconciliation (check `call.model.ts` if adding)

## 7.5 Read replicas

Not required until creator dashboard aggregations + feed reads saturate primary. Billing settlement writes are **write-heavy bursts** — keep on primary.

## 7.6 Transactions

Used in moment purchase flow (session). Billing settlement uses Mongo writes with idempotency keys — not always multi-doc transactions.

---

# SECTION 8 — ECS Fargate Readiness Audit

## 8.1 What works today

| Capability | Status | Evidence |
|------------|--------|----------|
| `/health`, `/live`, `/ready` | ✓ | `server.ts:952-1037` |
| Redis required in production | ✓ | `assertProductionRedis()` |
| Multi-node Socket.IO | ✓ | Redis adapter |
| Distributed billing locks | ✓ | `billing:cycle_lock:*` |
| Reconciliation leader election | Partial | Redis lock `lock:reconciliation:billing` |
| Request backpressure | ✓ | `request-queue.middleware.ts` max 500 concurrent |
| Metrics for alerting | ✓ | `/metrics` with rolling Redis samples |
| BullMQ driver enforced | ✓ | `billing-driver.ts` always true |

## 8.2 Blockers for ECS

| Blocker | Severity | Detail |
|---------|----------|--------|
| **No HTTP drain on SIGTERM** | **P0** | `server.ts:1459-1475` — stops workers then `process.exit(0)` without `httpServer.close()` |
| **Billing interrupted on deploy** | **P0** | In-flight ticks may complete but new connections dropped; BullMQ jobs survive |
| **Watchdog runs on all replicas** | P1 | No lock — redundant SCAN every 5s × N tasks |
| **Moments worker on all replicas** | P2 | Wasteful; LPOP prevents duplicate processing |
| **Global moments socket emits** | P1 | Scale hazard |
| **Firebase verify per connect** | P1 | Reconnect storm sensitivity |
| **No local filesystem** assumption | OK | No disk state required |
| **Trust proxy** | ✓ | `TRUST_PROXY_HOPS` for ALB |

## 8.3 Sticky sessions

**Not mandatory** for Socket.IO with Redis adapter. ALB can use round-robin.

## 8.4 Singleton workers

**None with global lock**, except reconciliation jobs use short-lived Redis locks. BullMQ workers are **intentionally duplicated**.

## 8.5 Required code changes

1. Implement graceful shutdown: stop accepting → `httpServer.close()` → drain BullMQ workers with timeout → `mongoose.disconnect()`
2. ~~Add env flag `RUN_BACKGROUND_WORKERS=false` on API-only tasks (or split services)~~ **Done:** use `ECS_SERVICE_ROLE=api-ws` (see `backend/src/config/service-role.ts`)
3. Add Redis lock to billing watchdog (or run on worker tier only)
4. Replace Moments `io.emit` with room-based fanout (`user:{id}` or `creator:{id}` followers room)
5. Optional: cache Firebase token verification briefly (30–60s) for reconnect

## 8.6 Required infra changes

- ALB: WebSocket support, idle timeout ≥ 60s
- Target group: `/ready` for health checks (not `/health`)
- ElastiCache: single-shard replica node, monitor `EvictedKeys` / CPU
- Atlas: connection limit ≥ replicas × `MONGO_POOL_SIZE`
- Separate security groups for api-ws vs worker if split

---

# SECTION 9 — Recommended ECS Architecture

## 9.1 Minimum viable production

```
                    ┌─────────────────┐
                    │   ALB (HTTPS)   │
                    └────────┬────────┘
                             │
              ┌──────────────┼──────────────┐
              ▼              ▼              ▼
        ┌──────────┐  ┌──────────┐  ┌──────────┐
        │ api-ws-1 │  │ api-ws-2 │  │ api-ws-N │  (2–4 tasks, CPU 1vCPU/2GB)
        └────┬─────┘  └────┬─────┘  └────┬─────┘
             │             │             │
             └──────────────┼─────────────┘
                            │
        ┌───────────────────┼───────────────────┐
        ▼                   ▼                   ▼
 ┌─────────────┐    ┌─────────────┐    ┌─────────────┐
 │ ElastiCache │    │ Mongo Atlas │    │   Firebase   │
 │   Redis     │    │   Primary   │    │   (auth)     │
 └─────────────┘    └─────────────┘    └─────────────┘
        ▲
        │
 ┌─────────────┐
 │ billing-wkr │  (1–2 tasks, ECS_SERVICE_ROLE=billing-worker)
 │ + moments   │  BILLING_BULLMQ_CONCURRENCY=65 per task
 └─────────────┘
```

**Autoscaling:**

- `api-ws`: scale on ALB `ActiveConnectionCount` + CPU p95
- `billing-worker`: scale on BullMQ queue lag metric (`billing.bullmq_queue_lag_ms` from `/metrics`) — **custom CloudWatch from scraped metrics**

**Deployment:** Rolling update, `minimumHealthyPercent=100`, **`stopTimeout` ≥ 60s** (after graceful shutdown implemented)

## 9.2 Recommended for 100k DAU

| Service | Tasks | Size | Notes |
|---------|-------|------|-------|
| `api-ws` | 4–12 (autoscale) | 2 vCPU / 4GB | Socket.IO + REST only; `BILLING_BULLMQ_CONCURRENCY=0` or no worker start |
| `billing-worker` | 2–4 | 2 vCPU / 4GB | BullMQ + reconciliation + watchdog |
| `moments-worker` | 1–2 | 1 vCPU / 2GB | Fanout drain; increase `drainFanoutQueue` batch |
| `image-worker` | 1 | 1 vCPU / 2GB | Blurhash (optional) |

**Redis:** cache.r6g.xlarge (single shard + replica) — ~25k+ ops/s headroom  
**Mongo:** M30+ with 500+ connection limit  
**ALB:** stickiness off; idle timeout 120s  

**Queue separation:** Already separate BullMQ queue names — no code change needed; optional ElastiCache dedicated to BullMQ for noisy-neighbor isolation at scale.

---

# SECTION 10 — Final Production Readiness Score

| Area | Score | Explanation |
|------|-------|-------------|
| ECS readiness | **7/10** | Redis adapter and health probes exist; **role-gated service split implemented**; graceful shutdown role-aware |
| Presence scalability | **7/10** | Redis-authoritative, batch MGET, heartbeat doesn't broadcast; per-instance socket maps + Mongo on status change |
| Billing scalability | **8/10** | BullMQ + per-call locks + settlement claims + backpressure; tune concurrency per replica |
| Socket scalability | **6/10** | Room-targeted billing good; **global Moments emits** and Firebase-per-connect limit headroom |
| Moments scalability | **5/10** | Fanout queue helps but celebrity creators overwhelm; global socket broadcasts |
| Redis architecture | **7/10** | Solid key design + TTLs; **not cluster-safe**; metrics ZSET growth |
| Mongo scalability | **7/10** | Good indexes on hot paths; following feed miss path risky; pool × replicas needs planning |
| Horizontal scaling | **7/10** | Billing/presence safe; watchdog duplication; deploy interrupts |
| Failure recovery | **8/10** | DLQ, reconciliation, watchdog, deferred call ends, settlement retry — extensive |
| **Overall production readiness** | **6.5/10** | Strong billing/presence core; needs ECS hardening + Moments fanout fix for target scale |

## 10.1 What breaks first (ordered)

1. **Event-loop lag** under colocated billing + 10k WS + Firebase auth reconnect storm
2. **Redis CPU** at 500+ concurrent calls (~20k ops/s) on small ElastiCache
3. **Moments fanout queue depth** when celebrity uploads with `MOMENTS_FANOUT_ON_UPLOAD=true`
4. **Mongo connection exhaustion** — replicas × 50 pool default
5. **`creator:status` fanout** to entire `consumers` room at high concurrent viewer counts

## 10.2 Fix immediately (P0–P1)

1. Graceful shutdown with connection draining (`httpServer.close`, BullMQ worker close)
2. ~~Split `billing-worker` from `api-ws` ECS services~~ **Code ready:** set `ECS_SERVICE_ROLE` per task (deploy/IaC deferred)
3. Replace Moments global `io.emit` with targeted rooms
4. Tune `BILLING_BULLMQ_CONCURRENCY` inversely with replica count
5. ALB `/ready` health check + deploy `stopTimeout`

## 10.3 Already production-grade

- BullMQ billing with cycle locks, schedule gates, adaptive backpressure
- Settlement orchestration (`finalizeCallSession` claim + lock + retry queue)
- Presence Redis MULTI writes with version metadata
- Socket.IO Redis adapter for multi-node
- Billing does not settle on transient WS disconnect
- Comprehensive `/metrics` with alerting thresholds
- Reconciliation DLQ + BullMQ stale watchdog

## 10.4 Can wait (P2–P3)

- Redis Cluster hash-tag migration
- Firebase token verify cache
- Presence heartbeat debounce (skip MULTI if TTL > threshold)
- Move metrics ZSET to CloudWatch directly
- Following feed `$in` pagination refactor for power users

## 10.5 Target realism summary

| Target | Realistic? |
|--------|------------|
| **500 concurrent billed calls** | **Yes** — 2–4 worker tasks, r6g.large+ Redis, tuned concurrency |
| **10k concurrent active users** | **Achievable with split api/worker tier** — not in monolith default layout |
| **100k DAU** | **Yes** — ~1–2k peak concurrent typical; architecture supports with autoscaling |

---

## Supplement — Gap fill (requirement cross-check)

The sections below cover items from the original audit brief that were implicit in earlier sections but not explicitly answered.

### S1.5 Graceful shutdown & webhook initialization

**Graceful shutdown (`server.ts:1459-1495`):**

| Signal | Actions | Missing |
|--------|---------|---------|
| `SIGTERM` / `SIGINT` | `cleanupBillingIntervals()`, stop reconciliation/watchdog/domain/VIP/call/payment workers, stop moments/image workers, clear event-loop probe, **`process.exit(0)`** | No `httpServer.close()`, no Socket.IO drain, no in-flight HTTP wait, no `mongoose.disconnect()` |
| `uncaughtException` | Same cleanup, **`process.exit(1)`** | Same gaps |

**Impact on ECS:** Fargate sends SIGTERM → connections dropped immediately → active billing ticks may finish in BullMQ but WS clients lose connection without clean close.

**Webhook initialization:** Webhooks are **not** started as separate workers. They are **Express routes** mounted via `routes` → `video.routes`, `chat.routes`, `payment.routes`, `stream.routes`. Raw-body middleware in `server.ts:222-256` preserves HMAC bytes for:

- `POST /api/v1/video/webhook`
- `POST /api/v1/chat/webhook`
- `POST /api/v1/payment/webhook`
- `POST /api/v1/stream/webhook`

Startup side effects touching webhooks/presence:

- `cleanupStaleCreatorLocks()` — `video/video.webhook.ts` (startup + 5min interval)
- Stream push config — `configureStreamPush()` before listen

**Note:** `billing.gateway.ts` is a **facade** re-exporting `setupBillingGateway` from `billing-socket.gateway.ts` plus HTTP helpers (`handleCallStartedHttp`, `settleCallHttp`). All socket billing events live in `billing-socket.gateway.ts`.

---

### S2.7 Reconnect storms & O(n) patterns (explicit)

| Pattern | Type | Location | Scale risk |
|---------|------|----------|------------|
| `io.to('consumers').emit('creator:status')` | O(consumers) room broadcast | `presence.service.ts:709` | High at 10k+ viewers |
| `io.to('creators').emit('user:status')` | O(creators) room broadcast | `availability.gateway.ts` | Lower (fewer creators) |
| `ioRef?.emit('moment:*')` | **Global** O(all sockets) | `moments.gateway.ts:11-24` | Critical |
| `availability:get` → `socket.emit` | O(1) unicast | `availability.gateway.ts:725-726` | Safe |
| `billing:update` → `user:{uid}` room | O(1) per party | `billing-emitter.service.ts:99-100` | Safe |

**Reconnect storm mechanics:**

1. Mass reconnect → N × `verifyIdToken` (Firebase HTTP) + N × `User.findOne` (Mongo)
2. First socket per creator → `restoreCreatorRuntimeFromIntent()` → extra Mongo read
3. Engine.IO ping storm: 25s interval × connections (baseline, not app-level)
4. No rate limit on socket connections (only REST `checkCallRateLimit` on `call:started`)

**Mitigation present:** billing recovery debounce 750ms (`BILLING_RECOVERY_DEBOUNCE_MS`); presence disconnect grace 3s before offline.

---

### S3.9 Presence — remaining audit questions

| # | Question | Answer (code-based) |
|---|----------|---------------------|
| 4 | Reconnect edge cases | Multi-tab handled in-memory per instance; cross-node uses Redis TTL + 3s disconnect grace; `restoreCreatorRuntimeFromIntent` on first connect if Mongo `Creator.isOnline` |
| 7 | Redis write amplification | Each creator heartbeat → full 3-key MULTI even when status unchanged (~4 Redis ops/45s/creator); user heartbeat → 1 SETEX |
| 10 | Debounced? | **No** — TTL refresh always writes; socket emits debounced (no emit on HEARTBEAT) |

**Creator online/offline toggle paths:**

| Path | Function | File |
|------|----------|------|
| Socket `creator:online` / `creator:offline` | `handleCreatorExplicitOnline/Offline` | `availability.gateway.ts:735-766` |
| REST toggle | `setCreatorAvailability()` | `availability.gateway.ts:939-967` |
| Disconnect grace | `scheduleCreatorDisconnectTransition` | `availability.gateway.ts:290-328` |
| Call lifecycle | `transitionCreatorPresence(..., 'CALL_STARTED'/'CALL_ENDED')` | `call-finalization.service.ts`, billing paths |

**`availability.service.ts` role:** Legacy/base helpers (`setCreatorBaseAvailability`, `getAllOnlineCreators` SCAN). **Effective reads** go through `presence.service.ts` → `getBatchCreatorPresence`.

**`user-availability.service.ts`:** Separate Redis prefix `user:availability:{uid}` for consumer online state; batch via `getBatchUserAvailability`.

---

### S4.10 Billing — locks, retry, throughput, latency

**Lock implementations (actual Lua / NX):**

| Lock | Pattern | File |
|------|---------|------|
| Cycle tick | `SET NX PX` + heartbeat `SET XX PX` | `billing.service.ts:2531-2544` |
| Cycle release | `RELEASE_BILLING_CYCLE_LOCK_LUA` compare-and-DEL | `billing.service.ts:148-164` |
| Active call slots | 2-key Lua `SET` both `active:call:user:*` | `billing.service.ts:567+` |
| Settlement claim | `settlement:claim:{callId}` NX EX | `billing-session-finalization.service.ts:1051` |
| Settle lock | `settle:lock:{callId}` NX EX + heartbeat | `:1084-1119` |
| Reconciliation | `lock:reconciliation:billing` NX PX | `billing-reconciliation.ts:94-100` |

**Settlement races:** Claim NX → settle lock NX → `markCallSettling` → Mongo persist → tombstone. Contention → `pollUntilSettled` or `enqueueSettlementRetry` (ZSET `billing:settlement-retry`).

**Retry / failure recovery:**

| Mechanism | Interval / trigger | File |
|-----------|-------------------|------|
| DLQ failed ticks | SSET `dlq:billing:failed:set` | `billing-reconciliation.ts` |
| Settlement retry queue | Every reconciliation run (5min) | `billing-session-finalization.service.ts:486` |
| BullMQ stale watchdog | Reconciliation pass | `billing-reconciliation.ts` `runBullmqBillingWatchdog` |
| Billing watchdog | 5s, no lock | `billing-watchdog.service.ts` |
| Startup recovery | Once on boot | `billing-recovery.ts` |
| Deferred call end | `pending:call:ends:{callId}` | `billing-socket.gateway.ts` |

**BullMQ job throughput (estimate):** With concurrency 130/replica, avg tick 30–80ms → **~1,600–4,300 jobs/sec/replica** theoretical max. At 450ms scheduling, **500 active calls need ~1,100 jobs/sec** sustained — **1 replica sufficient** if ticks stay fast; 2 replicas add headroom.

**Settlement write pressure:** 2× `CallHistory` inserts + 2× `User` updates + 2× `CoinTransaction` per settled call — burst of **~6 Mongo writes/call** at end; checkpoints add periodic upserts (`call-billing-checkpoint.model.ts`, default every 15s).

**Redis latency impact:** High Redis RTT directly increases tick duration → `billing.redis_pipeline_*` metrics, backpressure stages (`billing-backpressure.ts`), adaptive cycle delay (`computeNextCycleDelayMs`). `MAX_BILLING_DELTA_MS` (5s default) caps catch-up if ticks stall — **accuracy preserved, realtime emit may lag**.

**Horizontal billing scalability:** **Yes**, with per-call locks + BullMQ competing consumers. Duplicate billing: **low risk** (see Section 4.2).

---

### S5.8 Moments — follow graph, upload flow, invalidation, starvation

**Follow graph (`creator-follow.model.ts`):**

- Unique `{ followerUserId, creatorId }`
- Index `{ creatorId, createdAt: -1 }` for fanout pagination
- Loaded via `loadFollowedCreatorIds()` in `follow-context.service.ts`

**Moment upload flow (`moments.controller.ts` create handler):**

1. Rate limit (`moments-rate-limit.service.ts`)
2. `CreatorMoment.create` + Stream/image commit
3. **`emitMomentUploaded`** — global socket broadcast
4. **`enqueueFanoutTask`** — async LIST or inline `fanoutOnMomentUploaded`
5. Response 201

**Analytics queue (`analytics-emitter.service.ts`):**

- LIST `analytics:events` / DLQ `analytics:dead_letter`
- Drain: 50 events / 30s per replica (`moments.bootstrap.ts`)
- Dedup keys: `viewed:{userId}:{momentId}`, `completed:moment:*`, `completed:story:*`

**Feed invalidation:** No explicit cross-user invalidation on upload. Following feeds updated via fanout ZADD; global feed uses TTL cache `moments:feed:{userId}:{cursor}:{limit}` (30s default) — **stale up to TTL** on cache hit.

**Cache churn:** Each fanout touches up to 500 followers × 3 ops; warm queue re-fetches Mongo for top followers. High churn for active creators with many followers.

**Worker starvation:** Moments workers share event loop with billing on monolith — heavy fanout batch (500 followers × pipeline) can block HTTP/WS for 100ms–seconds. Celebrity upload + 500 concurrent billing ticks = **event-loop contention risk**.

**Fanout amplification (celebrity upload, 100k followers):**

| Stage | Work |
|-------|------|
| Mongo | ~200 follower pages × 500 |
| Redis | 100k × (ZADD + ZREMRANGEBYRANK + EXPIRE) ≈ **300k ops** |
| Queue | Single LIST job — drain at 10 jobs/5s/replica → **hours backlog** without dedicated workers |

---

### S6.6–S6.8 Redis — inventory, total ops, reconnect

**Categorized key inventory (summary):**

| Category | Prefix examples | Count growth |
|----------|-----------------|--------------|
| Billing session | `call:session:*`, `call:user_*`, `billing:cycle_*` | O(active calls) |
| Billing locks/claims | `billing:cycle_lock:*`, `settlement:claim:*`, `settle:lock:*` | O(active calls) |
| Presence | `creator:availability:*`, `creator:presence:meta:*`, `user:availability:*` | O(online users) |
| Active calls | `active:call:user:*` | O(participants) |
| Moments feeds | `feed:following:*`, `moments:*:queue` | O(users with feeds) |
| Caches | `creator:feed:*`, `creator:detail:*`, `moments:feed:*` | O(cache keys) |
| BullMQ | `bull:billing-cycle:*`, `bull:billing-termination-retry:*` | Fixed + job history |
| Metrics | `metrics:*` ZSETs | O(metric types) × samples |
| Rate limits | `rl:*`, `rate_limit:*` | O(users × windows) |

**High-risk keys:** `presence:online_creators` (single SET); BullMQ meta keys; any future unsharded hot counter.

**Total Redis ops/sec (combined estimate at target load):**

| Scenario | Presence | Billing (500 calls) | Moments/API | Total (approx) |
|----------|----------|---------------------|-------------|----------------|
| 1k active users, 50 calls | ~32 | ~2,200 | ~50 | **~2,300** |
| 10k active, 500 calls | ~322 | ~18,000 | ~200 | **~18,500** |
| 50k active, 500 calls | ~1,611 | ~18,000 | ~500 | **~20,100** |

**Key expiry strategy:** TTL-backed presence (180s), sessions (7200s), caches (30–604800s depending on key). BullMQ jobs use `removeOnComplete/Fail: 200`. **Gap:** metrics ZSETs lack automatic trim in all paths — monitor memory.

**Redis reconnect (`config/redis.ts`):** `retryStrategy` exponential cap 2s; `maxRetriesPerRequest: 3` on singleton (BullMQ uses `null` for blocking). Events: `reconnecting`, `error`, `close` logged via `attachRedisClientMonitoring`. **During disconnect:** billing ticks throw → DLQ/retry; presence reads fail-safe offline; Socket.IO adapter has separate clients.

**Cluster mode:** **Not safe** without hash tags (see Section 6.3).

---

### S7.7–S7.9 Mongo — billing writes, amplification, pagination

**Billing write patterns:**

- Settlement: `User.findOneAndUpdate`, `CoinTransaction.create`, `CallHistory.create` ×2
- Checkpoint: upsert `CallBillingCheckpoint` when enabled
- Call model updates via `call-reconciliation.ts` / webhooks

**Write amplification:** Each settled call = **minimum 4–6 writes**; high call volume grows `CallHistory` and `CoinTransaction` fastest.

**Pagination / sort patterns:**

| Query | Sort | Index |
|-------|------|-------|
| Global moments feed | `feedScore: -1, _id: -1` | ✓ |
| Following feed (miss) | `createdAt: -1` + skip/limit | `{ creatorId, createdAt }` ✓ |
| Creator feed | paginated + Redis cache | `Creator.find` + cache |
| Call history per user | `createdAt: -1` | `{ ownerUserId, createdAt }` ✓ |
| Creator dashboard aggs | `$match` + `$group` on CallHistory | compound index exists |

**Aggregation pipeline risk:** Creator dashboard runs multiple aggregations per request — **CPU-heavy on primary** under concurrent creator sessions.

**Transactions:** Moment purchase uses Mongo session; billing settlement relies on idempotent keys + unique indexes rather than multi-doc transactions.

---

### S8.7 Environment variables & Redis connections (ECS)

**Critical env vars for ECS:**

| Variable | Role |
|----------|------|
| `PORT` | Listen port (default 3000) |
| `MONGO_URI` | Atlas connection |
| `REDIS_URL` | ElastiCache (required production) |
| `TRUST_PROXY_HOPS` | ALB X-Forwarded-For (default 1) |
| `BILLING_BULLMQ_CONCURRENCY` | Worker parallelism |
| `SOCKET_IO_REDIS_ADAPTER` | Multi-node WS |
| `USE_MOMENTS` | Moments workers |
| `METRICS_TOKEN` | Protect `/metrics` |
| `JWT_SECRET`, `ADMIN_*` | Production security |

**Process assumptions:** Single listen on `0.0.0.0`; no cluster module; `getIO()` global singleton for emits from workers.

**Filesystem:** No persistent local state required — **Fargate-compatible**.

**Redis connections per task:** ~1 singleton + 2 Socket.IO adapter + 2–4 BullMQ + image workers ≈ **6–12 TCP connections/task**.

**Leader election:** Only via Redis locks (`lock:reconciliation:billing`, `lock:reconciliation:call`, `lock:payment:webhook_retry`) — **not** for watchdog or moments intervals.

**Autoscaling safety:** Safe for stateless API; **unsafe** to scale billing workers without lowering per-task concurrency; deploys **interrupt** WS until graceful shutdown fixed.

---

### S9.3 ALB & WebSocket routing

| Setting | Recommendation |
|---------|----------------|
| Listener | HTTPS 443 → target group HTTP on task port |
| Stickiness | **Disabled** (Redis adapter handles cross-node) |
| Idle timeout | **≥ 120s** (exceeds Socket.IO pingTimeout 60s) |
| Health check | `GET /ready` (503 when Redis/Mongo down) |
| Deregistration delay | **60–120s** after graceful shutdown implemented |
| WebSocket upgrade | ALB native support; ensure target group HTTP/1.1 |

**Deployment strategy:** Blue/green or rolling with `minHealthy=100%`, `max=200%`; run billing-worker tasks on separate service with longer drain.

---

## Appendix D — Requirement coverage checklist

| Original requirement | Document location | Status |
|---------------------|-------------------|--------|
| **§1** Runtime topology (8 workloads + 8 outputs) | §1.1–1.4, §1.5, Appendix A/B | ✅ Complete |
| **§2** Socket.IO (10 questions + 6 events + fanout) | §2.1–2.7 | ✅ Complete |
| **§3** Presence (10 questions + ops estimates) | §3.1–3.9 | ✅ Complete |
| **§4** Billing (10 questions + estimates) | §4.1–4.10 | ✅ Complete |
| **§5** Moments (9 questions + estimates) | §5.1–5.8 | ✅ Complete |
| **§6** Redis (9 questions + inventory) | §6.1–6.8 | ✅ Complete |
| **§7** Mongo (8 questions) | §7.1–7.9 | ✅ Complete |
| **§8** ECS (8 questions + blockers/changes) | §8.1–8.7 | ✅ Complete |
| **§9** ECS architecture (MVP + 100k DAU) | §9.1–9.3 | ✅ Complete |
| **§10** Scores + 7 summary items | §10.1–10.5 | ✅ Complete |

**Explicitly marked as missing in code (not omitted from audit):**

- ~~`httpServer.close()` / connection drain on SIGTERM~~ **Partial:** role-aware shutdown in `backend/src/bootstrap/bootstrap-shutdown.ts` (api-ws drains HTTP; workers drain BullMQ)
- ~~`RUN_BACKGROUND_WORKERS` env flag~~ **Implemented as `ECS_SERVICE_ROLE`** (`monolith` | `api-ws` | `billing-worker` | `moments-worker` | `image-worker`)
- Firebase token cache on reconnect (**not implemented**)
- Redis Cluster hash tags (**not implemented**)
- Per-follower Moments socket rooms (**not implemented**)
- Leader election for billing watchdog (**not implemented**)

---

## Appendix A — Complete interval inventory

| Component | Interval | File |
|-----------|----------|------|
| Event-loop probe | 1s | `server.ts:1164` |
| Creator stale socket cleanup | 10min | `availability.gateway.ts:456` |
| Presence heartbeat sweep | 30s | `availability.gateway.ts:461` |
| Creator/user heartbeat | ~45s | `availability.gateway.ts:28-31` |
| Task progress cleanup | 6h | `server.ts:1428` |
| Creator lock cleanup | 5min | `server.ts:1432` |
| Billing reconciliation | 5min | `config/redis.ts:372` |
| Billing watchdog | 5s (env) | `billing-watchdog.service.ts:31` |
| Call reconciliation | 5min (env) | `call-reconciliation.ts:31-33` |
| VIP reconciliation | configurable | `vip-scheduling.reconciliation.ts` |
| Moments analytics | 30s | `moments.bootstrap.ts:19` |
| Moments fanout | 5s | `moments.bootstrap.ts:22` |
| Moments feed warm | 10s | `moments.bootstrap.ts:23` |
| Story expiry | 30min | `moments.bootstrap.ts:20` |
| Thumbnail validation | 10min | `moments.bootstrap.ts:21` |
| Stream session sweep | 15min | `moments.bootstrap.ts:18` |
| Domain events | 5s (env) | `domain-event.worker.ts:12` |
| Metrics persist | 30s | `config/redis.ts:385` |

## Appendix B — BullMQ queue names

| Queue | Worker start | File |
|-------|--------------|------|
| `billing-cycle` | `startBillingBullWorker()` | `billing.queue.ts` |
| `billing-termination-retry` | `startTerminationRetryWorker()` | `billing-termination.queue.ts` |
| blurhash (image) | `startBlurhashWorker()` | `blurhash.worker.ts` |
| orphan cleanup | `startOrphanCleanupWorker()` | `orphan-cleanup.queue.ts` |

## Appendix C — Key environment variables for scale tuning

| Variable | Default | Purpose |
|----------|---------|---------|
| `BILLING_BULLMQ_CONCURRENCY` | 130 | Tick parallelism per replica |
| `BILLING_PROCESS_INTERVAL_MS` | 450 | Tick cadence |
| `BILLING_EMIT_INTERVAL_MS` | 1000 | WS billing update throttle |
| `CREATOR_HEARTBEAT_INTERVAL_MS` | 45000 | Presence refresh |
| `CREATOR_PRESENCE_TTL_SECONDS` | 180 | Presence expiry |
| `MONGO_POOL_SIZE` | 50 | Per-process Mongo connections |
| `REQUEST_QUEUE_MAX_CONCURRENT` | 500 | API backpressure |
| `SOCKET_IO_REDIS_ADAPTER` | enabled | Set `false` to disable multi-node |
| `MOMENTS_FANOUT_ON_UPLOAD` | false | Async fanout enqueue |

---

*This document reflects code as inspected on 2026-06-07. Re-verify after major billing or presence refactors.*
