# ECS Service Split — Code Changes (Before & After)

This document describes the **code-level** implementation of the ECS service split: how a single monolithic Node process was refactored into four deployable process roles using one shared image (`node dist/server.js`) and the `ECS_SERVICE_ROLE` environment variable.

**Scope:** Application code only. Dockerfile, ECR, ECS task definitions, and Terraform/CDK are **deferred** to a follow-up.

**Related docs:**

- [INFRASTRUCTURE_SCALE_READINESS_AUDIT.md](./INFRASTRUCTURE_SCALE_READINESS_AUDIT.md) — scale audit (updated)
- ECS split plan (design reference)

---

## 1. Executive summary

| Aspect | Before | After |
|--------|--------|-------|
| **Process model** | One process runs everything | Same binary; role selected via `ECS_SERVICE_ROLE` |
| **Entry point** | `node dist/server.js` only | Same + `npm run start:api-ws` etc. |
| **Worker gating** | None — every replica started all workers | Role helpers gate BullMQ, reconciliation, moments, image pipelines |
| **Billing on API tier** | BullMQ worker + socket handlers colocated | API tier enqueues only; worker tier consumes |
| **Graceful shutdown** | Stop all workers → `process.exit` (no HTTP drain) | Role-aware: `httpServer.close()` on api-ws; BullMQ drain on billing-worker |
| **Health endpoints** | Inline in `server.ts` (~750 lines) | Shared `health-routes.ts` + worker-only minimal server |
| **ECS safety** | No role required | Production ECS tasks must set `ECS_SERVICE_ROLE` |
| **Railway / local dev** | Full monolith | Unchanged when `ECS_SERVICE_ROLE` unset → `monolith` |

---

## 2. Architecture: before vs after

### Before — monolith (every replica identical)

```
┌─────────────────────────────────────────────────────────────┐
│  dist/server.js  (single process per container/task)        │
│                                                             │
│  Express REST + webhooks                                    │
│  Socket.IO (presence, billing, moments, admin)              │
│  BullMQ billing-cycle + termination-retry                   │
│  Billing reconciliation + watchdog (5s / 5min)              │
│  Call / VIP / payment reconciliation loops                  │
│  Moments fanout / analytics / story expiry drains           │
│  Image blurhash + orphan cleanup (BullMQ)                   │
│  ~15 setInterval background jobs                            │
└─────────────────────────────────────────────────────────────┘
         │                    │
         ▼                    ▼
    MongoDB Atlas        Redis (BullMQ, presence, adapter)
```

**Problem at scale:** Scaling `api-ws` replicas also scaled billing watchdogs, reconciliation scans, and moments drain loops — wasted CPU and duplicate work.

### After — four logical roles (same image, different env)

```
                    ┌──────────────┐
                    │  ALB (future) │
                    └──────┬───────┘
                           │
              ┌────────────┴────────────┐
              ▼                         │
     ECS_SERVICE_ROLE=api-ws            │
     • Express + full routes            │
     • Socket.IO + gateways             │
     • NO BullMQ workers                │
     • NO reconciliation loops         │
              │                         │
              └──────── Redis ─────────┤
                                       │
     ECS_SERVICE_ROLE=billing-worker   │
     • Headless Socket.IO (emit only)  │
     • BullMQ + all billing recon      │
     • /health /ready /metrics only    │
                                       │
     ECS_SERVICE_ROLE=moments-worker    │
     • Fanout / warm / analytics drains │
     • /health /ready only              │
                                       │
     ECS_SERVICE_ROLE=image-worker     │
     • Blurhash + orphan cleanup       │
     • /health /ready only              │
                                       ▼
                              MongoDB Atlas
```

Billing worker emits (`billing:update`, `call:force-end`) reach clients on **api-ws** tasks via the **Socket.IO Redis adapter** — no client WebSocket connections on worker tasks.

---

## 3. New files

| File | Purpose |
|------|---------|
| [`src/config/service-role.ts`](../src/config/service-role.ts) | Parse `ECS_SERVICE_ROLE`, role helpers, ECS fail-fast |
| [`src/config/service-role.test.ts`](../src/config/service-role.test.ts) | Unit tests for role parsing and gating |
| [`src/bootstrap/bootstrap-core.ts`](../src/bootstrap/bootstrap-core.ts) | Firebase, security asserts, DB, Redis, Stream push |
| [`src/bootstrap/bootstrap-api-ws.ts`](../src/bootstrap/bootstrap-api-ws.ts) | Socket gateways for client-facing tier |
| [`src/bootstrap/bootstrap-billing-workers.ts`](../src/bootstrap/bootstrap-billing-workers.ts) | All billing / call / payment background work |
| [`src/bootstrap/bootstrap-moments-workers.ts`](../src/bootstrap/bootstrap-moments-workers.ts) | Wrapper for `startMomentsWorkers()` |
| [`src/bootstrap/bootstrap-image-workers.ts`](../src/bootstrap/bootstrap-image-workers.ts) | Wrapper for `startImagePipelineWorkers()` |
| [`src/bootstrap/bootstrap-socket.ts`](../src/bootstrap/bootstrap-socket.ts) | Full + headless Socket.IO + Redis adapter |
| [`src/bootstrap/bootstrap-worker-health.ts`](../src/bootstrap/bootstrap-worker-health.ts) | Minimal HTTP server for worker roles |
| [`src/bootstrap/bootstrap-shutdown.ts`](../src/bootstrap/bootstrap-shutdown.ts) | Role-aware SIGTERM / SIGINT / uncaughtException |
| [`src/bootstrap/health-routes.ts`](../src/bootstrap/health-routes.ts) | `/health`, `/live`, `/ready` (shared) |
| [`src/bootstrap/metrics-handler.ts`](../src/bootstrap/metrics-handler.ts) | `/metrics` handler (extracted from `server.ts`) |
| [`src/bootstrap/service-role.boot.contract.test.ts`](../src/bootstrap/service-role.boot.contract.test.ts) | Static contract tests for boot split |
| [`scripts/start-with-role.cjs`](../scripts/start-with-role.cjs) | Cross-platform role launcher for npm scripts |
| [`scripts/extract-metrics-handler.cjs`](../scripts/extract-metrics-handler.cjs) | One-time extraction helper (dev tooling) |

---

## 4. Modified files

| File | Change summary |
|------|----------------|
| [`src/server.ts`](../src/server.ts) | Orchestration only; role-gated `startServer()`; uses bootstrap modules |
| [`src/modules/billing/billing.queue.ts`](../src/modules/billing/billing.queue.ts) | `shouldStartBillingBullWorker()`, concurrency `0` support |
| [`src/modules/billing/billing-batch.processor.ts`](../src/modules/billing/billing-batch.processor.ts) | Handles skipped worker start |
| [`package.json`](../package.json) | `start:api-ws`, `start:billing-worker`, etc.; new tests in `npm test` |
| [`.env.example`](../.env.example) | Per-service env blocks documented |
| [`docs/INFRASTRUCTURE_SCALE_READINESS_AUDIT.md`](./INFRASTRUCTURE_SCALE_READINESS_AUDIT.md) | Marks `ECS_SERVICE_ROLE` implemented |

---

## 5. Process roles (`ECS_SERVICE_ROLE`)

### Before

- No role variable existed.
- Docs recommended `RUN_BACKGROUND_WORKERS` — **never implemented**.
- Every container ran the full stack unconditionally.

### After — [`service-role.ts`](../src/config/service-role.ts)

```typescript
export type EcsServiceRole =
  | 'monolith'        // default when ECS_SERVICE_ROLE unset
  | 'api-ws'
  | 'billing-worker'
  | 'moments-worker'
  | 'image-worker';
```

**Resolution rules:**

| Condition | Result |
|-----------|--------|
| `ECS_SERVICE_ROLE` unset | `monolith` (Railway / local unchanged) |
| Invalid value | Startup throws |
| `NODE_ENV=production` + ECS metadata URI set + role unset | Startup throws (forces explicit role on Fargate) |
| `RUN_BACKGROUND_WORKERS=true` + `ECS_SERVICE_ROLE=api-ws` | Startup throws (conflict) |

**Helper functions** (used throughout boot and shutdown):

| Function | True when |
|----------|-----------|
| `runsHttpApi()` | `monolith` or `api-ws` |
| `runsBillingWorkers()` | `monolith` or `billing-worker` |
| `runsMomentsWorkers()` | `monolith` or `moments-worker` |
| `runsImageWorkers()` | `monolith` or `image-worker` |
| `runsApiHygieneIntervals()` | `monolith` or `api-ws` |

---

## 6. Startup flow: before vs after

### Before — [`server.ts` `startServer()` (conceptual)]

Single linear sequence (~150 lines inside one function):

1. `initializeFirebase()` → security asserts → `connectDatabase()`
2. Create `httpServer` + full `SocketIOServer` + Redis adapter
3. `setupAvailabilityGateway`, `setupMomentsGateway`, `setupBillingGateway`, `setupAdminGateway`
4. **`startGlobalBillingProcessor(io)`** — BullMQ worker on every replica
5. **`startTerminationRetryWorker()`**, **`startReconciliationJob()`**, **`startBillingWatchdog()`**, …
6. **`startCallReconciliationJob()`**, **`startVipReconciliationJob()`**, **`startPaymentWebhookRetryWorker()`**
7. **`startImagePipelineWorkers()`**, **`startMomentsWorkers()`**
8. `httpServer.listen(PORT)`

All replicas executed steps 4–7 identically.

### After — role-gated orchestration

```typescript
const role = getServiceRole();
await bootstrapCore();

if (runsHttpApi()) {
  httpServer = createServer(app);                    // full Express app
  io = initializeSocketIo(httpServer, ...);
  bootstrapApiWs(io);                                // gateways only
} else if (runsBillingWorkers()) {
  ({ httpServer, io } = createWorkerHealthServer({
    includeMetrics: true,
    headlessSocket: true,
  }));
} else {
  ({ httpServer } = createWorkerHealthServer());     // moments / image
}

if (runsBillingWorkers() && io) bootstrapBillingWorkers(io);
if (runsMomentsWorkers()) bootstrapMomentsWorkers();
if (runsImageWorkers()) await bootstrapImageWorkers();

registerRuntimeServers(httpServer, io);
// listen: full app OR worker health server
```

**Per-role workload matrix:**

| Workload | monolith | api-ws | billing-worker | moments-worker | image-worker |
|----------|:--------:|:------:|:--------------:|:--------------:|:------------:|
| Express `/api/v1` | ✓ | ✓ | — | — | — |
| Socket.IO client gateways | ✓ | ✓ | — | — | — |
| Headless Socket.IO (emit) | — | — | ✓ | — | — |
| BullMQ billing + termination | ✓ | — | ✓ | — | — |
| Billing / call / VIP / payment recon | ✓ | — | ✓ | — | — |
| Moments drains | ✓ | — | — | ✓ | — |
| Image pipeline BullMQ | ✓ | — | — | — | ✓ |
| `/metrics` | ✓ | ✓ | ✓ | — | — |
| Task progress / lock cleanup intervals | ✓ | ✓ | — | — | — |

---

## 7. Bootstrap modules (detail)

### 7.1 `bootstrap-core.ts`

**Before:** Inline in `startServer()` — Firebase init, `assertProductionSecurity()`, `connectDatabase()`, creator lock cleanup, CreatorTaskProgress index migration, Stream push, Redis ping, Razorpay check, event-loop probe.

**After:** Single `bootstrapCore()` exported function. Called once for **all** roles (workers still need Mongo + Redis + Firebase for their jobs).

### 7.2 `bootstrap-api-ws.ts`

**Before:** Gateway setup mixed with worker startup in `server.ts` lines ~1276–1324.

**After:** Only client-facing Socket.IO registration:

- `setupAvailabilityGateway(io)` — presence
- `setupMomentsGateway(io)` — broadcast helpers
- `setupBillingGateway(io)` — **`call_started` → enqueue BullMQ** (does not start worker)
- `setupAdminGateway(io)`
- `auditCreatorPresenceOnStartup(io)`

**Explicitly excluded:** `startGlobalBillingProcessor`, reconciliation, moments/image workers.

### 7.3 `bootstrap-billing-workers.ts`

**Before:** Same calls inline after billing gateway in every replica.

**After:** Isolated module — runs only when `runsBillingWorkers()`:

| Call | Type |
|------|------|
| `startGlobalBillingProcessor(io)` | BullMQ `billing-cycle` |
| `startTerminationRetryWorker()` | BullMQ `billing-termination-retry` |
| `startReconciliationJob(io)` | 5 min interval + settlement retry |
| `startBillingWatchdog(io)` | 5 s lifecycle watchdog |
| `startStaffWalletReconciliationScheduler()` | 24 h opt-in |
| `startDomainEventWorker()` | 5 s opt-in outbox |
| `verifyStartupRecovery(io)` | One-shot boot recovery |
| `repairStaleActiveCallSlotsOnStartup()` | One-shot slot repair |
| `startCallReconciliationJob(io)` | Stream drift, 5 min |
| `startVipReconciliationJob()` | 60 s scheduled calls |
| `startPaymentWebhookRetryWorker()` | 15 s Razorpay retry |

Requires `io` from headless Socket.IO (billing-worker) or full server (monolith).

### 7.4 `bootstrap-socket.ts` — headless Socket.IO

**Before:** Workers called `getIO()` which **threw** if Socket.IO was never initialized on a hypothetical worker-only process.

**After:** `initializeHeadlessSocketIo(httpServer)`:

- Creates `SocketIOServer` with Redis adapter (same as api-ws)
- **`allowRequest: (_, cb) => cb(null, false)`** — rejects inbound WebSocket upgrades
- Calls `setIO(io)` so billing code can `io.to('user:…').emit(...)` and reach api-ws clients via Redis pub/sub

No `@socket.io/redis-emitter` package added — MVP uses minimal Server + adapter (per plan alternative).

### 7.5 `bootstrap-worker-health.ts`

**Before:** Worker-only processes did not exist; all traffic hit full Express app.

**After:** Worker roles (non-HTTP API) listen on a **minimal Express app**:

| Route | billing-worker | moments-worker | image-worker |
|-------|:--------------:|:----------------:|:------------:|
| `GET /health` | ✓ | ✓ | ✓ |
| `GET /live` | ✓ | ✓ | ✓ |
| `GET /ready` | ✓ | ✓ | ✓ |
| `GET /metrics` | ✓ | — | — |

No `/api/v1`, no Socket.IO client paths on worker health server (except headless adapter attached to same `httpServer` for billing-worker).

### 7.6 Health & metrics extraction

**Before:** ~660 lines of `/metrics` and ~90 lines of `/health` `/live` `/ready` inline in `server.ts`.

**After:**

- [`health-routes.ts`](../src/bootstrap/health-routes.ts) — shared health handlers; responses include `serviceRole`
- [`metrics-handler.ts`](../src/bootstrap/metrics-handler.ts) — full metrics payload unchanged; registered via `registerMetricsRoute(app)`

In `server.ts`:

```typescript
registerMetricsRoute(app);
registerHealthRoutes(app);
```

---

## 8. Billing decoupling

### Before

[`billing.gateway.ts`](../src/modules/billing/billing.gateway.ts) re-exported both:

- `setupBillingGateway` — socket handlers
- `startGlobalBillingProcessor` — BullMQ consumer

`server.ts` called **both** on every replica immediately after `setupBillingGateway(io)`.

### After

| Tier | Socket handlers | BullMQ consumer |
|------|-----------------|-----------------|
| **api-ws** | `bootstrapApiWs` → `setupBillingGateway` | **Not started** |
| **billing-worker** | **Not registered** | `bootstrapBillingWorkers` → `startGlobalBillingProcessor` |
| **monolith** | Both | Both |

**Call flow (split deploy):**

1. Client connects WebSocket to **api-ws** task.
2. Client emits `call_started` → `setupBillingGateway` → `scheduleBillingJob()` → Redis/BullMQ.
3. **billing-worker** task picks up job → `processBillingTick(io, callId)` → emits via headless `io` + Redis adapter.
4. **api-ws** task delivers `billing:update` to client room.

Queue names unchanged — no data migration.

### `shouldStartBillingBullWorker()` — [`billing.queue.ts`](../src/modules/billing/billing.queue.ts)

**Before:**

```typescript
function readBullmqConcurrency(): number {
  // ...
  return Math.min(200, Math.max(1, raw));  // always ≥ 1
}

export function startBillingBullWorker(): Worker {
  // always started when BullMQ enabled
}
```

**After:**

```typescript
function readBullmqConcurrency(): number {
  if (raw <= 0) return 0;  // explicit disable
  return Math.min(200, Math.max(1, raw));
}

export function shouldStartBillingBullWorker(): boolean {
  if (!runsBillingWorkers()) return false;
  if (!isBullmqBillingEnabled()) return false;
  return readBullmqConcurrency() > 0;
}

export function startBillingBullWorker(): Worker | null {
  if (!shouldStartBillingBullWorker()) {
    logInfo('Billing BullMQ worker skipped for this process', { ... });
    return null;
  }
  // ...
}
```

| Scenario | Worker starts? |
|----------|----------------|
| `ECS_SERVICE_ROLE=api-ws` | **No** |
| `ECS_SERVICE_ROLE=billing-worker` | Yes (if BullMQ enabled + concurrency > 0) |
| `BILLING_BULLMQ_CONCURRENCY=0` | **No** (even on monolith) |
| Unset role (monolith) | Yes (default concurrency) |

---

## 9. Graceful shutdown: before vs after

### Before — [`server.ts` signal handlers]

```typescript
process.on('SIGTERM', async () => {
  await cleanupBillingIntervals();
  stopReconciliationJob();
  stopBillingWatchdog();
  // ... stop ALL workers regardless of role ...
  process.exit(0);  // no httpServer.close(), no mongoose.disconnect()
});
```

Every replica stopped every worker type. HTTP connections dropped immediately on deploy.

### After — [`bootstrap-shutdown.ts`](../src/bootstrap/bootstrap-shutdown.ts)

| Role | Shutdown sequence |
|------|-------------------|
| **api-ws / monolith (HTTP)** | `httpServer.close()` (timeout `SHUTDOWN_HTTP_MS`, default 30s) → `io.close()` → **does not** stop BullMQ if not running on api-ws-only |
| **billing-worker / monolith** | Stop reconciliation intervals → `cleanupBillingIntervals()` with timeout `SHUTDOWN_BULLMQ_MS` (default 60s) |
| **moments-worker / monolith** | `stopMomentsWorkers()` |
| **image-worker / monolith** | `stopImagePipelineWorkers()` |
| **All** | `clearEventLoopProbe()` → `mongoose.disconnect()` |

Worker-only roles also call `httpServer.close()` on the health server after workers stop.

**Env tuning (optional):**

```bash
SHUTDOWN_HTTP_MS=30000
SHUTDOWN_BULLMQ_MS=60000
```

---

## 10. Background intervals: before vs after

### Before

Module-level `setInterval` in `server.ts` always registered:

- Task progress cleanup — every 6 h
- Creator lock cleanup — every 5 min

Plus all worker intervals inside their respective `start*` functions on **every** replica.

### After

| Interval | Runs on |
|----------|---------|
| Task progress cleanup (6 h) | `monolith`, `api-ws` only (`runsApiHygieneIntervals()`) |
| Creator lock cleanup (5 min) | `monolith`, `api-ws` only |
| Billing watchdog (5 s) | `monolith`, `billing-worker` |
| Moments fanout drain (5 s) | `monolith`, `moments-worker` |
| … | gated by respective `runs*Workers()` |

---

## 11. npm scripts & local development

### Before

```json
"start": "node dist/server.js"
```

Only way to run: full monolith.

### After

```json
"start": "node dist/server.js",
"start:api-ws": "node scripts/start-with-role.cjs api-ws",
"start:billing-worker": "node scripts/start-with-role.cjs billing-worker",
"start:moments-worker": "node scripts/start-with-role.cjs moments-worker",
"start:image-worker": "node scripts/start-with-role.cjs image-worker"
```

[`scripts/start-with-role.cjs`](../scripts/start-with-role.cjs) sets `process.env.ECS_SERVICE_ROLE` then requires `dist/server.js`.

**Local split test:**

```bash
npm run build
# Terminal 1
npm run start:api-ws
# Terminal 2 (shared Redis + Mongo)
npm run start:billing-worker
```

**Railway:** Leave `ECS_SERVICE_ROLE` unset → behaves as before.

---

## 12. Environment variable contract

Documented in [`.env.example`](../.env.example). Summary:

| Service | `ECS_SERVICE_ROLE` | Key differences |
|---------|---------------------|-----------------|
| api-ws | `api-ws` | Full routes; `SOCKET_IO_REDIS_ADAPTER=true`; no BullMQ worker |
| billing-worker | `billing-worker` | `BILLING_BULLMQ_CONCURRENCY=50`; headless adapter; `USE_MOMENTS=false` |
| moments-worker | `moments-worker` | `USE_MOMENTS=true`; no Socket.IO adapter |
| image-worker | `image-worker` | `USE_CLOUDFLARE_IMAGES=true`; low `MONGO_POOL_SIZE` |

Same Docker image at deploy time — only env blocks differ.

---

## 13. Tests added

| Test file | What it verifies |
|-----------|------------------|
| [`service-role.test.ts`](../src/config/service-role.test.ts) | Default monolith; per-role `runs*` flags; invalid role; ECS production fail-fast |
| [`service-role.boot.contract.test.ts`](../src/bootstrap/service-role.boot.contract.test.ts) | `server.ts` no longer starts workers inline; bootstrap modules own correct workloads; headless socket present |

Run:

```bash
npx tsx --test src/config/service-role.test.ts src/bootstrap/service-role.boot.contract.test.ts
```

Included in root `npm test`.

---

## 14. Documentation updates

[`INFRASTRUCTURE_SCALE_READINESS_AUDIT.md`](./INFRASTRUCTURE_SCALE_READINESS_AUDIT.md) changes:

- §8.5: `RUN_BACKGROUND_WORKERS` → **`ECS_SERVICE_ROLE` implemented**
- §9 diagram: `RUN_BACKGROUND_WORKERS=true` → `ECS_SERVICE_ROLE=billing-worker`
- §10 ECS readiness score: 5/10 → **7/10**
- §10.2 P0 item “Split billing-worker from api-ws” → **code ready; deploy deferred**
- Appendix: graceful shutdown marked **partial** (role-aware implemented)

---

## 15. What did NOT change

| Item | Status |
|------|--------|
| Dockerfile / ECR / ECS task defs | Not added (deferred) |
| Queue names / Redis keys | Unchanged |
| REST API routes | Unchanged (still on full `app` when api-ws/monolith) |
| `@socket.io/redis-emitter` | Not added; headless Server used instead |
| Moments global `io.emit` scaling issue | Out of scope (separate audit item) |
| Worker processes still **import** full Express `app` at module load | Known limitation — worker listens on minimal server only |

---

## 16. Success criteria checklist

| Criterion | Met? |
|-----------|:----:|
| `ECS_SERVICE_ROLE=api-ws` → zero BullMQ workers, zero reconciliation/moments/image loops | ✓ |
| `ECS_SERVICE_ROLE=billing-worker` → BullMQ + all billing recon; no client gateways; health/metrics only | ✓ |
| `ECS_SERVICE_ROLE=moments-worker` → fanout/analytics/warm/story jobs only | ✓ |
| `ECS_SERVICE_ROLE=image-worker` → blurhash + orphan cleanup only | ✓ |
| Billing emits from worker reach clients on api-ws via Redis adapter | ✓ (design; requires split-process manual verify) |
| Railway/local unchanged when role unset | ✓ |
| Production ECS without role fails fast | ✓ |

---

## 17. Next steps (deploy — out of scope for this PR)

1. Add `Dockerfile` + ECR push in CI
2. Create **four ECS services** with same image, different env blocks
3. Attach ALB **only** to `api-ws-service`
4. Set Fargate `stopTimeout` ≥ 60s (api-ws) / 90–120s (billing-worker)
5. Cutover: deploy workers first → api-ws behind ALB → drain Railway monolith

See ECS split plan Phase 8 for cutover order.

---

## 18. Quick reference — file → role mapping

```
ECS_SERVICE_ROLE unset     → monolith (everything)
ECS_SERVICE_ROLE=api-ws      → bootstrap-core + bootstrap-api-ws + full HTTP
ECS_SERVICE_ROLE=billing-worker → bootstrap-core + bootstrap-billing-workers + worker-health + headless socket
ECS_SERVICE_ROLE=moments-worker → bootstrap-core + bootstrap-moments-workers + worker-health
ECS_SERVICE_ROLE=image-worker   → bootstrap-core + bootstrap-image-workers + worker-health
```

All paths: `registerShutdownHandlers()` at module load in `server.ts`.
