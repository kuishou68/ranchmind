param(
    [string]$ConfigPath = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Get-RanchMindRoot {
    return (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
}

function Resolve-ConfigValuePath {
    param(
        [string]$Value,
        [string]$BasePath
    )

    $expanded = [Environment]::ExpandEnvironmentVariables($Value)
    if ($expanded -match '^[A-Za-z]:\\' -or $expanded -match '^\\\\') {
        return $expanded
    }

    return (Resolve-Path (Join-Path $BasePath $expanded)).Path
}

function Load-RanchMindConfig {
    param(
        [string]$RootPath,
        [string]$CustomConfigPath
    )

    $path = if ($CustomConfigPath) { $CustomConfigPath } else { Join-Path $RootPath "ranchmind.config.json" }
    return Get-Content -LiteralPath (Resolve-Path $path) -Raw -Encoding UTF8 | ConvertFrom-Json
}

function Get-TaskQuery {
    param(
        [string]$TaskPath,
        [string]$TaskName
    )

    $fullName = "{0}{1}" -f $TaskPath, $TaskName
    $raw = & schtasks.exe /Query /TN $fullName /FO LIST /V 2>&1 | Out-String
    $exitCode = $LASTEXITCODE
    $trimmed = $raw.Trim()

    return [ordered]@{
        full_name = $fullName
        exists = ($exitCode -eq 0)
        output = $trimmed
    }
}

$ranchMindRoot = Get-RanchMindRoot
$config = Load-RanchMindConfig -RootPath $ranchMindRoot -CustomConfigPath $ConfigPath
$latestReceiptPath = Join-Path $ranchMindRoot "state\memory\training-latest.json"
$latestMarkdownPath = Join-Path $ranchMindRoot "state\memory\training-latest.md"
$hermesLogPath = Resolve-ConfigValuePath -Value $config.hermes.gatewayLog -BasePath $ranchMindRoot

$latestReceiptSummary = $null
if (Test-Path -LiteralPath $latestReceiptPath) {
    $latestReceipt = Get-Content -LiteralPath $latestReceiptPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $reasonProperty = $latestReceipt.outcome.PSObject.Properties["reason"]
    $summaryProperty = $latestReceipt.outcome.PSObject.Properties["summary"]
    $outcomeSummary = $null
    if ($summaryProperty -and $summaryProperty.Value) {
        $outcomeSummary = [ordered]@{
            best_config = $summaryProperty.Value.best_config
            best_qimen_mode = $summaryProperty.Value.best_qimen_mode
            objective_score = $summaryProperty.Value.objective_score
        }
    }

    $latestReceiptSummary = [ordered]@{
        generated_at = $latestReceipt.generated_at
        requested_date = $latestReceipt.requested_date
        invocation_source = $latestReceipt.invocation_source
        outcome_status = $latestReceipt.outcome.status
        outcome_reason = if ($reasonProperty) { $reasonProperty.Value } else { "" }
        outcome_target_end_date = $latestReceipt.outcome.target_end_date
        outcome_summary = $outcomeSummary
    }
}

$hermesLogTail = @()
if (Test-Path -LiteralPath $hermesLogPath) {
    $hermesLogTail = Get-Content -LiteralPath $hermesLogPath -Tail 5
}

[ordered]@{
    ranchmind_root = $ranchMindRoot
    latest_receipt_path = $latestReceiptPath
    latest_markdown_path = $latestMarkdownPath
    latest_receipt = $latestReceiptSummary
    ranchmind_task = Get-TaskQuery -TaskPath ([string]$config.ranchmind.taskPath) -TaskName ([string]$config.ranchmind.taskName)
    legacy_kd_task = Get-TaskQuery -TaskPath ([string]$config.kd.legacyTaskPath) -TaskName ([string]$config.kd.legacyTaskName)
    hermes = [ordered]@{
        task_name = [string]$config.hermes.taskName
        gateway_log = $hermesLogPath
        gateway_log_tail = $hermesLogTail
    }
} | ConvertTo-Json -Depth 20
