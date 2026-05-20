param(
    [datetime]$Date = (Get-Date),
    [string]$InvocationSource = "ranchmind.manual",
    [switch]$Force,
    [string]$ConfigPath = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Get-RanchMindRoot {
    return (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
}

function Convert-ToProcessArgument {
    param(
        [AllowNull()]
        [string]$Value
    )

    if ($null -eq $Value) {
        return '""'
    }

    if ($Value -notmatch '[\s"]') {
        return $Value
    }

    $escaped = $Value -replace '\\(?=\\*")', '$&$&'
    $escaped = $escaped -replace '"', '\"'
    return ('"{0}"' -f $escaped)
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

function Ensure-Directory {
    param(
        [string]$Path
    )

    if (-not (Test-Path -LiteralPath $Path)) {
        New-Item -ItemType Directory -Force -Path $Path | Out-Null
    }
}

function Get-PowerShellExecutable {
    $candidates = @("powershell.exe", "pwsh", "powershell")
    foreach ($candidate in $candidates) {
        $command = Get-Command $candidate -ErrorAction SilentlyContinue
        if ($command) {
            return $command.Source
        }
    }

    throw "No PowerShell executable found on PATH."
}

function Load-RanchMindConfig {
    param(
        [string]$RootPath,
        [string]$CustomConfigPath
    )

    $path = if ($CustomConfigPath) { $CustomConfigPath } else { Join-Path $RootPath "ranchmind.config.json" }
    $resolved = Resolve-Path $path
    return Get-Content -LiteralPath $resolved -Raw -Encoding UTF8 | ConvertFrom-Json
}

function Invoke-KdTraining {
    param(
        [string]$ScriptPath,
        [string]$RepoRoot,
        [datetime]$RunDate,
        [string]$Source,
        [switch]$ForceRun
    )

    $uvCommand = Get-Command uv -ErrorAction SilentlyContinue
    if (-not $uvCommand) {
        throw "uv executable not found on PATH."
    }

    $args = @(
        "-NoProfile",
        "-ExecutionPolicy", "Bypass",
        "-File", $ScriptPath,
        "-RepoRoot", $RepoRoot,
        "-UvExe", $uvCommand.Source,
        "-Date", $RunDate.ToString("yyyy-MM-dd"),
        "-InvocationSource", $Source
    )
    if ($ForceRun.IsPresent) {
        $args += "-Force"
    }

    $shell = Get-PowerShellExecutable
    $raw = & $shell @args 2>&1 | Out-String
    $exitCode = $LASTEXITCODE
    $trimmed = $raw.Trim()
    if (-not $trimmed) {
        throw "KD training script returned no output."
    }

    try {
        $payload = $trimmed | ConvertFrom-Json
    }
    catch {
        throw "KD training script returned non-JSON output: $trimmed"
    }

    return [pscustomobject]@{
        exit_code = $exitCode
        payload = $payload
        raw = $trimmed
    }
}

function Write-JsonFile {
    param(
        [object]$Value,
        [string]$Path
    )

    $parent = Split-Path $Path -Parent
    if ($parent) {
        Ensure-Directory -Path $parent
    }
    $Value | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $Path -Encoding UTF8
}

function Append-JsonLine {
    param(
        [object]$Value,
        [string]$Path
    )

    $parent = Split-Path $Path -Parent
    if ($parent) {
        Ensure-Directory -Path $parent
    }
    Add-Content -LiteralPath $Path -Value ($Value | ConvertTo-Json -Compress)
}

function Build-MarkdownSummary {
    param(
        [object]$Receipt
    )

    $lines = @(
        "# RanchMind Training Summary",
        "",
        ("- status: {0}" -f $Receipt.outcome.status),
        ("- invocation_source: {0}" -f $Receipt.invocation_source),
        ("- requested_date: {0}" -f $Receipt.requested_date),
        ("- target_end_date: {0}" -f $Receipt.outcome.target_end_date),
        ("- generated_at: {0}" -f $Receipt.generated_at)
    )

    $outcomeReasonProperty = $Receipt.outcome.PSObject.Properties["reason"]
    if ($outcomeReasonProperty -and $outcomeReasonProperty.Value) {
        $lines += ("- reason: {0}" -f $outcomeReasonProperty.Value)
    }

    $summaryProperty = $Receipt.outcome.PSObject.Properties["summary"]
    if ($summaryProperty -and $summaryProperty.Value) {
        $summary = $summaryProperty.Value
        $lines += ""
        $lines += "## Metrics"
        $lines += ""
        $lines += ("- best_config: {0}" -f $summary.best_config)
        $lines += ("- best_qimen_mode: {0}" -f $summary.best_qimen_mode)
        $lines += ("- objective_score: {0}" -f $summary.objective_score)
        $lines += ("- validation_calendar_sharpe: {0}" -f $summary.validation_calendar_sharpe)
        $lines += ("- full_calendar_sharpe: {0}" -f $summary.full_calendar_sharpe)
        $lines += ("- full_final_equity: {0}" -f $summary.full_final_equity)
        $lines += ("- full_max_drawdown: {0}" -f $summary.full_max_drawdown)
    }

    $outputJsonProperty = $Receipt.outcome.PSObject.Properties["output_json"]
    $latestJsonProperty = $Receipt.outcome.PSObject.Properties["latest_json"]

    $lines += ""
    $lines += "## Artifacts"
    $lines += ""
    $lines += ("- authoritative_status_json: {0}" -f $Receipt.authoritative_status_json)
    if ($outputJsonProperty -and $outputJsonProperty.Value) {
        $lines += ("- output_json: {0}" -f $outputJsonProperty.Value)
    }
    if ($latestJsonProperty -and $latestJsonProperty.Value) {
        $lines += ("- latest_json: {0}" -f $latestJsonProperty.Value)
    }

    return ($lines -join [Environment]::NewLine)
}

$ranchMindRoot = Get-RanchMindRoot
$config = Load-RanchMindConfig -RootPath $ranchMindRoot -CustomConfigPath $ConfigPath
$kdRepoRoot = Resolve-ConfigValuePath -Value $config.kd.repoRoot -BasePath $ranchMindRoot
$kdTrainingScript = Resolve-ConfigValuePath -Value $config.kd.trainingScript -BasePath $ranchMindRoot
$stateRoot = Join-Path $ranchMindRoot "state"
$receiptsRoot = Join-Path (Join-Path $stateRoot "receipts") "training"
$memoryRoot = Join-Path $stateRoot "memory"
$latestReceiptPath = Join-Path $memoryRoot "training-latest.json"
$latestMarkdownPath = Join-Path $memoryRoot "training-latest.md"
$historyPath = Join-Path $memoryRoot "training-history.jsonl"
$authoritativeStatusJson = Join-Path $kdRepoRoot "tmp_overnight_hold_factor_train_nontrading_latest_status.json"

Ensure-Directory -Path $receiptsRoot
Ensure-Directory -Path $memoryRoot

$kdRun = Invoke-KdTraining -ScriptPath $kdTrainingScript -RepoRoot $kdRepoRoot -RunDate $Date -Source $InvocationSource -ForceRun:$Force
$outcome = $kdRun.payload
$stamp = (Get-Date).ToString("yyyyMMdd-HHmmss")
$receiptPath = Join-Path $receiptsRoot ("ranchmind-training-{0}.json" -f $stamp)
$receipt = [ordered]@{
    generated_at = (Get-Date).ToString("o")
    requested_date = $Date.ToString("yyyy-MM-dd")
    invocation_source = $InvocationSource
    receipt_path = $receiptPath
    authoritative_status_json = $authoritativeStatusJson
    planes = [ordered]@{
        human = [ordered]@{
            latest_json = $latestReceiptPath
            latest_markdown = $latestMarkdownPath
            history_jsonl = $historyPath
        }
        horse = [ordered]@{
            task_path = [string]$config.ranchmind.taskPath
            task_name = [string]$config.ranchmind.taskName
        }
        lobster = [ordered]@{
            kd_repo_root = $kdRepoRoot
            training_script = $kdTrainingScript
            exit_code = $kdRun.exit_code
        }
    }
    outcome = $outcome
}

Write-JsonFile -Value $receipt -Path $receiptPath
Write-JsonFile -Value $receipt -Path $latestReceiptPath
Set-Content -LiteralPath $latestMarkdownPath -Value (Build-MarkdownSummary -Receipt $receipt) -Encoding UTF8
Append-JsonLine -Value $receipt -Path $historyPath

$receipt | ConvertTo-Json -Depth 20
if ($kdRun.exit_code -ne 0) {
    exit $kdRun.exit_code
}
exit 0
