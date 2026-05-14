param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$Command
)

. "$PSScriptRoot\load-dev-env.ps1"

if (-not $Command -or $Command.Count -eq 0) {
  throw 'Usage: with-dev-env.ps1 <command> [args...]'
}

Set-Location $BackendRoot
$cmdArgs = @()
if ($Command.Count -gt 1) {
  $cmdArgs = $Command[1..($Command.Count - 1)]
}
& $Command[0] @cmdArgs
