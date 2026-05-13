# Loads TLS/DNS dev vars from .env into the process environment BEFORE Node
# starts (required for NODE_EXTRA_CA_CERTS — dotenv inside server.ts is too late).
$ErrorActionPreference = 'Stop'
$backendRoot = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $backendRoot '.env'

if (Test-Path $envFile) {
  Get-Content $envFile | ForEach-Object {
    $line = $_.Trim()
    if ($line -eq '' -or $line.StartsWith('#')) { return }
    $eq = $line.IndexOf('=')
    if ($eq -lt 1) { return }
    $key = $line.Substring(0, $eq).Trim()
    $val = $line.Substring($eq + 1).Trim().Trim('"').Trim("'")
    if ($key -in @('NODE_EXTRA_CA_CERTS', 'LOAD_TEST_DNS_SERVERS')) {
      Set-Item -Path "Env:$key" -Value $val
    }
  }
}

Set-Location $backendRoot
& node ./node_modules/tsx/dist/cli.mjs watch src/server.ts
