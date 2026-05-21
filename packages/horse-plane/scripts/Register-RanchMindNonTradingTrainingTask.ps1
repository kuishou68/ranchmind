param(
    [string]$TaskPath = "",
    [string]$TaskName = "",
    [string]$TaskTime = "",
    [switch]$DisableLegacyKdTask,
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

function Resolve-DailyTriggerAt {
    param(
        [string]$TimeText
    )

    try {
        $timeOfDay = [TimeSpan]::Parse($TimeText)
    }
    catch {
        throw "Invalid daily task time: $TimeText"
    }

    return (Get-Date).Date.Add($timeOfDay)
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

function Register-WithPrincipal {
    param(
        [string]$CurrentTaskPath,
        [string]$CurrentTaskName,
        [string]$Execute,
        [string]$Arguments,
        [string]$CurrentTaskTime,
        [string]$LogonType
    )

    $action = New-ScheduledTaskAction -Execute $Execute -Argument $Arguments
    $trigger = New-ScheduledTaskTrigger -Daily -At (Resolve-DailyTriggerAt -TimeText $CurrentTaskTime)
    $principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType $LogonType -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet `
        -StartWhenAvailable `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -ExecutionTimeLimit (New-TimeSpan -Hours 4)

    Register-ScheduledTask `
        -TaskPath $CurrentTaskPath `
        -TaskName $CurrentTaskName `
        -Action $action `
        -Trigger $trigger `
        -Principal $principal `
        -Settings $settings `
        -Description "RanchMind daily non-trading factor training orchestrator." `
        -Force | Out-Null
}

$ranchMindRoot = Get-RanchMindRoot
$config = Load-RanchMindConfig -RootPath $ranchMindRoot -CustomConfigPath $ConfigPath
$resolvedTaskPath = if ($TaskPath) { $TaskPath } else { [string]$config.ranchmind.taskPath }
$resolvedTaskName = if ($TaskName) { $TaskName } else { [string]$config.ranchmind.taskName }
$resolvedTaskTime = if ($TaskTime) { $TaskTime } else { [string]$config.ranchmind.taskTime }

if (-not $resolvedTaskPath.StartsWith("\")) {
    $resolvedTaskPath = "\$resolvedTaskPath"
}
if (-not $resolvedTaskPath.EndsWith("\")) {
    $resolvedTaskPath = "$resolvedTaskPath\"
}

$nodeCommand = (Get-Command node -ErrorAction Stop).Source
$scriptPath = Join-Path (Join-Path $ranchMindRoot "scripts") "ranchmind.mjs"
$arguments = @(
    (Convert-ToProcessArgument -Value $nodeCommand),
    (Convert-ToProcessArgument -Value (Resolve-Path $scriptPath).Path),
    "run-training",
    "--source", "scheduled_task"
) -join " "

$principalLogonType = "S4U"
try {
    Register-WithPrincipal -CurrentTaskPath $resolvedTaskPath -CurrentTaskName $resolvedTaskName -Execute $nodeCommand -Arguments $arguments -CurrentTaskTime $resolvedTaskTime -LogonType "S4U"
}
catch {
    $principalLogonType = "Interactive"
    Register-WithPrincipal -CurrentTaskPath $resolvedTaskPath -CurrentTaskName $resolvedTaskName -Execute $nodeCommand -Arguments $arguments -CurrentTaskTime $resolvedTaskTime -LogonType "Interactive"
}

$legacyTaskDisabled = $false
if ($DisableLegacyKdTask.IsPresent) {
    $legacyTask = Get-ScheduledTask -TaskPath ([string]$config.kd.legacyTaskPath) -TaskName ([string]$config.kd.legacyTaskName) -ErrorAction SilentlyContinue
    if ($legacyTask) {
        Disable-ScheduledTask -InputObject $legacyTask | Out-Null
        $legacyTaskDisabled = $true
    }
}

[ordered]@{
    status = "ok"
    task_path = $resolvedTaskPath
    task_name = $resolvedTaskName
    task_time = $resolvedTaskTime
    task_script = (Resolve-Path $scriptPath).Path
    task_command = $nodeCommand
    principal_logon_type = $principalLogonType
    legacy_task_disabled = $legacyTaskDisabled
    legacy_task_path = [string]$config.kd.legacyTaskPath
    legacy_task_name = [string]$config.kd.legacyTaskName
} | ConvertTo-Json -Depth 10
