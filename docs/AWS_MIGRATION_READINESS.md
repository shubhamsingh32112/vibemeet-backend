# AWS Migration Readiness Assessment

**Document version:** 1.0  
**Date:** 2026-06-06  
**Scope:** `backend/` — migration from Railway to AWS  
**Audience:** Engineering, DevOps, release owners

---

## Executive summary

The Eazy Talks backend is a **long-running monolithic Node.js/TypeScript process** (`Express` + `Socket.IO` + in-process `BullMQ` workers). It is **not tightly coupled to Railway** — there is no Railway SDK, no Railway HTTP calls at runtime, and Redis/Mongo connections are configured via standard environment variables.

| Question | Answer |
|----------|--------|
| Is the **application code** production-ready for AWS? | **Mostly yes** — architecture is cloud-agnostic and already multi-instance aware |
| Is **deployment** production-ready for AWS? | **No** — containerization, AWS infra, ElastiCache, secrets, and tuning are missing |
| Migration type | **Infrastructure and configuration project**, not an application rewrite |
| Estimated effort | **1–2 weeks** for a solid first production deploy (infra + testing) |
| Recommended compute | **ECS Fargate** (2+ tasks). **Not Lambda.** |
| Recommended Redis | **Amazon ElastiCache for Redis** (same VPC as ECS) |

**Highest-risk areas during migration:**

1. Redis cutover while active video calls hold billing state in Redis  
2. MongoDB connection pool sizing (`MONGO_POOL_SIZE × task count`)  
3. Billing throughput under multiple ECS tasks (`BILLING_BULLMQ_CONCURRENCY × task count`)  
4. Webhook URL changes (Razorpay, Stream, Cloudflare)

---

## Table of contents

1. [Current state (Railway)](#1-current-state-railway)
2. [Application architecture](#2-application-architecture)
3. [What works on AWS as-is](#3-what-works-on-aws-as-is)
4. [What is not production-ready](#4-what-is-not-production-ready)
5. [Recommended AWS architecture](#5-recommended-aws-architecture)
6. [Infrastructure checklist](#6-infrastructure-checklist)
7. [Environment variables](#7-environment-variables)
8. [Redis workloads](#8-redis-workloads)
9. [Background jobs and workers](#9-background-jobs-and-workers)
10. [WebSockets and load balancing](#10-websockets-and-load-balancing)
11. [Health checks and graceful shutdown](#11-health-checks-and-graceful-shutdown)
12. [Secrets management](#12-secrets-management)
13. [Cutover strategy](#13-cutover-strategy)
14. [Change severity matrix](#14-change-severity-matrix)
15. [Risks (prioritized)](#15-risks-prioritized)
16. [Pre-go-live checklist](#16-pre-go-live-checklist)
17. [Recommended tuning (2-task Fargate)](#17-recommended-tuning-2-task-fargate)
18. [Reference Dockerfile and ECS notes](#18-reference-dockerfile-and-ecs-notes)
19. [Code improvements (optional, post-migration)](#19-code-improvements-optional-post-migration)
20. [Key file index](#20-key-file-index)
21. [Related internal docs](#21-related-internal-docs)

---

## 1. Current state (Railway)

### How the backend runs today

| Aspect | Current setup |
|--------|---------------|
| Build | `npm run build` → TypeScript compile to `dist/` |
| Start | `node dist/server.js` |
| Deployment | Railway Nixpacks-style (no `Dockerfile` in repo) |
| Redis | Railway Redis — billing, BullMQ, presence, Socket.IO adapter, rate limits |
| Database | MongoDB Atlas via `MONGO_URI` |
| Media | Cloudflare Images + Cloudflare Stream (external SaaS) |
| Auth | Firebase Admin ID-token verification |
| Payments | Razorpay webhooks |
| Video | Stream Video + webhooks |

### Railway-specific artifacts in the codebase

These are **cosmetic or documentation-only** — they do not block AWS migration:

| Item | Location | Action on AWS |
|------|----------|---------------|
| `redis.railway.internal` hostname example | `.env.example` | Replace with ElastiCache endpoint |
| `proxy.rlwy.net` URL classifier | `src/config/redis.ts` | Harmless; ElastiCache uses different host |
| `RAILWAY_ENVIRONMENT` / `RAILWAY_PROJECT_ID` | `src/server.ts` | Not set on AWS; billing safety check still passes (BullMQ always enabled) |
| "Railway Redis" log strings | `src/config/redis.ts`, `src/server.ts` | Optional cleanup |
| Root-level Railway Redis docs | `RAILWAY_REDIS_*.md` (repo root) | Archive or update |

### What is missing from the repo

- `Dockerfile`
- `docker-compose.yml` (optional, for local parity)
- ECS task definition / Terraform / CDK
- CI/CD pipeline (build → ECR → deploy)
- ALB / target group configuration
- ElastiCache provisioning docs

---

## 2. Application architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Single Node.js process                       │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────────────┐ │
│  │ Express HTTP │  │  Socket.IO   │  │  BullMQ Workers        │ │
│  │  REST API    │  │  Gateways    │  │  (billing, images, …)  │ │
│  └──────┬───────┘  └──────┬───────┘  └───────────┬────────────┘ │
│         │                 │                       │              │
│  ┌──────┴─────────────────┴───────────────────────┴────────────┐ │
│  │ setInterval jobs: reconciliation, watchdog, webhooks, …    │ │
│  └─────────────────────────────────────────────────────────────┘ │
└──────────────────────────────┬──────────────────────────────────┘
                               │
         ┌─────────────────────┼─────────────────────┐
         ▼                     ▼                     ▼
   MongoDB Atlas         ElastiCache Redis      External APIs
   (MONGO_URI)           (REDIS_URL)            Cloudflare, Stream,
                                               Firebase, Razorpay
```

**Entry point:** `src/server.ts` → compiled to `dist/server.js`

**Critical startup guards (production):**

- `assertProductionSecurity()` — requires secure `JWT_SECRET`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`
- `assertProductionRedis()` — Redis must be configured
- `enforceProductionBillingDriverSafety()` — BullMQ billing driver (always enabled via `billing-driver.ts`)

**Why Lambda is not suitable:**

- Persistent WebSocket connections (Socket.IO)
- In-process BullMQ workers with high concurrency
- Dozens of `setInterval` background jobs in the same process
- Billing watchdog runs every ~5 seconds
- Payment webhook retry runs every ~15 seconds

---

## 3. What works on AWS as-is

No application code changes required for these areas if infrastructure is configured correctly.

| Area | Implementation | AWS compatibility |
|------|----------------|-------------------|
| HTTP API | Express on `PORT` (default 3000) | ECS Fargate, App Runner, Elastic Beanstalk |
| MongoDB | Mongoose + `MONGO_URI` | Atlas — allowlist AWS egress or VPC peering |
| Redis client | `ioredis` via `REDIS_URL` or host/port | ElastiCache — `redis://` or `rediss://` |
| Video billing | BullMQ + Redis session keys + per-call locks | Multi-task safe |
| Call settlement | Redis + Mongo + idempotency keys | Multi-task safe |
| Coin deduction | Atomic Redis/Mongo paths + reconciliation | Multi-task safe |
| Online/offline presence | Redis-authoritative TTL keys | Multi-task safe |
| Socket.IO scaling | `@socket.io/redis-adapter` | Required when running 2+ ECS tasks |
| Rate limiting | `rate-limit-redis` (falls back to in-memory if Redis missing) | Works with ElastiCache |
| Media uploads | Cloudflare Images/Stream direct upload | No S3 needed |
| Health probes | `/health`, `/live`, `/ready` | ALB/ECS ready |
| Webhook HMAC | Raw body preserved for Stream/Razorpay | Works through ALB if body not transformed |
| Distributed locks | Redis `SET NX` for reconciliation jobs | Safe across multiple tasks |

### Redis connection modes (already cloud-agnostic)

From `src/config/redis.ts`:

```typescript
// Priority:
// 1. REDIS_URL (preferred — private network)
// 2. REDIS_PUBLIC_URL (fallback — dev/public proxy)
// 3. REDISHOST + REDISPORT + REDIS_PASSWORD + REDISUSER

// TLS supported via rediss:// URL scheme
// REDIS_FAMILY=0|4|6 for DNS family override (optional)
```

### BullMQ billing (always enabled)

```typescript
// src/modules/billing/billing-driver.ts
export function isBullmqBillingEnabled(): boolean {
  return true;
}
```

Per-call Redis locks prevent double-charging when multiple workers process ticks concurrently.

---

## 4. What is not production-ready

### 4.1 No deployment artifacts — SEVERITY: **HIGH**

**Problem:** The repo has no container or AWS infrastructure definitions. Railway builds and runs the app implicitly.

**Required deliverables:**

| Artifact | Purpose |
|----------|---------|
| `Dockerfile` | Multi-stage build: `npm ci` → `npm run build` → production image |
| Amazon ECR repository | Store container images |
| ECS cluster + Fargate service | Run 2+ tasks for HA |
| Application Load Balancer | HTTPS termination, WebSocket support, health checks |
| Target group | Health check path: **`GET /ready`** |
| Route 53 / DNS | Point API domain to ALB |
| ACM certificate | TLS for HTTPS |
| NAT Gateway (if tasks in private subnets) | Outbound access to Atlas, Cloudflare, Stream, Razorpay |

**Effort:** 2–5 days (depending on IaC familiarity)

---

### 4.2 Redis must move to ElastiCache — SEVERITY: **HIGH**

**Problem:** Production requires Redis. Railway Redis will not be reachable from AWS VPC without a cross-cloud tunnel (not recommended).

**Production enforcement:**

```typescript
// src/server.ts — assertProductionRedis()
if (!isRedisConfigured()) {
  throw new Error(
    'NODE_ENV=production requires Redis. Add variable references: REDIS_URL ...'
  );
}
```

**ElastiCache requirements:**

| Setting | Recommendation | Why |
|---------|----------------|-----|
| Engine | Redis 7.x | BullMQ + ioredis compatibility |
| Node type | Size for peak concurrent calls + BullMQ queue depth | Billing keys are latency-sensitive |
| `maxmemory-policy` | **`noeviction`** | Billing/presence keys must never be evicted |
| Subnet group | Private subnets in same VPC as ECS | Security |
| Security group | Allow inbound 6379 from ECS task SG only | Least privilege |
| Multi-AZ | Enabled for production | HA during node failover |
| Encryption at rest | Recommended | Compliance |
| Encryption in transit | Optional — if enabled, use `rediss://` | Test with `npm run verify:redis` |
| AUTH token | Set via `REDIS_URL` or `REDIS_PASSWORD` | Required if auth enabled |

**Code change:** None — set `REDIS_URL` to ElastiCache primary endpoint.

**Effort:** 1–2 days (provisioning + VPC wiring + verification)

---

### 4.3 MongoDB connection pool sizing — SEVERITY: **HIGH**

**Problem:** Current production `.env` may use `MONGO_POOL_SIZE=1500`. With multiple ECS tasks:

```
Total Mongo connections = MONGO_POOL_SIZE × number_of_ECS_tasks
```

| Tasks | Pool per task | Total connections |
|-------|---------------|-------------------|
| 1 | 1500 | 1500 |
| 2 | 1500 | 3000 |
| 3 | 1500 | 4500 |
| 4 | 50 | 200 |

Atlas Flex/M10 tiers have connection limits (often 500–1500). Exceeding limits causes cascading `MongoServerSelectionError` failures.

**From `src/config/database.ts`:**

```typescript
// Defaults: MONGO_POOL_SIZE=50, MONGO_MIN_POOL_SIZE=5
// Comment warns: large pool × N replicas can exceed Atlas limits
```

**Action:**

1. Set `MONGO_POOL_SIZE=30` to `50` per ECS task  
2. Calculate: `(pool × desired_max_tasks) < Atlas_limit − headroom`  
3. Allowlist AWS NAT Gateway elastic IPs in Atlas Network Access, or use VPC peering / PrivateLink  
4. Monitor pool utilization via `GET /metrics`

**Effort:** Hours (env tuning + Atlas config)

---

### 4.4 Billing worker concurrency × replica count — SEVERITY: **HIGH**

**Problem:** Each ECS task runs a BullMQ worker in the same process as the API.

From `src/modules/billing/billing.queue.ts`:

```typescript
// Default concurrency fallback: 130 (capped at 200)
// Override: BILLING_BULLMQ_CONCURRENCY
```

| ECS tasks | Concurrency/task | Max parallel billing ticks |
|-----------|------------------|----------------------------|
| 1 | 130 | 130 |
| 2 | 130 | 260 |
| 4 | 130 | 520 |
| 2 | 50 | 100 |

Per-call Redis locks prevent double-charging, but high concurrency increases Redis/Mongo load and event-loop pressure.

**Action:**

- Start with `BILLING_BULLMQ_CONCURRENCY=50` per task  
- Scale task count for HA; tune concurrency down as task count rises  
- Monitor billing lag via `GET /metrics` and billing health logs

**Effort:** Hours (env tuning + load test)

---

### 4.5 WebSockets behind ALB — SEVERITY: **HIGH**

**Problem:** Socket.IO requires long-lived connections. Misconfigured ALB causes disconnect loops.

**Socket.IO config (from `src/server.ts`):**

```typescript
pingTimeout: 60000,   // 60 seconds
pingInterval: 25000,  // 25 seconds
transports: ['websocket', 'polling'],
```

**ALB requirements:**

| Setting | Value |
|---------|-------|
| WebSocket support | Enabled (default on ALB HTTP/HTTPS listeners) |
| Idle timeout | **≥ 120 seconds** (recommend 300s; must exceed `pingTimeout`) |
| Health check path | `/ready` |
| Health check interval | 30s |
| Healthy threshold | 2 |
| Unhealthy threshold | 3 |
| Stickiness | Optional — Redis adapter makes it unnecessary for broadcasts |
| `TRUST_PROXY_HOPS` | `1` (ALB only) or `2` (CloudFront + ALB) |

**Must keep enabled on all tasks:**

```
SOCKET_IO_REDIS_ADAPTER=true   # default when Redis configured
```

**Effort:** 1 day (ALB config + client reconnect testing)

---

### 4.6 Graceful shutdown incomplete — SEVERITY: **MEDIUM**

**Problem:** ECS sends `SIGTERM` before stopping a task. Current handler stops workers but does not drain HTTP or wait for in-flight BullMQ jobs.

From `src/server.ts`:

```typescript
process.on('SIGTERM', async () => {
  await cleanupBillingIntervals();
  stopReconciliationJob();
  stopBillingWatchdog();
  // ... other stops ...
  process.exit(0);  // immediate exit — no HTTP drain
});
```

**Mitigations already in codebase:**

- Billing watchdog (~5s interval) — detects stalled sessions  
- Billing reconciliation (~5 min) — repairs drift  
- Call reconciliation vs Stream (~5 min)  
- Payment webhook retry (~15s)  
- Redis DLQ for failed billing operations  

**Recommended improvement (optional, not a migration blocker):**

1. Set a shutdown flag; make `/ready` return 503  
2. Call `httpServer.close()` to stop accepting new connections  
3. Wait up to `ECS_CONTAINER_STOP_TIMEOUT` (e.g. 30s) for in-flight requests  
4. Close BullMQ workers with `worker.close()` grace period  
5. Disconnect Mongo/Redis cleanly  
6. Then `process.exit(0)`

**Effort:** 0.5–1 day

---

### 4.7 Secrets management — SEVERITY: **HIGH** (ops)

**Problem:** Secrets are loaded via `dotenv` at startup. Railway injects env vars at runtime. AWS needs an equivalent secure injection path.

**Do not:**

- Commit `.env` to git  
- Bake secrets into Docker image layers  
- Store secrets in plain ECS task definition JSON in git  

**Do:**

- Store secrets in **AWS Secrets Manager** or **SSM Parameter Store**  
- Reference secrets in ECS task definition `secrets` block  
- Use IAM task role for Secrets Manager access  
- Rotate Firebase, Razorpay, JWT secrets independently of deploys  

See also: `docs/SECURITY_SECRETS_ROTATION.md`

**Effort:** 0.5–1 day

---

### 4.8 Webhook URL updates — SEVERITY: **HIGH** (cutover)

**Problem:** External services call your backend via webhooks. Domain change breaks payments and video events silently if not updated.

| Service | Webhook path (approximate) | Secret env var |
|---------|---------------------------|----------------|
| Razorpay | Payment webhook routes under `/api/v1/payment/` | `RAZORPAY_KEY_SECRET` |
| Stream Video | `POST /api/v1/video/webhook` | `STREAM_VIDEO_API_SECRET` |
| Cloudflare Stream | `POST /api/v1/stream/webhook` | `CLOUDFLARE_STREAM_WEBHOOK_SECRET` |

**Also update:**

- `PUBLIC_API_BASE_URL` — used for checkout link generation  
- `WEB_CHECKOUT_BASE_URL` — wallet checkout web flow  
- Mobile app API base URL (if hardcoded or remote config)  
- `CORS_ORIGIN` — if web clients call API directly  

**Verify:** Webhook HMAC uses raw body bytes — ALB must not re-encode JSON payloads.

**Effort:** Hours (config updates + smoke tests)

---

## 5. Recommended AWS architecture

```
                         Internet
                             │
                             ▼
                    ┌────────────────┐
                    │   Route 53     │
                    │  api.domain    │
                    └───────┬────────┘
                            │
                            ▼
                    ┌────────────────┐
                    │      ALB       │
                    │  HTTPS + WS    │
                    │  /ready check  │
                    └───────┬────────┘
                            │
              ┌─────────────┴─────────────┐
              ▼                           ▼
     ┌─────────────────┐         ┌─────────────────┐
     │  ECS Task 1     │         │  ECS Task 2     │
     │  Fargate        │         │  Fargate        │
     │  (same image)   │         │  (same image)   │
     └────────┬────────┘         └────────┬────────┘
              │                           │
              └─────────────┬─────────────┘
                            │
         ┌──────────────────┼──────────────────┐
         ▼                  ▼                  ▼
  ┌─────────────┐   ┌─────────────┐   ┌──────────────────┐
  │ ElastiCache │   │ MongoDB     │   │ External SaaS    │
  │ Redis       │   │ Atlas       │   │ Cloudflare       │
  │ (private)   │   │ (SRV/URI)   │   │ Stream           │
  └─────────────┘   └─────────────┘   │ Firebase         │
                                       │ Razorpay         │
                                       └──────────────────┘
```

### Service selection

| AWS service | Role | Notes |
|-------------|------|-------|
| **ECS Fargate** | Run backend containers | Recommended primary choice |
| **ECR** | Container registry | One repo per service |
| **ALB** | Load balancing + TLS + WS | Not NLB (ALB handles HTTP health checks better) |
| **ElastiCache Redis** | Replace Railway Redis | Same VPC, private subnets |
| **Secrets Manager** | Secret injection | Or SSM Parameter Store |
| **CloudWatch Logs** | Log aggregation | App already logs structured JSON to stdout |
| **NAT Gateway** | Outbound internet from private subnets | Required for Atlas/Cloudflare/Stream if tasks are private |

**Not recommended:**

- **Lambda** — incompatible with long-running WebSocket + BullMQ architecture  
- **App Runner** — possible but less control over WebSocket idle timeouts and sidecar patterns  
- **ElastiCache Serverless** — evaluate carefully; BullMQ has specific Redis command/latency expectations; test thoroughly before production  

---

## 6. Infrastructure checklist

### Phase 1 — Foundation

- [ ] Create VPC (or use default) with public + private subnets across 2 AZs  
- [ ] Create ECR repository  
- [ ] Write and test `Dockerfile` locally  
- [ ] Build and push initial image to ECR  
- [ ] Create ElastiCache Redis cluster in private subnets  
- [ ] Configure security groups (ECS → Redis, ECS → internet via NAT)  
- [ ] Create Secrets Manager entries for all secrets from `.env.example`  
- [ ] Allowlist NAT Gateway IPs in MongoDB Atlas  

### Phase 2 — Compute

- [ ] Create ECS cluster  
- [ ] Create task definition (CPU, memory, env, secrets, health check)  
- [ ] Create ECS service with `desiredCount: 2`  
- [ ] Create ALB + target group (`/ready`, port 3000)  
- [ ] Attach ACM certificate to HTTPS listener  
- [ ] Point DNS to ALB  

### Phase 3 — Validation

- [ ] Run `npm run verify:redis` from a task or bastion in the VPC  
- [ ] Confirm `GET /ready` returns 200  
- [ ] Test Socket.IO connect/disconnect across 2 tasks  
- [ ] Run billing load test with 2+ tasks (see `docs/LOAD_TEST_*.md`)  
- [ ] Test Razorpay webhook on staging URL  
- [ ] Test Stream video webhook on staging URL  
- [ ] Deploy rolling update; observe billing recovery  

### Phase 4 — Cutover

- [ ] Schedule maintenance window OR blue/green with shared Redis  
- [ ] Update mobile app / remote config API URL (if needed)  
- [ ] Update all external webhook URLs  
- [ ] Monitor billing reconciliation and `/metrics` for 24–48 hours  
- [ ] Decommission Railway after stability confirmed  

---

## 7. Environment variables

### Must set for AWS production

| Variable | Purpose | AWS notes |
|----------|---------|-----------|
| `NODE_ENV` | `production` | Required |
| `PORT` | HTTP port | Use `3000`; map in task definition |
| `TRUST_PROXY_HOPS` | Express trust proxy | Set `1` behind ALB |
| `MONGO_URI` | Atlas connection string | Allowlist AWS egress |
| `MONGO_POOL_SIZE` | Per-task pool | **30–50**, not 1500 |
| `MONGO_MIN_POOL_SIZE` | Min pool | `5` |
| `REDIS_URL` | ElastiCache endpoint | `redis://` or `rediss://` |
| `JWT_SECRET` | Admin JWT | Secrets Manager |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | Admin portal | Secrets Manager |
| `FIREBASE_*` | Firebase Admin | Secrets Manager |
| `RAZORPAY_*` | Payments | Secrets Manager |
| `STREAM_*` | Stream Video/Chat | Secrets Manager |
| `CLOUDFLARE_*` | Images/Stream | Secrets Manager |
| `PUBLIC_API_BASE_URL` | Checkout links | New AWS domain |
| `WEB_CHECKOUT_BASE_URL` | Web wallet checkout | Unchanged or updated |
| `CORS_ORIGIN` | Web CORS | Explicit origins, not `*` |

### Scaling and billing tuning

| Variable | Default | AWS recommendation |
|----------|---------|-------------------|
| `BILLING_BULLMQ_CONCURRENCY` | 130 | **50** initially; tune after load test |
| `SOCKET_IO_REDIS_ADAPTER` | enabled | Keep enabled |
| `BILLING_INSTANCE_ID` | `hostname:pid` | Optional: set to ECS task ID for ops clarity |
| `RATE_LIMIT_REDIS` | enabled | Keep enabled |
| `CREATOR_DISCONNECT_GRACE_MS` | 3000 | Keep default unless testing shows flicker |

### Do not carry from Railway

| Variable | Reason |
|----------|--------|
| `RAILWAY_ENVIRONMENT` | Not used on AWS |
| `RAILWAY_PROJECT_ID` | Not used on AWS |
| `REDIS_PUBLIC_URL` | Use private `REDIS_URL` only in AWS |
| `REDISHOST=redis.railway.internal` | Invalid on AWS |

Full template: `.env.example`

---

## 8. Redis workloads

All of these depend on Redis being available and correctly configured.

| Workload | Module / file | Criticality |
|----------|---------------|-------------|
| Video call billing sessions | `billing.service.ts` | **Critical** |
| BullMQ billing cycle jobs | `billing.queue.ts` | **Critical** |
| BullMQ termination retry | `billing-termination.queue.ts` | **Critical** |
| Per-call distributed locks | `billing.service.ts`, `billing-settlement.service.ts` | **Critical** |
| Creator/user presence (online/offline/on_call) | `availability.service.ts`, `presence.service.ts` | **High** |
| Socket.IO cross-node broadcasts | `server.ts` (Redis adapter) | **High** (multi-task) |
| Rate limiting | `rate-limit.middleware.ts` | **Medium** |
| Admin/creator feed caches | `creator-feed-snapshot.service.ts` | **Medium** |
| Moments fanout queues | `feed-fanout.service.ts` | **Medium** (if `USE_MOMENTS=true`) |
| Image pipeline BullMQ | `images.bootstrap.ts` | **Medium** (if `USE_CLOUDFLARE_IMAGES=true`) |
| Reconciliation distributed locks | `billing-reconciliation.ts`, `call-reconciliation.ts` | **High** |
| Payment webhook retry locks | `payment-webhook-retry.service.ts` | **High** |
| Upload session / quota counters | `upload-session.service.ts`, `upload-quota.service.ts` | **Medium** |

### Redis verification script

Run before and after migration:

```bash
npm run verify:redis
```

Script location: `scripts/verify-redis.ts`

Tests: ping, read/write, sorted sets (billing), key helpers, `SET NX` locks.

Readiness endpoint also tests Redis R/W: `GET /ready`

---

## 9. Background jobs and workers

All workers run **inside the same Node process** as the HTTP server. Each ECS task runs a full copy of all workers.

| Worker / job | Interval / trigger | Multi-task safety |
|--------------|-------------------|-------------------|
| BullMQ billing worker | Per-call delayed jobs | Redis locks + queue distribution |
| BullMQ termination retry | On call end failures | Queue-based |
| Billing reconciliation | ~5 min | Redis lock `lock:reconciliation:billing` |
| Billing watchdog | ~5 sec | Idempotent Redis scans |
| Call reconciliation (Stream) | ~5 min | Redis lock |
| Payment webhook retry | ~15 sec | Redis lock |
| Domain event worker | Opt-in (`DOMAIN_EVENTS_ENABLED`) | Mongo outbox |
| Staff wallet reconcile | Opt-in daily | Full DB scan |
| Image blurhash / orphan cleanup | BullMQ + cron | Feature-flagged |
| Moments fanout / warm / analytics | Intervals + Redis lists | Feature-flagged |
| Creator lock cleanup | ~5 min | Redis keys |
| Task progress cleanup | ~6 hours | Mongo delete |
| Event loop lag probe | 1 sec | Per-task metric |

**Implication for AWS:** Scaling ECS task count scales worker capacity linearly. Tune `BILLING_BULLMQ_CONCURRENCY` inversely to task count.

**Optional future architecture:** Split BullMQ workers into a dedicated ECS service (same image, different entry command). Not required for initial migration.

---

## 10. WebSockets and load balancing

### Gateways

| Gateway | File | Events |
|---------|------|--------|
| Availability / presence | `availability.gateway.ts` | online, offline, on_call |
| Billing | `billing.gateway.ts`, `billing-socket.gateway.ts` | billing:update, call lifecycle |
| Moments | `moments.gateway.ts` | feed updates (if enabled) |
| Admin | `admin.gateway.ts` | admin dashboards |

### In-memory vs Redis state

| State | Location | Cross-task behavior |
|-------|----------|---------------------|
| Socket connection maps | In-memory per task | Local to task — OK |
| Presence truth | Redis | Shared across tasks |
| Billing session truth | Redis | Shared across tasks |
| Socket.IO broadcasts | Redis pub/sub adapter | Reaches clients on any task |

### Client impact during deploy

- WebSocket disconnect → client reconnects (Socket.IO built-in)  
- Brief creator offline flicker possible during task drain (`CREATOR_DISCONNECT_GRACE_MS=3000` mitigates)  
- Active calls: billing continues via BullMQ + Redis; REST fallbacks exist in `billing.service.ts`

---

## 11. Health checks and graceful shutdown

### Endpoints

| Path | Purpose | Use on AWS |
|------|---------|------------|
| `GET /health` | Basic liveness + uptime | Informational |
| `GET /live` | Process up | Optional liveness probe |
| `GET /ready` | Mongo state + Redis R/W test | **ALB target group health check** |
| `GET /metrics` | In-memory process metrics | Monitoring (per-task) |

**Important:** `/ready` returns **503** if Mongo is not connected or Redis R/W fails. Use this for ALB so unhealthy tasks are removed before they serve traffic.

### ECS health check (task definition)

```json
{
  "healthCheck": {
    "command": ["CMD-SHELL", "curl -f http://localhost:3000/ready || exit 1"],
    "interval": 30,
    "timeout": 5,
    "retries": 3,
    "startPeriod": 60
  }
}
```

### Graceful shutdown gap

| Step | Current behavior | Recommended |
|------|------------------|-------------|
| Stop accepting HTTP | ❌ Not done | `httpServer.close()` |
| Fail readiness | ❌ Not done | Return 503 on `/ready` |
| Drain in-flight requests | ❌ Not done | Wait up to 30s |
| Stop BullMQ worker gracefully | Partial | `worker.close()` |
| Disconnect Mongo/Redis | ❌ Not done | Explicit disconnect |
| ECS stop timeout | Default 30s | Align with drain logic |

Billing safety nets compensate but do not eliminate brief interruption risk during deploys.

---

## 12. Secrets management

### Secrets to store in AWS Secrets Manager

Group logically (example secret names):

| Secret name | Keys |
|-------------|------|
| `eazytalks/prod/mongo` | `MONGO_URI` |
| `eazytalks/prod/redis` | `REDIS_URL` |
| `eazytalks/prod/auth` | `JWT_SECRET`, `CHECKOUT_SESSION_SECRET`, `ADMIN_EMAIL`, `ADMIN_PASSWORD` |
| `eazytalks/prod/firebase` | `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY` |
| `eazytalks/prod/payments` | `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` |
| `eazytalks/prod/stream` | `STREAM_API_KEY`, `STREAM_API_SECRET`, `STREAM_VIDEO_API_SECRET` |
| `eazytalks/prod/cloudflare` | `CLOUDFLARE_*` tokens and keys |

### ECS task definition pattern

```json
"secrets": [
  {
    "name": "MONGO_URI",
    "valueFrom": "arn:aws:secretsmanager:region:account:secret:eazytalks/prod/mongo:MONGO_URI::"
  }
]
```

Non-secret config (URLs, feature flags, tuning) can remain in task definition `environment` block or SSM Parameter Store (String parameters).

---

## 13. Cutover strategy

### Option A — Maintenance window (simplest, lowest risk for billing)

1. Announce maintenance; stop new calls via app or feature flag  
2. Wait for active calls to settle (monitor Redis billing keys)  
3. Provision AWS stack + ElastiCache (empty Redis)  
4. Deploy backend to ECS; verify `/ready`  
5. Update DNS to AWS ALB (low TTL beforehand)  
6. Update all webhook URLs  
7. Resume traffic; monitor reconciliation for 24h  

**Pros:** No Redis data migration complexity  
**Cons:** Downtime window required

### Option B — Blue/green with shared Redis bridge (lower downtime)

1. Stand up AWS stack  
2. Temporarily point AWS `REDIS_URL` at Railway Redis public endpoint OR replicate data (complex — not recommended for billing keys)  
3. Run both Railway and AWS behind different URLs for staging validation  
4. Cut DNS when AWS validated  
5. Migrate Redis to ElastiCache during low-traffic window  

**Pros:** Pre-production validation on real infra  
**Cons:** Cross-cloud Redis latency; security exposure if using public Redis URL

### Option C — Parallel run (staging only)

1. Deploy AWS as staging environment (`staging-api.domain.com`)  
2. Point mobile staging builds to AWS  
3. Load test billing with 2+ tasks  
4. Execute Option A for production cutover  

**Recommended:** Option C for validation, then Option A for production cutover.

### Active call handling

Redis holds live billing session state. **Do not switch Redis endpoints mid-call** without:

- Waiting for all calls to end, OR  
- Accepting that watchdog/reconciliation will recover (may take seconds to minutes; user-visible billing glitches possible)

---

## 14. Change severity matrix

| Change | Severity | Code change? | Effort | Blocker? |
|--------|----------|--------------|--------|----------|
| Dockerfile + ECR + ECS + ALB | **High** | New infra files | 2–5 days | Yes |
| ElastiCache + VPC networking | **High** | Env only | 1–2 days | Yes |
| Secrets Manager / SSM | **High** | Env injection | 0.5–1 day | Yes |
| Mongo pool + Atlas networking | **High** | Env tuning | Hours | Yes |
| ALB WebSocket + TLS + health checks | **High** | Env (`TRUST_PROXY_HOPS`) | 1 day | Yes |
| Billing concurrency tuning | **High** | Env tuning | Hours | Yes |
| Webhook URL updates | **High** | External config | Hours | Yes |
| Graceful shutdown | **Medium** | Small code change | 0.5–1 day | No |
| CloudWatch logs / alarms | **Medium** | Optional IaC | 1–2 days | No |
| Centralized metrics (Datadog/Prometheus) | **Medium** | Optional | 1–2 days | No |
| Remove Railway strings in docs/logs | **Low** | Cosmetic | Minutes | No |
| Remove unused `@upstash/redis` dep | **Low** | Optional | Minutes | No |

---

## 15. Risks (prioritized)

### Critical

| # | Risk | Impact | Mitigation |
|---|------|--------|------------|
| 1 | **Active billing sessions during Redis cutover** | Broken calls, incorrect coin balances | Maintenance window; wait for calls to end; monitor reconciliation |
| 2 | **Redis key eviction** | Lost billing state, failed settlements | ElastiCache `noeviction` + memory alerts |

### High

| # | Risk | Impact | Mitigation |
|---|------|--------|------------|
| 3 | **Mongo connection exhaustion** | API-wide 500 errors | Lower `MONGO_POOL_SIZE`; calculate pool × tasks |
| 4 | **Webhook misconfiguration** | Silent payment/video failures | Staging webhook tests; alert on webhook error rate |
| 5 | **VPC networking misconfiguration** | Tasks can't reach Redis/Atlas | `verify:redis` from VPC; `/ready` checks |
| 6 | **ALB idle timeout too low** | WebSocket disconnect loops | Set idle timeout ≥ 120s |

### Medium

| # | Risk | Impact | Mitigation |
|---|------|--------|------------|
| 7 | **WebSocket disruption on deploy** | Brief offline flicker for creators | `CREATOR_DISCONNECT_GRACE_MS`; client reconnect |
| 8 | **Incomplete graceful shutdown** | Interrupted billing ticks | Watchdog + reconciliation; improve shutdown code |
| 9 | **TLS to Redis (`rediss://`)** | Connection failures at startup | Test with `verify:redis` before go-live |
| 10 | **Over-scaling ECS tasks** | Redis/Mongo overload | Cap task count; tune concurrency |

### Low

| # | Risk | Impact | Mitigation |
|---|------|--------|------------|
| 11 | **Per-task `/metrics`** | Misleading dashboards | Aggregate externally or scrape all tasks |
| 12 | **In-memory request queue** | Uneven load across tasks | ALB round-robin; optional stickiness |

---

## 16. Pre-go-live checklist

### Infrastructure

- [ ] ElastiCache reachable from ECS tasks (security groups verified)  
- [ ] MongoDB Atlas allows AWS egress IPs  
- [ ] NAT Gateway provides outbound internet for private tasks  
- [ ] ALB HTTPS certificate valid  
- [ ] ALB idle timeout ≥ 120 seconds  
- [ ] DNS TTL lowered before cutover  

### Application

- [ ] `npm run verify:redis` passes against ElastiCache  
- [ ] `GET /ready` returns 200 (mongo + redis checks pass)  
- [ ] `GET /live` returns 200  
- [ ] `NODE_ENV=production` startup guards pass (JWT, admin, Redis)  
- [ ] `TRUST_PROXY_HOPS=1` set  
- [ ] `MONGO_POOL_SIZE` ≤ 50 per task  
- [ ] `BILLING_BULLMQ_CONCURRENCY` tuned (start at 50)  
- [ ] `SOCKET_IO_REDIS_ADAPTER` not disabled  

### Functional smoke tests

- [ ] User login (Firebase token → API)  
- [ ] Creator goes online/offline (Socket.IO + Redis)  
- [ ] Video call start → billing ticks → settlement → coin deduction  
- [ ] Razorpay test payment webhook  
- [ ] Stream video webhook (call ended)  
- [ ] Wallet checkout URL generation (`PUBLIC_API_BASE_URL` correct)  

### Load tests (recommended)

- [ ] 2+ ECS tasks, 50 concurrent calls (see `docs/LOAD_TEST_*.md`)  
- [ ] Rolling deploy during low-traffic test call — verify recovery  
- [ ] Redis failover test (ElastiCache Multi-AZ)  

### Observability

- [ ] CloudWatch log group receiving stdout  
- [ ] Alarm on `/ready` failure rate (target group unhealthy hosts)  
- [ ] Alarm on ElastiCache memory > 80%  
- [ ] Alarm on Mongo connection errors in logs  

---

## 17. Recommended tuning (2-task Fargate)

Example starting point for production with **2 ECS Fargate tasks**:

### Task resources

| Setting | Value |
|---------|-------|
| CPU | 1 vCPU (1024) |
| Memory | 2 GB (2048) |
| Desired count | 2 |
| Min healthy percent | 100 |
| Max percent | 200 |

Adjust upward if load tests show event-loop lag (`/metrics` → `event_loop_lag_ms`).

### Environment (non-secret)

```env
NODE_ENV=production
PORT=3000
TRUST_PROXY_HOPS=1

MONGO_POOL_SIZE=40
MONGO_MIN_POOL_SIZE=5

BILLING_BULLMQ_CONCURRENCY=50
SOCKET_IO_REDIS_ADAPTER=true

CREATOR_DISCONNECT_GRACE_MS=3000
BILLING_RECOVERY_DEBOUNCE_MS=750

PUBLIC_API_BASE_URL=https://api.yourdomain.com/api/v1
WEB_CHECKOUT_BASE_URL=https://www.yourdomain.com
CORS_ORIGIN=https://www.yourdomain.com
```

### Capacity math

```
Mongo connections:  40 × 2 tasks = 80  (well within Atlas limits)
Billing concurrency: 50 × 2 tasks = 100 parallel ticks max
```

Re-evaluate after load testing against your target: ~50 concurrent calls, 200 creators, 1000 users/day (see `docs/FULL_APP_AUDIT_AND_SCALE_READINESS.md`).

---

## 18. Reference Dockerfile and ECS notes

### Example Dockerfile (not yet in repo — add when implementing)

```dockerfile
# syntax=docker/dockerfile:1

FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup -g 1001 -S nodejs && adduser -S nodejs -u 1001
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=builder /app/dist ./dist
USER nodejs
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD wget -qO- http://localhost:3000/ready || exit 1
CMD ["node", "dist/server.js"]
```

### ECS task definition highlights

| Field | Recommendation |
|-------|----------------|
| `requiresCompatibilities` | `["FARGATE"]` |
| `networkMode` | `awsvpc` |
| `cpu` / `memory` | 1024 / 2048 to start |
| `containerPort` | 3000 |
| `logConfiguration` | `awslogs` → CloudWatch |
| `secrets` | From Secrets Manager (see §12) |
| `stopTimeout` | 30–60 seconds (align with future graceful shutdown) |

### ALB target group

| Setting | Value |
|---------|-------|
| Protocol | HTTP |
| Port | 3000 |
| Health check path | `/ready` |
| Matcher | 200 |
| Deregistration delay | 30s |

---

## 19. Code improvements (optional, post-migration)

These are not blockers but reduce operational risk on AWS.

### 19.1 Graceful shutdown

Enhance `SIGTERM` handler in `src/server.ts`:

1. Export `httpServer` reference from `startServer()`  
2. Add `isShuttingDown` flag  
3. `/ready` returns 503 when shutting down  
4. `httpServer.close()` + timeout  
5. `await billingWorker?.close()`  
6. `mongoose.disconnect()` + `redis.disconnect()`  

### 19.2 Generic Redis log messages

Replace "Railway Redis connected successfully" with "Redis connected successfully" in `src/config/redis.ts` and `src/server.ts`.

### 19.3 Update `.env.example`

Replace:

```env
REDISHOST=redis.railway.internal
```

With:

```env
# AWS ElastiCache example (prefer REDIS_URL):
REDIS_URL=redis://:password@your-cluster.xxxxx.cache.amazonaws.com:6379
# REDISHOST=your-cluster.xxxxx.cache.amazonaws.com
# REDISPORT=6379
```

### 19.4 Remove unused dependency

`@upstash/redis` is in `package.json` but unused in application code. Safe to remove.

### 19.5 ECS task ID as billing instance ID

Set `BILLING_INSTANCE_ID` from ECS metadata endpoint in task bootstrap script, or inject via task definition from `${AWS_ECS_TASK_ID}` if exposed.

---

## 20. Key file index

| Topic | Path |
|-------|------|
| Server bootstrap, health, shutdown | `src/server.ts` |
| Redis config and key helpers | `src/config/redis.ts` |
| MongoDB pool config | `src/config/database.ts` |
| Env template | `.env.example` |
| BullMQ billing queue/worker | `src/modules/billing/billing.queue.ts` |
| Billing driver (always BullMQ) | `src/modules/billing/billing-driver.ts` |
| Billing service (sessions, ticks) | `src/modules/billing/billing.service.ts` |
| Billing settlement | `src/modules/billing/billing-settlement.service.ts` |
| Billing reconciliation | `src/modules/billing/billing-reconciliation.ts` |
| Billing watchdog | `src/modules/billing/billing-watchdog.service.ts` |
| Socket.IO availability gateway | `src/modules/availability/availability.gateway.ts` |
| Presence service | `src/modules/availability/presence.service.ts` |
| Call reconciliation (Stream) | `src/modules/video/call-reconciliation.ts` |
| Payment webhook retry | `src/modules/payment/payment-webhook-retry.service.ts` |
| Rate limiting | `src/middlewares/rate-limit.middleware.ts` |
| Redis verify script | `scripts/verify-redis.ts` |
| Scaling README | `README.md` |
| Secrets rotation | `docs/SECURITY_SECRETS_ROTATION.md` |
| Scale audit | `docs/FULL_APP_AUDIT_AND_SCALE_READINESS.md` |
| Billing rollout | `docs/BILLING_PRODUCTION_ROLLOUT.md` |

---

## 21. Related internal docs

| Document | Relevance |
|----------|-----------|
| `docs/FULL_APP_AUDIT_AND_SCALE_READINESS.md` | Scale targets and bottlenecks |
| `docs/BILLING_PRODUCTION_ROLLOUT.md` | Billing env vars and canary gates |
| `docs/BILLING_SCALABILITY_AUDIT_AND_REMEDIATION.md` | Multi-instance billing design |
| `docs/SETTLEMENT_IDEMPOTENCY.md` | Coin settlement correctness |
| `docs/SECURITY_SECRETS_ROTATION.md` | Secret rotation procedures |
| `docs/LOAD_TEST_*.md` | Load test reproduction for AWS validation |
| `docs/VIDEO_CALL_SYSTEM_E2E_AUDIT.md` | End-to-end call flow |
| `docs/PAYMENT_WEB_CHECKOUT_RUNBOOK.md` | Checkout URL dependencies |
| `README.md` | Multi-instance scaling env vars |

---

## Appendix A — Why not Lambda, App Runner, or Elastic Beanstalk?

| Platform | Verdict | Reason |
|----------|---------|--------|
| **Lambda** | ❌ Not suitable | WebSockets, BullMQ workers, persistent intervals |
| **ECS Fargate** | ✅ Recommended | Full control, multi-task, ALB integration |
| **App Runner** | ⚠️ Possible | Less control over WebSocket timeouts; harder sidecar patterns |
| **Elastic Beanstalk** | ⚠️ Possible | Works but ECS is more standard for containerized Node apps |
| **EKS** | ⚠️ Overkill | Unless you already run Kubernetes |

---

## Appendix B — External services (unchanged on AWS)

These services remain external; AWS migration only changes where your backend runs.

| Service | Purpose | AWS action |
|---------|---------|------------|
| MongoDB Atlas | Primary database | Allowlist AWS IPs |
| Cloudflare Images | Avatar/gallery CDN | None |
| Cloudflare Stream | Moments/reels video | Update webhook URL |
| Firebase | Auth, push notifications | None |
| Stream Video | 1:1 video calls | Update webhook URL |
| Stream Chat | In-app chat | None |
| Razorpay | Coin purchases | Update webhook URL |

---

## Appendix C — Glossary

| Term | Meaning |
|------|---------|
| BullMQ | Redis-backed job queue used for billing cycle ticks |
| ElastiCache | AWS managed Redis/Memcached service |
| ECS Fargate | Serverless container compute for ECS |
| ALB | Application Load Balancer — Layer 7 HTTP/WebSocket |
| `/ready` | Readiness probe — checks Mongo + Redis R/W |
| Presence | Creator online/offline/on_call state in Redis |
| Reconciliation | Background job that repairs billing/call drift |
| Watchdog | Fast (~5s) billing stall detector |

---

*End of document.*
