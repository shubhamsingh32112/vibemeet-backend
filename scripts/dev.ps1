. "$PSScriptRoot\load-dev-env.ps1"

Set-Location $BackendRoot
& node ./node_modules/tsx/dist/cli.mjs watch src/server.ts
