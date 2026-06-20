# Backend Docker build & deploy (moments upload fix)

After pulling these changes, rebuild and redeploy so production stops using the old
Cloudflare API `/blob` path for image commit.

```bash
cd backend
npm run build

# Pick a unique tag, e.g. upload-fix-20260620
export BUILD_ID=DioUploadFix

docker build -t app-backend:deadlock  .

docker tag app-backend:deadlock  624905204878.dkr.ecr.ap-south-1.amazonaws.com/app-backend:deadlock 

aws --no-verify-ssl ecr get-login-password --region ap-south-1 | docker login --username AWS --password-stdin 624905204878.dkr.ecr.ap-south-1.amazonaws.com

docker push 624905204878.dkr.ecr.ap-south-1.amazonaws.com/app-backend:deadlock 
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
