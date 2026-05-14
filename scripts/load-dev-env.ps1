# Preload dev TLS/DNS vars from .env before Node starts (dotenv is too late for NODE_EXTRA_CA_CERTS).
$ErrorActionPreference = 'Stop'
$script:BackendRoot = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $script:BackendRoot '.env'

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
