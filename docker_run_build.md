# Backend Docker build & deploy (moments upload fix)

After pulling these changes, rebuild and redeploy so production stops using the old
Cloudflare API `/blob` path for image commit.

```bash
cd backend
npm run build

# Pick a unique tag, e.g. upload-fix-20260620
export BUILD_ID=DioUploadFix

docker build -t app-backend:Premiumcheckout  .

docker tag app-backend:Premiumcheckout  624905204878.dkr.ecr.ap-south-1.amazonaws.com/app-backend:Premiumcheckout 

aws --no-verify-ssl ecr get-login-password --region ap-south-1 | docker login --username AWS --password-stdin 624905204878.dkr.ecr.ap-south-1.amazonaws.com

docker push 624905204878.dkr.ecr.ap-south-1.amazonaws.com/app-backend:Premiumcheckout 
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

### Manual QA

1. User calls **online** creator: overlay leaves "Syncing billing…" within ~2s; coins decrement; creator earnings increment; settlement on hang-up.
2. Creator calls user: same billing behavior.
3. Toggle **OFF**: fan cannot start call; creator auto-rejects incoming ring; webhook logs `call_rejected_creator_offline`.
4. Toggle OFF through call end: creator stays offline in feed.
