# Backend Docker build & deploy (moments upload fix)

After pulling these changes, rebuild and redeploy so production stops using the old
Cloudflare API `/blob` path for image commit.

```bash
cd backend
npm run build

# Pick a unique tag, e.g. upload-fix-20260620
export BUILD_ID=adminMoments

docker build -t app-backend:webcall  .

docker tag app-backend:webcall  624905204878.dkr.ecr.ap-south-1.amazonaws.com/app-backend:webcall 

aws --no-verify-ssl ecr get-login-password --region ap-south-1 | docker login --username AWS --password-stdin 624905204878.dkr.ecr.ap-south-1.amazonaws.com

docker push 624905204878.dkr.ecr.ap-south-1.amazonaws.com/app-backend:webcall 
```

Then update the ECS task definition image tag to `$BUILD_ID` and force a new deployment.

**Smoke test after deploy**
1. Creator uploads a moment photo — expect `POST /moments` 201 and log `image asset committed` (no `download_image_bytes: HTTP 403`).
2. Creator uploads a moment video — expect upload-status poll to reach `ready` without webhook, then `POST /moments` 201.

No new APK is required for the backend fixes. The optional "Processing video…" status text needs a new app build.

## Stuck settling calls (billing deadlock cleanup)

Before or after deploying billing settlement fixes, inspect and clean zombie `call_sessions` stuck in `settling`:

```bash
cd backend

# Count stuck docs in Mongo shell
# db.call_sessions.countDocuments({ finalized: false, state: 'settling' })

# Report only (default)
npx tsx src/scripts/reconcile-stuck-settling-calls.ts --dry-run

# Reset stale settling → ending and enqueue immediate settlement retry
npx tsx src/scripts/reconcile-stuck-settling-calls.ts --execute --action retry-finalize

# Dead-letter unrecoverable orphans (clears Redis retry queue + creator slots)
npx tsx src/scripts/reconcile-stuck-settling-calls.ts --execute --action dead-letter --call-id <callId>

# Recover failed_settlement calls with real billing (billingSequence > 0)
npx tsx src/scripts/reconcile-stuck-settling-calls.ts --execute --action recover-failed

# Recover zero-sequence failed_settlement zombies (optional)
npx tsx src/scripts/reconcile-stuck-settling-calls.ts --execute --action recover-failed --force
```

Optional flags: `--min-age-ms 180000` (default `BILLING_MAX_SETTLING_MS`), `--call-id <id>` for a single call, `--force` for recover-failed with billingSequence 0.

## Billing admission + offline creator gating (api-ws fix)

Deploy **both** `api-ws` and `billing-worker` after pulling billing/offline changes.

```bash
cd backend
npm run build

export BUILD_ID=billing-offline-fix-$(date +%Y%m%d)

docker build -t app-backend:$BUILD_ID .
docker tag app-backend:$BUILD_ID 624905204878.dkr.ecr.ap-south-1.amazonaws.com/app-backend:$BUILD_ID

aws --no-verify-ssl ecr get-login-password --region ap-south-1 | docker login --username AWS --password-stdin 624905204878.dkr.ecr.ap-south-1.amazonaws.com

docker push 624905204878.dkr.ecr.ap-south-1.amazonaws.com/app-backend:$BUILD_ID
```

Update ECS task definitions for **api-ws** and **billing-worker** to `$BUILD_ID`, then force new deployments.

Optional env (defaults are safe):

```
BILLING_RECOVERY_EMPTY_DEBOUNCE_MS=2000
BILLING_RECOVERY_EMPTY_CACHE_TTL_SECONDS=3
```

**Flutter app:** rebuild APK/IPA for offline auto-reject + outgoing availability guard (`incoming_call_listener.dart`, `call_connection_controller.dart`). Backend webhook reject works without app update.

### Post-deploy log checklist (same minute on api-ws + billing-worker)

| Signal | Broken | Target |
|--------|--------|--------|
| `billing_emit_started` | 0 | > 0 on live calls |
| `billing_start_rejected_system_busy` | sustained | near 0 |
| `billing_state_recovery_empty` | high | OK if no heal/tick follows |
| `billing_sync_warning_client` `hasSession=false` | stuck loop | decreases |
| `Settlement complete` | 0 | > 0 after hang-up |
| `call_rejected_creator_offline` | N/A | when toggle off + ring attempt |
| `Post-call restore using Redis base` | N/A | snapshot missing + Redis offline |

### Download CloudWatch logs (api-ws + billing-worker)

Before running the script, verify AWS CLI credentials (ECR `docker login` does **not** authenticate CloudWatch):

```bash
aws sts get-caller-identity
```

If that returns your account details, download logs for any date range:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File backend/scripts/download-cloudwatch-logs.ps1 `
    -StartDate "2026-06-27" `
    -EndDate "2026-07-03" `
    -NoVerifySsl
```

Output (repo root) — pretty-printed JSON files:

```
aws_logs/
├── api-ws.json
└── billing-worker.json
```

Each file is a JSON document with `logGroup`, `startDate`, `endDate`, `region`, `eventCount`, and an `events` array of CloudWatch log records.

Covers `/ecs/api-ws` and `/ecs/billing-worker` from start of `StartDate` through end of `EndDate` (23:59:59.999 local time). Optional: `-Region "ap-south-1"` (default).

### Manual QA

1. User calls **online** creator: overlay leaves "Syncing billing…" within ~2s; coins decrement; creator earnings increment; settlement on hang-up.
2. Creator calls user: same billing behavior.
3. Toggle **OFF**: fan cannot start call; creator auto-rejects incoming ring; webhook logs `call_rejected_creator_offline`.
4. Toggle OFF through call end: creator stays offline in feed.

## Moments access mode (`MOMENTS_ACCESS_MODE`)

Set on the ECS task / backend `.env`:

| Value | Behavior |
|-------|----------|
| `paid` (default) | Non-premium users see admin previews + locked feed; Moments Premium checkout enabled |
| `free` | All authenticated users see every ready, approved, non-deleted moment unlocked, including VIP-tier moments; premium UI hidden |

```env
USE_MOMENTS=true
MOMENTS_ACCESS_MODE=paid   # or free
```

After changing this value, redeploy the backend. Feed cache keys include `accessMode`, so stale locked/unlocked payloads should not persist across mode switches.

`USE_MOMENTS=true` enables the routes and UI; it does not select access policy.
Both flags are required for globally free Moments.

## Creator presence toggle fix (multi-node api-ws)

Deploy backend code **and** enable the Redis socket registry on **all** `api-ws` ECS tasks. Without the registry flag, heartbeats on tasks that do not hold the creator WebSocket falsely force `DISCONNECTED` (~45s–3min after toggle ON).

```bash
cd backend
npm run build

export BUILD_ID=presence-toggle-fix-$(date +%Y%m%d)

docker build -t app-backend:$BUILD_ID .
docker tag app-backend:$BUILD_ID 624905204878.dkr.ecr.ap-south-1.amazonaws.com/app-backend:$BUILD_ID

aws --no-verify-ssl ecr get-login-password --region ap-south-1 | docker login --username AWS --password-stdin 624905204878.dkr.ecr.ap-south-1.amazonaws.com

docker push 624905204878.dkr.ecr.ap-south-1.amazonaws.com/app-backend:$BUILD_ID
```

Update the **api-ws** ECS task definition image tag to `$BUILD_ID`, then set these env vars on **every** api-ws task before forcing a new deployment:

```env
PRESENCE_REDIS_SOCKET_REGISTRY_ENABLED=true
PRESENCE_REGISTRY_SHADOW=true
```

Optional during first 24h cutover: keep `PRESENCE_REGISTRY_SHADOW=true` and watch CloudWatch for `presence.registry.shadow_mismatch` and log rate of `creator_heartbeat_no_sockets` (expect >95% drop vs Jul 4–5 baseline).

**Rollback:** `PRESENCE_REDIS_SOCKET_REGISTRY_ENABLED=false` on all api-ws tasks.

**Flutter:** rebuild APK/IPA for toggle/status reconciliation (`creator_status_provider.dart`, `creator_availability_toggle_provider.dart`).

### Post-deploy presence checklist

| Signal | Broken | Target |
|--------|--------|--------|
| `creator_heartbeat_no_sockets` | sustained high | near 0 |
| `presence.heartbeat_deferred_no_local_socket` | N/A | OK on REST-only nodes |
| `presence.heartbeat_abort_cluster_still_connected` | N/A | rare; no false offline |
| Creator toggle ON 10+ min | fans see offline | fans see online |

### Manual QA

1. Creator toggles ON, stays on home 10+ min — fans see online; no `creator_heartbeat_no_sockets` in logs.
2. Toggle OFF — immediate offline for fans.
3. Toggle ON after false offline — recovers within ~2s; status shows Online (not stuck Syncing/Offline).
4. Background/resume with toggle ON — restores without manual re-toggle.
5. During live call — stays on_call; no offline flip.
