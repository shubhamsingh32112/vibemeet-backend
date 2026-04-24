# Stream Chat Production Purge Runbook

This runbook permanently removes Stream Chat production data:
- all channels/messages (hard delete)
- all users

It uses `backend/reset-stream.js`.

## Preconditions

- Approved maintenance window.
- Confirm this action is irreversible.
- Valid production Stream credentials in `backend/.env`:
  - `STREAM_API_KEY`
  - `STREAM_API_SECRET`
- Node dependencies installed in `backend/`.

## Safety Controls

The script enforces destructive guards:
- `STREAM_PURGE_ENV=production`
- `STREAM_PURGE_CONFIRM=DELETE_ALL_STREAM_DATA`

Without both values, destructive mode exits with error.

## 1) Preflight Dry Run (Mandatory)

From `backend/`, run:

```powershell
$env:STREAM_DRY_RUN="true"
$env:STREAM_HARD_DELETE="true"
$env:STREAM_DELETE_USERS="true"
$env:STREAM_PURGE_ENV="production"
$env:STREAM_PURGE_CONFIRM="DELETE_ALL_STREAM_DATA"
node .\reset-stream.js
```

Expected output:
- Header showing mode as `DRY RUN`
- Channel sample and user sample counts
- No deletions performed

## 2) Destructive Purge

From `backend/`, run:

```powershell
$env:STREAM_DRY_RUN="false"
$env:STREAM_HARD_DELETE="true"
$env:STREAM_DELETE_USERS="true"
$env:STREAM_PURGE_ENV="production"
$env:STREAM_PURGE_CONFIRM="DELETE_ALL_STREAM_DATA"
node .\reset-stream.js
```

Expected flow:
- `Phase 1: deleting channels...`
- `Phase 2: deleting users...`
- Final line: `Purge complete with zero failures.`

If it exits non-zero:
- inspect failed IDs printed in the output
- rerun the same command after transient API issues resolve

## 3) Post-Purge Verification

Re-run dry-run to confirm zero-state:

```powershell
$env:STREAM_DRY_RUN="true"
$env:STREAM_HARD_DELETE="true"
$env:STREAM_DELETE_USERS="true"
$env:STREAM_PURGE_ENV="production"
$env:STREAM_PURGE_CONFIRM="DELETE_ALL_STREAM_DATA"
node .\reset-stream.js
```

Expected verification:
- channels sampled: `0`
- users listed: `0` (or only intentionally retained service users, if policy changed)

## 4) Audit Closure

- Save terminal output as evidence.
- Record:
  - operator
  - UTC timestamp
  - dry-run counts before deletion
  - destructive run outcome
  - final verification counts

## Recovery After Purge (Same Firebase UID)

If users fail chat bootstrap after purge with Stream error `code 16` / `user was deleted`:

- Deploy backend recovery logic (`ensureStreamUser` reactivation + upsert retry).
- Optionally run bulk reactivation to reduce first-login recovery latency.

Bulk reactivation command from `backend/`:

```powershell
$env:STREAM_DRY_RUN="true"
node .\scripts\stream-reactivate-users.js
```

Then destructive run:

```powershell
$env:STREAM_DRY_RUN="false"
node .\scripts\stream-reactivate-users.js
```

Verification checklist:
- Existing Firebase UID can log in successfully.
- `POST /chat/token` returns success for previously deleted Stream users.
- Opening chat recreates missing channels with deterministic channel IDs.
- App no longer surfaces generic `Network error` for Stream user recovery failures.

## Notes

- Batch and task wait controls (optional):
  - `STREAM_BATCH_SIZE` (default `100`)
  - `STREAM_TASK_MAX_WAIT_MS` (default `120000`)
  - `STREAM_DRY_RUN_SAMPLE` (default `10`)
  - `STREAM_USER_LIST_LIMIT` (default `100`)
  - `STREAM_USER_DELETE_DELAY_MS` (default `250`)
  - `STREAM_USER_DELETE_MAX_RETRIES` (default `6`)
  - `STREAM_USER_DELETE_RETRY_BASE_MS` (default `1500`)
- Reactivation script controls:
  - `STREAM_REACTIVATE_BATCH_SIZE` (default `100`)
  - `STREAM_REACTIVATE_ONLY_DEACTIVATED` (default `true`)
