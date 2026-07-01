# Run moments migrations with dev TLS/DNS env preloaded (NODE_EXTRA_CA_CERTS, LOAD_TEST_DNS_SERVERS).
# Usage (from repo root or backend):
#   powershell -NoProfile -ExecutionPolicy Bypass -File backend/scripts/run-moment-migrations.ps1
#   cd backend; powershell -NoProfile -ExecutionPolicy Bypass -File ./scripts/run-moment-migrations.ps1

$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\load-dev-env.ps1"

Set-Location $BackendRoot

Write-Host "Running upload reward status migration..."
npx tsx migrations/20260702_add_upload_reward_status.ts
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host ""
Write-Host "Running VIP highlight flag migration..."
npx tsx migrations/20260702_add_vip_highlight_flag.ts
exit $LASTEXITCODE
