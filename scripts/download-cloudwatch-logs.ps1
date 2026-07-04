# Download CloudWatch logs for /ecs/api-ws and /ecs/billing-worker.
#
# Usage (from repo root):
#   powershell -NoProfile -ExecutionPolicy Bypass -File backend/scripts/download-cloudwatch-logs.ps1 `
#       -StartDate "2026-06-27" `
#       -EndDate "2026-07-03" `
#       -NoVerifySsl
#
# Prerequisites: AWS CLI installed and configured (aws sts get-caller-identity).
# ECR docker login does NOT authenticate the AWS CLI for CloudWatch.
# Use -NoVerifySsl when corporate TLS inspection breaks AWS CLI certificate validation.

param(
    [Parameter(Mandatory = $true)]
    [string]$StartDate,

    [Parameter(Mandatory = $true)]
    [string]$EndDate,

    [string]$Region = 'ap-south-1',

    [switch]$NoVerifySsl
)

$ErrorActionPreference = 'Stop'
$env:PYTHONIOENCODING = 'utf-8'
$env:PYTHONUTF8 = '1'

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$OutputDir = Join-Path $RepoRoot 'aws_logs'
$script:UseNoVerifySsl = [bool]$NoVerifySsl
$script:Utf8NoBom = New-Object System.Text.UTF8Encoding $false

function Get-AwsCliPrefixArgs {
    if ($script:UseNoVerifySsl) { return @('--no-verify-ssl') }
    return @()
}

function Test-AwsCliInstalled {
    if (-not (Get-Command aws -ErrorAction SilentlyContinue)) {
        Write-Host @"
Error: AWS CLI is not installed or 'aws' is not on PATH.

Install AWS CLI v2:
  https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html
"@ -ForegroundColor Red
        exit 1
    }
}

function Invoke-AwsCli {
    param(
        [string[]]$CommandArgs,
        [switch]$KeepOutputFile
    )

    $fullArgs = @(Get-AwsCliPrefixArgs) + @($CommandArgs)
    $tempOut = [System.IO.Path]::GetTempFileName()
    $tempErr = [System.IO.Path]::GetTempFileName()

    try {
        $proc = Start-Process -FilePath 'aws' -ArgumentList $fullArgs -Wait -PassThru -NoNewWindow `
            -RedirectStandardOutput $tempOut -RedirectStandardError $tempErr
        $stderr = if (Test-Path $tempErr) { Get-Content $tempErr -Raw -Encoding UTF8 } else { '' }

        if ($proc.ExitCode -ne 0) {
            if ($stderr) { Write-Host $stderr.Trim() -ForegroundColor Red }
            $stdout = if (Test-Path $tempOut) { Get-Content $tempOut -Raw -Encoding UTF8 } else { '' }
            if ($stdout) { Write-Host $stdout.Trim() -ForegroundColor Red }
            return @{ ExitCode = $proc.ExitCode; Output = $stdout; OutputPath = $null }
        }

        if ($KeepOutputFile) {
            return @{ ExitCode = 0; Output = $null; OutputPath = $tempOut }
        }

        $output = if (Test-Path $tempOut) { Get-Content $tempOut -Raw -Encoding UTF8 } else { '' }
        return @{ ExitCode = 0; Output = $output; OutputPath = $null }
    }
    finally {
        if (Test-Path $tempErr) { Remove-Item $tempErr -Force }
        if (-not $KeepOutputFile -and (Test-Path $tempOut)) { Remove-Item $tempOut -Force }
    }
}

function Test-AwsCredentials {
    $result = Invoke-AwsCli -CommandArgs @(
        'sts', 'get-caller-identity',
        '--region', $Region,
        '--output', 'json'
    )

    if ($result.ExitCode -ne 0) {
        Write-Host @"

Error: AWS credentials are not valid or not configured.

Note: 'aws ecr get-login-password | docker login' only authenticates Docker to ECR.
It does NOT configure AWS CLI credentials for CloudWatch.

Configure credentials with one of:
  aws configure
  aws sso login
  Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY

Then verify with:
  aws sts get-caller-identity
"@ -ForegroundColor Red
        exit 1
    }

    $identity = $result.Output.Trim() | ConvertFrom-Json
    Write-Host "Authenticated as $($identity.Arn) (account $($identity.Account))"
}

function Get-DayEpochRanges {
    param(
        [string]$Start,
        [string]$End
    )

    $culture = [System.Globalization.CultureInfo]::InvariantCulture
    $format = 'yyyy-MM-dd'

    try {
        $startDay = [DateTime]::ParseExact($Start, $format, $culture).Date
        $endDay = [DateTime]::ParseExact($End, $format, $culture).Date
    }
    catch {
        Write-Host "Error: Invalid date format. Use yyyy-MM-dd (e.g. 2026-06-27)." -ForegroundColor Red
        exit 1
    }

    if ($endDay -lt $startDay) {
        Write-Host "Error: EndDate ($End) must not be before StartDate ($Start)." -ForegroundColor Red
        exit 1
    }

    $epoch = [DateTime]'1970-01-01T00:00:00Z'
    $ranges = New-Object System.Collections.Generic.List[object]

    for ($day = $startDay; $day -le $endDay; $day = $day.AddDays(1)) {
        $dayEnd = $day.AddHours(23).AddMinutes(59).AddSeconds(59).AddMilliseconds(999)
        $ranges.Add([ordered]@{
            Label   = $day.ToString($format, $culture)
            StartMs = [long](($day.ToUniversalTime() - $epoch).TotalMilliseconds)
            EndMs   = [long](($dayEnd.ToUniversalTime() - $epoch).TotalMilliseconds)
        })
    }

    return $ranges.ToArray()
}

function Start-JsonLogFile {
    param(
        [string]$OutFile,
        [string]$LogGroupName,
        [string]$StartDate,
        [string]$EndDate,
        [string]$Region
    )

    $writer = New-Object System.IO.StreamWriter($OutFile, $false, $script:Utf8NoBom)
    $writer.WriteLine('{')
    $writer.WriteLine(('  "logGroup": {0},' -f (($LogGroupName | ConvertTo-Json -Compress))))
    $writer.WriteLine(('  "startDate": {0},' -f (($StartDate | ConvertTo-Json -Compress))))
    $writer.WriteLine(('  "endDate": {0},' -f (($EndDate | ConvertTo-Json -Compress))))
    $writer.WriteLine(('  "region": {0},' -f (($Region | ConvertTo-Json -Compress))))
    $writer.WriteLine('  "events": [')

    return @{
        Writer     = $writer
        FirstEvent = $true
        Count      = 0
    }
}

function Write-JsonLogEvent {
    param(
        $State,
        $Event
    )

    $eventJson = $Event | ConvertTo-Json -Depth 100 -Compress
    if ($State.FirstEvent) {
        $State.Writer.WriteLine(('    {0}' -f $eventJson))
        $State.FirstEvent = $false
    }
    else {
        $State.Writer.WriteLine(('    ,{0}' -f $eventJson))
    }
    $State.Count++
}

function Complete-JsonLogFile {
    param($State)

    $State.Writer.WriteLine('  ],')
    $State.Writer.WriteLine(('  "eventCount": {0}' -f $State.Count))
    $State.Writer.WriteLine('}')
    $State.Writer.Flush()
    $State.Writer.Close()
}

function Download-CloudWatchLogGroup {
    param(
        [string]$LogGroupName,
        [array]$DayRanges,
        [string]$OutFile,
        [string]$StartDate,
        [string]$EndDate,
        [string]$Region
    )

    Write-Host "Downloading $LogGroupName..."

    $jsonState = Start-JsonLogFile -OutFile $OutFile -LogGroupName $LogGroupName `
        -StartDate $StartDate -EndDate $EndDate -Region $Region
    $page = 0

    foreach ($dayRange in $DayRanges) {
        Write-Host "  Day $($dayRange.Label)"

        $nextToken = $null
        $previousToken = $null

        do {
            $page++
            Write-Host "  Page $page"

            $awsArgs = @(
                'logs', 'filter-log-events',
                '--log-group-name', $LogGroupName,
                '--start-time', $dayRange.StartMs.ToString(),
                '--end-time', $dayRange.EndMs.ToString(),
                '--region', $Region,
                '--output', 'json'
            )
            if ($nextToken) {
                $awsArgs += '--next-token'
                $awsArgs += $nextToken
            }

            $result = Invoke-AwsCli -CommandArgs $awsArgs -KeepOutputFile
            if ($result.ExitCode -ne 0) {
                $jsonState.Writer.Close()
                Write-Host "Error: Failed to download logs from $LogGroupName." -ForegroundColor Red
                exit 1
            }

            try {
                $responseText = Get-Content $result.OutputPath -Raw -Encoding UTF8
                $response = $responseText | ConvertFrom-Json

                if ($response.events) {
                    foreach ($event in $response.events) {
                        Write-JsonLogEvent -State $jsonState -Event $event
                    }
                }

                $previousToken = $nextToken
                $nextToken = $response.nextToken
            }
            finally {
                if (Test-Path $result.OutputPath) { Remove-Item $result.OutputPath -Force }
            }
        } while ($nextToken -and $nextToken -ne $previousToken)
    }

    Complete-JsonLogFile -State $jsonState
    Write-Host "Downloaded $($jsonState.Count) events"
    return $jsonState.Count
}

Test-AwsCliInstalled

$dayRanges = Get-DayEpochRanges -Start $StartDate -End $EndDate

Test-AwsCredentials

New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

$logGroups = @(
    @{ Name = '/ecs/api-ws'; ShortName = 'api-ws'; File = 'api-ws.json' }
    @{ Name = '/ecs/billing-worker'; ShortName = 'billing-worker'; File = 'billing-worker.json' }
)

$counts = @{}

foreach ($group in $logGroups) {
    $outFile = Join-Path $OutputDir $group.File

    $count = Download-CloudWatchLogGroup `
        -LogGroupName $group.Name `
        -DayRanges $dayRanges `
        -OutFile $outFile `
        -StartDate $StartDate `
        -EndDate $EndDate `
        -Region $Region

    Write-Host "Saved $count events to $outFile"
    $counts[$group.ShortName] = $count
    Write-Host ''
}

Write-Host 'Finished.'
Write-Host "api-ws: $($counts['api-ws']) events"
Write-Host "billing-worker: $($counts['billing-worker']) events"
