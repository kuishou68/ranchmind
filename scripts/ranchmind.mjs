#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const platform = process.platform;

function parseFlag(flag) {
  const index = process.argv.indexOf(flag);
  if (index === -1) {
    return null;
  }
  return process.argv[index + 1] ?? null;
}

function parseTimeText(timeText) {
  if (!/^\d{2}:\d{2}$/.test(timeText)) {
    throw new Error(`Invalid task time: ${timeText}`);
  }

  const [hourText, minuteText] = timeText.split(":");
  const hour = Number.parseInt(hourText, 10);
  const minute = Number.parseInt(minuteText, 10);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw new Error(`Invalid task time: ${timeText}`);
  }

  return { hour, minute };
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function windowsQuote(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

function nowIso() {
  return new Date().toISOString();
}

function sleepMilliseconds(milliseconds) {
  if (!milliseconds || milliseconds <= 0) {
    return;
  }

  const buffer = new SharedArrayBuffer(4);
  const view = new Int32Array(buffer);
  Atomics.wait(view, 0, 0, milliseconds);
}

function ensureDirectory(directoryPath) {
  fs.mkdirSync(directoryPath, { recursive: true });
}

function runCommand(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd ?? rootDir,
    encoding: "utf8",
    input: options.input,
    env: options.env ?? process.env
  });
}

function readJson(filePath) {
  const raw = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
  return JSON.parse(raw);
}

function writeJsonFile(filePath, value) {
  ensureDirectory(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function appendJsonLine(filePath, value) {
  ensureDirectory(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

function expandEnv(value) {
  if (typeof value !== "string" || !value) {
    return value;
  }

  return value
    .replace(/%([^%]+)%/g, (_, name) => process.env[name] ?? process.env[name.toUpperCase()] ?? process.env[name.toLowerCase()] ?? `%${name}%`)
    .replace(/\$\{([^}]+)\}/g, (_, name) => process.env[name] ?? process.env[name.toUpperCase()] ?? process.env[name.toLowerCase()] ?? `\${${name}}`)
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, name) => process.env[name] ?? process.env[name.toUpperCase()] ?? process.env[name.toLowerCase()] ?? `$${name}`);
}

function renderTemplate(value, context) {
  if (typeof value !== "string") {
    return value;
  }

  return value
    .replace(/\{\{root\}\}/g, context.rootDir)
    .replace(/\{\{home\}\}/g, context.homeDir)
    .replace(/\{\{date\}\}/g, context.dateText ?? "")
    .replace(/\{\{invocationSource\}\}/g, context.invocationSource ?? "")
    .replace(/\{\{platform\}\}/g, context.platform);
}

function resolvePathLike(value, context) {
  if (!value) {
    return "";
  }

  const rendered = expandEnv(renderTemplate(value, context));
  if (path.isAbsolute(rendered)) {
    return path.normalize(rendered);
  }
  return path.resolve(context.rootDir, rendered);
}

function loadConfig() {
  return readJson(path.join(rootDir, "ranchmind.config.json"));
}

function getContext({ dateText = null, invocationSource = null } = {}) {
  return {
    rootDir,
    homeDir: os.homedir(),
    platform,
    dateText,
    invocationSource
  };
}

function getHarnessConfig(config) {
  return {
    maxAttempts: config.harness?.maxAttempts ?? 2,
    retryDelaySeconds: config.harness?.retryDelaySeconds ?? 15,
    runsRetainDays: config.harness?.runsRetainDays ?? 30,
    evaluator: {
      acceptStatuses: config.harness?.evaluator?.acceptStatuses ?? ["ok", "skipped"],
      requiredArtifactsOnOk: config.harness?.evaluator?.requiredArtifactsOnOk ?? ["authoritative_status_json", "output_json", "latest_json"],
      requiredOutcomeFieldsOnOk: config.harness?.evaluator?.requiredOutcomeFieldsOnOk ?? ["target_end_date"],
      metricThresholds: config.harness?.evaluator?.metricThresholds ?? {}
    }
  };
}

function getLegacyWindowsTraining(config) {
  if (!config.kd?.trainingScript || !config.kd?.repoRoot) {
    return null;
  }

  return {
    command: "powershell.exe",
    args: [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      config.kd.trainingScript,
      "-RepoRoot",
      config.kd.repoRoot,
      "-Date",
      "{{date}}",
      "-InvocationSource",
      "{{invocationSource}}"
    ],
    forceArgs: ["-Force"],
    workingDirectory: config.kd.repoRoot,
    authoritativeStatusPath: path.join(config.kd.repoRoot, "tmp_overnight_hold_factor_train_nontrading_latest_status.json")
  };
}

function getTrainingAdapter(config) {
  const platformConfig = config.training?.platforms?.[platform];
  if (platformConfig?.command) {
    return platformConfig;
  }

  if (platform === "win32") {
    const legacy = getLegacyWindowsTraining(config);
    if (legacy) {
      return legacy;
    }
  }

  throw new Error(`No training adapter is configured for platform "${platform}".`);
}

function getSchedulerConfig(config) {
  const platformConfig = config.scheduler?.platforms?.[platform];
  if (platformConfig) {
    return platformConfig;
  }

  if (platform === "win32" && config.ranchmind?.taskName) {
    return {
      kind: "windows-task",
      taskPath: config.ranchmind.taskPath,
      taskName: config.ranchmind.taskName,
      taskTime: config.ranchmind.taskTime
    };
  }

  return null;
}

function getHermesConfig(config) {
  const platformConfig = config.hermes?.platforms?.[platform];
  if (platformConfig) {
    return platformConfig;
  }

  if (platform === "win32" && config.hermes?.gatewayLog) {
    return {
      gatewayLog: config.hermes.gatewayLog,
      taskName: config.hermes.taskName ?? ""
    };
  }

  return null;
}

function buildMarkdownSummary(receipt) {
  const lines = [
    "# RanchMind Training Summary",
    "",
    `- harness_status: ${receipt.harness.lifecycle_status}`,
    `- harness_decision: ${receipt.harness.final_decision}`,
    `- attempts: ${receipt.harness.attempts}/${receipt.harness.max_attempts}`,
    `- run_id: ${receipt.harness.run_id}`,
    `- status: ${receipt.outcome.status}`,
    `- invocation_source: ${receipt.invocation_source}`,
    `- requested_date: ${receipt.requested_date}`,
    `- target_end_date: ${receipt.outcome.target_end_date ?? ""}`,
    `- generated_at: ${receipt.generated_at}`
  ];

  if (receipt.harness.next_action) {
    lines.push(`- next_action: ${receipt.harness.next_action}`);
  }
  if (receipt.outcome.reason) {
    lines.push(`- reason: ${receipt.outcome.reason}`);
  }

  if (receipt.outcome.summary) {
    const summary = receipt.outcome.summary;
    lines.push("", "## Metrics", "");
    lines.push(`- best_config: ${summary.best_config ?? ""}`);
    lines.push(`- best_qimen_mode: ${summary.best_qimen_mode ?? ""}`);
    lines.push(`- objective_score: ${summary.objective_score ?? ""}`);
    lines.push(`- validation_calendar_sharpe: ${summary.validation_calendar_sharpe ?? ""}`);
    lines.push(`- full_calendar_sharpe: ${summary.full_calendar_sharpe ?? ""}`);
    lines.push(`- full_final_equity: ${summary.full_final_equity ?? ""}`);
    lines.push(`- full_max_drawdown: ${summary.full_max_drawdown ?? ""}`);
  }

  lines.push("", "## Harness", "");
  lines.push(`- run_dir: ${receipt.harness.run_dir}`);
  lines.push(`- contract_path: ${receipt.harness.contract_path}`);
  lines.push(`- evaluation_path: ${receipt.harness.evaluation_path}`);
  lines.push(`- run_state_path: ${receipt.harness.run_state_path}`);

  lines.push("", "## Artifacts", "");
  lines.push(`- authoritative_status_json: ${receipt.authoritative_status_json}`);
  if (receipt.outcome.output_json) {
    lines.push(`- output_json: ${receipt.outcome.output_json}`);
  }
  if (receipt.outcome.latest_json) {
    lines.push(`- latest_json: ${receipt.outcome.latest_json}`);
  }

  return `${lines.join("\n")}\n`;
}

function buildSchedulerLine(taskName, logPath) {
  const marker = `# ranchmind:${taskName}`;
  const command = [
    `cd ${shellQuote(rootDir)}`,
    `${shellQuote(process.execPath)} ${shellQuote(path.join(rootDir, "scripts", "ranchmind.mjs"))} run-training --source scheduled_task >> ${shellQuote(logPath)} 2>&1`
  ].join(" && ");

  return { line: command, marker };
}

function readCrontab() {
  const result = runCommand("crontab", ["-l"]);
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const combined = `${stdout}${stderr}`.trim();

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    if (/no crontab/i.test(combined)) {
      return "";
    }
    throw new Error(combined || "Failed to read crontab.");
  }

  return stdout;
}

function writeCrontab(content) {
  const result = runCommand("crontab", ["-"], { input: content });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || "").trim() || "Failed to write crontab.");
  }
}

function getTaskQuery(taskPath, taskName) {
  const normalizedTaskPath = taskPath.startsWith("\\") ? taskPath : `\\${taskPath}`;
  const taskPathWithSlash = normalizedTaskPath.endsWith("\\") ? normalizedTaskPath : `${normalizedTaskPath}\\`;
  const fullName = `${taskPathWithSlash}${taskName}`;
  const result = runCommand("schtasks.exe", ["/Query", "/TN", fullName, "/FO", "LIST", "/V"]);
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();

  return {
    kind: "windows-task",
    full_name: fullName,
    exists: result.status === 0,
    output
  };
}

function ensureWindowsTaskPath(taskPath) {
  const normalized = taskPath.startsWith("\\") ? taskPath : `\\${taskPath}`;
  return normalized.endsWith("\\") ? normalized : `${normalized}\\`;
}

function buildWindowsTaskXml(taskPath, taskName, taskTime) {
  const { hour, minute } = parseTimeText(taskTime);
  const paddedHour = String(hour).padStart(2, "0");
  const paddedMinute = String(minute).padStart(2, "0");
  const now = new Date();
  const startBoundary = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}T${paddedHour}:${paddedMinute}:00`;
  const userId = process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}` : process.env.USERNAME;
  const taskUri = `${ensureWindowsTaskPath(taskPath)}${taskName}`;
  const command = process.execPath;
  const scriptPath = path.join(rootDir, "scripts", "ranchmind.mjs");
  const argumentsText = `${windowsQuote(scriptPath)} run-training --source scheduled_task`;

  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>RanchMind harness-driven non-trading factor training orchestrator.</Description>
    <URI>${escapeXml(taskUri)}</URI>
  </RegistrationInfo>
  <Triggers>
    <CalendarTrigger>
      <StartBoundary>${startBoundary}</StartBoundary>
      <Enabled>true</Enabled>
      <ScheduleByDay>
        <DaysInterval>1</DaysInterval>
      </ScheduleByDay>
    </CalendarTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${escapeXml(userId)}</UserId>
      <LogonType>S4U</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>true</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <DisallowStartOnRemoteAppSession>false</DisallowStartOnRemoteAppSession>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT4H</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${escapeXml(command)}</Command>
      <Arguments>${escapeXml(argumentsText)}</Arguments>
      <WorkingDirectory>${escapeXml(rootDir)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

function getCronQuery(taskName, logPath) {
  const { marker } = buildSchedulerLine(taskName, logPath);

  try {
    const crontab = readCrontab();
    const line = crontab
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .find((entry) => entry.includes(marker)) ?? "";

    return {
      kind: "cron",
      marker,
      exists: Boolean(line),
      line
    };
  }
  catch (error) {
    return {
      kind: "cron",
      marker,
      exists: false,
      error: error.message
    };
  }
}

function summarizeLatestReceipt() {
  const latestReceiptPath = path.join(rootDir, "state", "memory", "training-latest.json");
  if (!fs.existsSync(latestReceiptPath)) {
    return { latestReceiptPath, latestReceipt: null };
  }

  const latestReceipt = readJson(latestReceiptPath);
  const outcomeSummary = latestReceipt.outcome.summary
    ? {
        best_config: latestReceipt.outcome.summary.best_config,
        best_qimen_mode: latestReceipt.outcome.summary.best_qimen_mode,
        objective_score: latestReceipt.outcome.summary.objective_score
      }
    : null;

  return {
    latestReceiptPath,
    latestReceipt,
    latestReceiptSummary: {
      generated_at: latestReceipt.generated_at,
      requested_date: latestReceipt.requested_date,
      invocation_source: latestReceipt.invocation_source,
      outcome_status: latestReceipt.outcome.status,
      outcome_reason: latestReceipt.outcome.reason ?? "",
      outcome_target_end_date: latestReceipt.outcome.target_end_date ?? "",
      outcome_summary: outcomeSummary,
      harness: latestReceipt.harness
        ? {
            run_id: latestReceipt.harness.run_id,
            lifecycle_status: latestReceipt.harness.lifecycle_status,
            final_decision: latestReceipt.harness.final_decision,
            attempts: latestReceipt.harness.attempts,
            next_action: latestReceipt.harness.next_action
          }
        : null
    }
  };
}

function commandOrThrow(result, failureMessage) {
  if (result.error) {
    throw result.error;
  }
  if (typeof result.status === "number" && result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    throw new Error(detail ? `${failureMessage}: ${detail}` : failureMessage);
  }
}

function makeRunId() {
  const stamp = nowIso().replace(/[-:]/g, "").replace(/\./g, "").replace("T", "-").replace("Z", "");
  return `training-${stamp}`;
}

function getMetricValue(outcome, metricPath) {
  return metricPath.split(".").reduce((current, key) => (current && typeof current === "object" ? current[key] : undefined), outcome);
}

function trimOldRunDirectories(runsRoot, retainDays) {
  if (!fs.existsSync(runsRoot)) {
    return;
  }

  const cutoff = Date.now() - (retainDays * 24 * 60 * 60 * 1000);
  for (const entry of fs.readdirSync(runsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }

    const fullPath = path.join(runsRoot, entry.name);
    const stats = fs.statSync(fullPath);
    if (stats.mtimeMs < cutoff) {
      fs.rmSync(fullPath, { recursive: true, force: true });
    }
  }
}

function buildTrainingInvocation(config, dateText, invocationSource, forceRun) {
  const context = getContext({ dateText, invocationSource });
  const adapter = getTrainingAdapter(config);
  const command = renderTemplate(adapter.command, context);
  const args = [...(adapter.args ?? [])].map((value) => renderTemplate(value, context));
  if (forceRun && Array.isArray(adapter.forceArgs)) {
    args.push(...adapter.forceArgs.map((value) => renderTemplate(value, context)));
  }

  return {
    adapter,
    command,
    args,
    workingDirectory: adapter.workingDirectory ? resolvePathLike(adapter.workingDirectory, context) : rootDir,
    authoritativeStatusJson: adapter.authoritativeStatusPath ? resolvePathLike(adapter.authoritativeStatusPath, context) : ""
  };
}

function buildRunArtifacts(runId) {
  const stateRoot = path.join(rootDir, "state");
  const runsRoot = path.join(stateRoot, "runs");
  const runDir = path.join(runsRoot, runId);
  const attemptsDir = path.join(runDir, "attempts");
  const receiptsRoot = path.join(stateRoot, "receipts", "training");
  const memoryRoot = path.join(stateRoot, "memory");

  return {
    stateRoot,
    runsRoot,
    runDir,
    attemptsDir,
    receiptsRoot,
    memoryRoot,
    contractPath: path.join(runDir, "contract.json"),
    runStatePath: path.join(runDir, "run-state.json"),
    evaluationPath: path.join(runDir, "evaluation.json"),
    finalReceiptPath: path.join(runDir, "final-receipt.json"),
    latestReceiptPath: path.join(memoryRoot, "training-latest.json"),
    latestMarkdownPath: path.join(memoryRoot, "training-latest.md"),
    latestRunPath: path.join(memoryRoot, "training-latest-run.json"),
    historyPath: path.join(memoryRoot, "training-history.jsonl")
  };
}

function createRunContract(config, harnessConfig, dateText, invocationSource, requestedForce, invocation) {
  const schedulerConfig = getSchedulerConfig(config);

  return {
    run_type: "training",
    created_at: nowIso(),
    planner: {
      style: "structured-contract",
      summary: "Execute the configured training adapter, then evaluate status and artifact completeness before accepting the run."
    },
    request: {
      requested_date: dateText,
      invocation_source: invocationSource,
      force_requested: requestedForce
    },
    retry_policy: {
      max_attempts: harnessConfig.maxAttempts,
      retry_delay_seconds: harnessConfig.retryDelaySeconds,
      retryable_failures: [
        "process_error",
        "non_json_output",
        "empty_output",
        "non_zero_exit",
        "missing_artifact"
      ],
      retry_behavior: "Only execution failures retry automatically. Metric or policy failures block for operator review.",
      retry_force_behavior: "Retry attempts use force=true to recover from partial prior outputs."
    },
    evaluator: {
      accept_statuses: harnessConfig.evaluator.acceptStatuses,
      required_artifacts_on_ok: harnessConfig.evaluator.requiredArtifactsOnOk,
      required_outcome_fields_on_ok: harnessConfig.evaluator.requiredOutcomeFieldsOnOk,
      metric_thresholds: harnessConfig.evaluator.metricThresholds
    },
    execution: {
      platform,
      command: invocation.command,
      args: invocation.args,
      working_directory: invocation.workingDirectory,
      authoritative_status_json: invocation.authoritativeStatusJson
    },
    scheduler: schedulerConfig
      ? {
          kind: schedulerConfig.kind,
          task_path: schedulerConfig.taskPath ?? "",
          task_name: schedulerConfig.taskName ?? "",
          task_time: schedulerConfig.taskTime ?? ""
        }
      : {
          kind: "none",
          task_path: "",
          task_name: "",
          task_time: ""
        }
  };
}

function writeRunState(paths, previousState, patch) {
  const nextState = {
    ...(previousState ?? {}),
    ...patch,
    updated_at: nowIso()
  };
  writeJsonFile(paths.runStatePath, nextState);
  return nextState;
}

function executeTrainingAttempt(config, runContext, attemptNumber, forceRun) {
  const invocation = buildTrainingInvocation(config, runContext.dateText, runContext.invocationSource, forceRun);
  const startedAt = nowIso();
  const result = runCommand(invocation.command, invocation.args, { cwd: invocation.workingDirectory });
  const finishedAt = nowIso();
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const combined = `${stdout}${stderr}`.trim();

  const record = {
    attempt: attemptNumber,
    started_at: startedAt,
    finished_at: finishedAt,
    force: forceRun,
    platform,
    command: invocation.command,
    args: invocation.args,
    working_directory: invocation.workingDirectory,
    authoritative_status_json: invocation.authoritativeStatusJson,
    exit_code: result.status ?? 1,
    stdout,
    stderr,
    raw_output: stdout.trim() || combined
  };

  if (result.error) {
    record.process_error = result.error.message;
    return record;
  }

  if (!record.raw_output) {
    record.parse_error = "Training adapter returned no output.";
    return record;
  }

  try {
    record.outcome = JSON.parse(record.raw_output);
  }
  catch {
    record.parse_error = `Training adapter returned non-JSON output: ${record.raw_output}`;
  }

  return record;
}

function evaluateAttempt(harnessConfig, attemptRecord) {
  const checks = [];

  if (attemptRecord.process_error) {
    return {
      decision: "retry",
      lifecycle_status: "retrying",
      reason: "process_error",
      next_action: "Retry automatically because the adapter process failed to launch or complete cleanly.",
      checks: [{ name: "process_error", status: "fail", message: attemptRecord.process_error }]
    };
  }

  if (attemptRecord.parse_error) {
    return {
      decision: "retry",
      lifecycle_status: "retrying",
      reason: "non_json_output",
      next_action: "Retry automatically because the adapter output was empty or malformed.",
      checks: [{ name: "parse_output", status: "fail", message: attemptRecord.parse_error }]
    };
  }

  if ((attemptRecord.exit_code ?? 1) !== 0) {
    return {
      decision: "retry",
      lifecycle_status: "retrying",
      reason: "non_zero_exit",
      next_action: "Retry automatically because the adapter exited non-zero.",
      checks: [{ name: "exit_code", status: "fail", message: `Exit code was ${attemptRecord.exit_code}.` }]
    };
  }

  const outcome = attemptRecord.outcome ?? {};
  const status = outcome.status ?? "";
  checks.push({
    name: "status",
    status: harnessConfig.evaluator.acceptStatuses.includes(status) ? "pass" : "fail",
    message: `Adapter reported status "${status}".`
  });

  if (!harnessConfig.evaluator.acceptStatuses.includes(status)) {
    return {
      decision: "blocked",
      lifecycle_status: "blocked",
      reason: "unexpected_status",
      next_action: "Review the adapter outcome manually before re-running.",
      checks
    };
  }

  if (status === "skipped") {
    return {
      decision: "pass",
      lifecycle_status: "completed",
      reason: outcome.reason ?? "skip_accepted",
      next_action: "No retry required; the lane ran and decided no work was needed.",
      checks
    };
  }

  for (const fieldName of harnessConfig.evaluator.requiredOutcomeFieldsOnOk) {
    const present = outcome[fieldName] !== undefined && outcome[fieldName] !== null && String(outcome[fieldName]) !== "";
    checks.push({
      name: `outcome_field:${fieldName}`,
      status: present ? "pass" : "fail",
      message: present ? `Outcome field "${fieldName}" is present.` : `Outcome field "${fieldName}" is missing.`
    });
    if (!present) {
      return {
        decision: "blocked",
        lifecycle_status: "blocked",
        reason: "missing_outcome_field",
        next_action: "Review the adapter output schema before re-running.",
        checks
      };
    }
  }

  for (const artifactName of harnessConfig.evaluator.requiredArtifactsOnOk) {
    const artifactPath = artifactName === "authoritative_status_json"
      ? attemptRecord.authoritative_status_json
      : outcome[artifactName];
    const exists = Boolean(artifactPath) && fs.existsSync(artifactPath);
    checks.push({
      name: `artifact:${artifactName}`,
      status: exists ? "pass" : "fail",
      message: exists ? artifactPath : `Required artifact "${artifactName}" is missing or unreadable.`
    });
    if (!exists) {
      return {
        decision: "retry",
        lifecycle_status: "retrying",
        reason: "missing_artifact",
        next_action: "Retry automatically because execution completed but required artifacts were missing.",
        checks
      };
    }
  }

  for (const [metricPath, threshold] of Object.entries(harnessConfig.evaluator.metricThresholds)) {
    const value = getMetricValue(outcome, metricPath);
    if (threshold.min !== undefined) {
      const pass = typeof value === "number" && value >= threshold.min;
      checks.push({
        name: `metric:${metricPath}:min`,
        status: pass ? "pass" : "fail",
        message: pass
          ? `${metricPath}=${value} meets minimum ${threshold.min}.`
          : `${metricPath}=${value ?? "missing"} is below minimum ${threshold.min}.`
      });
      if (!pass) {
        return {
          decision: "blocked",
          lifecycle_status: "blocked",
          reason: "metric_below_threshold",
          next_action: "Review the quality gate manually; RanchMind does not auto-retry metric failures.",
          checks
        };
      }
    }

    if (threshold.max !== undefined) {
      const pass = typeof value === "number" && value <= threshold.max;
      checks.push({
        name: `metric:${metricPath}:max`,
        status: pass ? "pass" : "fail",
        message: pass
          ? `${metricPath}=${value} is within maximum ${threshold.max}.`
          : `${metricPath}=${value ?? "missing"} exceeds maximum ${threshold.max}.`
      });
      if (!pass) {
        return {
          decision: "blocked",
          lifecycle_status: "blocked",
          reason: "metric_above_threshold",
          next_action: "Review the quality gate manually; RanchMind does not auto-retry metric failures.",
          checks
        };
      }
    }
  }

  return {
    decision: "pass",
    lifecycle_status: "completed",
    reason: "accepted",
    next_action: "No retry required; the run met the harness contract.",
    checks
  };
}

function finalizeRetryExhausted(finalEvaluation, maxAttempts) {
  return {
    ...finalEvaluation,
    decision: "failed",
    lifecycle_status: "failed",
    reason: `${finalEvaluation.reason}_exhausted`,
    next_action: `Automatic retries exhausted after ${maxAttempts} attempts. Operator review required.`
  };
}

function buildLegacyReceipt(config, paths, contract, runState, finalAttempt, finalEvaluation) {
  const schedulerConfig = getSchedulerConfig(config);
  const legacyReceiptPath = path.join(paths.receiptsRoot, `${runState.run_id}.json`);

  return {
    generated_at: nowIso(),
    requested_date: contract.request.requested_date,
    invocation_source: contract.request.invocation_source,
    receipt_path: legacyReceiptPath,
    authoritative_status_json: finalAttempt.authoritative_status_json,
    harness: {
      run_id: runState.run_id,
      run_dir: paths.runDir,
      contract_path: paths.contractPath,
      run_state_path: paths.runStatePath,
      evaluation_path: paths.evaluationPath,
      lifecycle_status: finalEvaluation.lifecycle_status,
      final_decision: finalEvaluation.decision,
      final_reason: finalEvaluation.reason,
      attempts: runState.attempts.length,
      max_attempts: contract.retry_policy.max_attempts,
      retry_delay_seconds: contract.retry_policy.retry_delay_seconds,
      next_action: finalEvaluation.next_action
    },
    planes: {
      human: {
        latest_json: paths.latestReceiptPath,
        latest_markdown: paths.latestMarkdownPath,
        latest_run_json: paths.latestRunPath,
        history_jsonl: paths.historyPath
      },
      horse: schedulerConfig
        ? {
            kind: schedulerConfig.kind,
            task_path: schedulerConfig.taskPath ?? "",
            task_name: schedulerConfig.taskName ?? ""
          }
        : {
            kind: "none",
            task_path: "",
            task_name: ""
          },
      lobster: {
        platform,
        command: finalAttempt.command,
        args: finalAttempt.args,
        working_directory: finalAttempt.working_directory,
        exit_code: finalAttempt.exit_code
      }
    },
    outcome: finalAttempt.outcome ?? {
      status: "error",
      reason: finalEvaluation.reason,
      message: finalAttempt.process_error ?? finalAttempt.parse_error ?? "Execution failed before a valid outcome was produced."
    }
  };
}

function runTrainingHarness() {
  const config = loadConfig();
  const harnessConfig = getHarnessConfig(config);
  const dateText = parseFlag("--date") ?? new Date().toISOString().slice(0, 10);
  const invocationSource = parseFlag("--source") ?? "ranchmind.manual";
  const forceRequested = process.argv.includes("--force");
  const runId = makeRunId();
  const paths = buildRunArtifacts(runId);

  ensureDirectory(paths.attemptsDir);
  ensureDirectory(paths.receiptsRoot);
  ensureDirectory(paths.memoryRoot);
  trimOldRunDirectories(paths.runsRoot, harnessConfig.runsRetainDays);

  const initialInvocation = buildTrainingInvocation(config, dateText, invocationSource, forceRequested);
  const contract = createRunContract(config, harnessConfig, dateText, invocationSource, forceRequested, initialInvocation);
  writeJsonFile(paths.contractPath, contract);

  let runState = writeRunState(paths, null, {
    run_id: runId,
    lane: "training",
    status: "running",
    phase: "planning",
    started_at: nowIso(),
    contract_path: paths.contractPath,
    attempts: [],
    next_action: "Execute attempt 1."
  });

  const evaluationHistory = [];
  let finalAttempt = null;
  let finalEvaluation = null;

  for (let attemptNumber = 1; attemptNumber <= harnessConfig.maxAttempts; attemptNumber += 1) {
    const forceRun = forceRequested || attemptNumber > 1;
    runState = writeRunState(paths, runState, {
      phase: "executing",
      next_action: `Run training attempt ${attemptNumber}.`
    });

    const attemptRecord = executeTrainingAttempt(config, { dateText, invocationSource }, attemptNumber, forceRun);
    attemptRecord.attempt_path = path.join(paths.attemptsDir, `attempt-${String(attemptNumber).padStart(2, "0")}.json`);
    writeJsonFile(attemptRecord.attempt_path, attemptRecord);

    runState = writeRunState(paths, runState, {
      phase: "evaluating",
      attempts: [
        ...runState.attempts,
        {
          attempt: attemptNumber,
          attempt_path: attemptRecord.attempt_path,
          force: forceRun,
          exit_code: attemptRecord.exit_code,
          finished_at: attemptRecord.finished_at
        }
      ],
      next_action: `Evaluate attempt ${attemptNumber}.`
    });

    let evaluation = evaluateAttempt(harnessConfig, attemptRecord);
    evaluation = {
      ...evaluation,
      attempt: attemptNumber,
      evaluated_at: nowIso()
    };
    evaluationHistory.push(evaluation);
    finalAttempt = attemptRecord;
    finalEvaluation = evaluation;

    if (evaluation.decision === "pass") {
      break;
    }

    if (evaluation.decision === "retry" && attemptNumber < harnessConfig.maxAttempts) {
      runState = writeRunState(paths, runState, {
        status: "running",
        phase: "waiting_to_retry",
        next_action: `Retry after ${harnessConfig.retryDelaySeconds} seconds because ${evaluation.reason}.`
      });
      sleepMilliseconds(harnessConfig.retryDelaySeconds * 1000);
      continue;
    }

    if (evaluation.decision === "retry") {
      finalEvaluation = finalizeRetryExhausted(evaluation, harnessConfig.maxAttempts);
    }
    break;
  }

  const lifecycleStatus = finalEvaluation.lifecycle_status;
  runState = writeRunState(paths, runState, {
    status: lifecycleStatus,
    phase: "completed",
    completed_at: nowIso(),
    next_action: finalEvaluation.next_action,
    final_decision: finalEvaluation.decision,
    final_reason: finalEvaluation.reason
  });

  const evaluationPayload = {
    run_id: runId,
    evaluated_at: nowIso(),
    final_decision: finalEvaluation.decision,
    lifecycle_status: finalEvaluation.lifecycle_status,
    final_reason: finalEvaluation.reason,
    next_action: finalEvaluation.next_action,
    attempts: evaluationHistory
  };
  writeJsonFile(paths.evaluationPath, evaluationPayload);

  const legacyReceipt = buildLegacyReceipt(config, paths, contract, runState, finalAttempt, finalEvaluation);
  writeJsonFile(paths.finalReceiptPath, legacyReceipt);
  writeJsonFile(legacyReceipt.receipt_path, legacyReceipt);
  writeJsonFile(paths.latestReceiptPath, legacyReceipt);
  writeJsonFile(paths.latestRunPath, {
    run_id: runId,
    run_dir: paths.runDir,
    run_state_path: paths.runStatePath,
    evaluation_path: paths.evaluationPath,
    final_receipt_path: paths.finalReceiptPath,
    lifecycle_status: finalEvaluation.lifecycle_status,
    final_decision: finalEvaluation.decision,
    updated_at: nowIso()
  });
  fs.writeFileSync(paths.latestMarkdownPath, buildMarkdownSummary(legacyReceipt), "utf8");
  appendJsonLine(paths.historyPath, legacyReceipt);

  process.stdout.write(`${JSON.stringify(legacyReceipt, null, 2)}\n`);
  if (finalEvaluation.decision === "pass") {
    return 0;
  }
  return 1;
}

function registerWindowsTask(config, taskTime, disableLegacy) {
  const schedulerConfig = getSchedulerConfig(config);
  const effectiveTaskTime = taskTime ?? schedulerConfig?.taskTime ?? "10:20";
  const taskPath = schedulerConfig?.taskPath ?? "\\RanchMind\\";
  const taskName = schedulerConfig?.taskName ?? "RanchMindNonTradingFactorTrainingDaily";
  const fullName = `${ensureWindowsTaskPath(taskPath)}${taskName}`;
  const xmlPath = path.join(rootDir, "state", "tmp", "ranchmind-scheduled-task.xml");
  ensureDirectory(path.dirname(xmlPath));
  fs.writeFileSync(xmlPath, `\uFEFF${buildWindowsTaskXml(taskPath, taskName, effectiveTaskTime)}`, "utf16le");

  const createResult = runCommand("schtasks.exe", ["/Create", "/TN", fullName, "/XML", xmlPath, "/F"]);
  fs.rmSync(xmlPath, { force: true });
  commandOrThrow(createResult, "Failed to create Windows Scheduled Task");

  let legacyTaskDisabled = false;
  if (disableLegacy && config.kd?.legacyTaskName) {
    const legacyTaskPath = ensureWindowsTaskPath(config.kd.legacyTaskPath ?? "\\KD\\");
    const legacyFullName = `${legacyTaskPath}${config.kd.legacyTaskName}`;
    const disableResult = runCommand("schtasks.exe", ["/Change", "/TN", legacyFullName, "/Disable"]);
    if (!disableResult.error && disableResult.status === 0) {
      legacyTaskDisabled = true;
    }
  }

  const query = getTaskQuery(taskPath, taskName);
  process.stdout.write(`${JSON.stringify({
    status: "ok",
    kind: "windows-task",
    task_path: ensureWindowsTaskPath(taskPath),
    task_name: taskName,
    task_time: effectiveTaskTime,
    principal_logon_type: "S4U",
    entrypoint: {
      command: process.execPath,
      script: path.join(rootDir, "scripts", "ranchmind.mjs"),
      args: ["run-training", "--source", "scheduled_task"]
    },
    legacy_task_disabled: legacyTaskDisabled,
    query
  }, null, 2)}\n`);
}

function registerCronScheduler(config, taskTime) {
  const schedulerConfig = getSchedulerConfig(config);
  const effectiveTaskTime = taskTime ?? schedulerConfig?.taskTime ?? "10:20";
  const { hour, minute } = parseTimeText(effectiveTaskTime);
  const trainingAdapter = getTrainingAdapter(config);
  if (!trainingAdapter?.command) {
    throw new Error(`Cannot register scheduler because no training adapter is configured for "${platform}".`);
  }

  const taskName = schedulerConfig?.taskName ?? "RanchMindNonTradingFactorTrainingDaily";
  const logRoot = path.join(rootDir, "state", "logs");
  const logPath = path.join(logRoot, "ranchmind-scheduler.log");
  ensureDirectory(logRoot);

  const { line, marker } = buildSchedulerLine(taskName, logPath);
  const cronEntry = `${minute} ${hour} * * * ${line} ${marker}`;
  const existing = readCrontab();
  const updatedLines = existing
    .split(/\r?\n/)
    .filter((entry) => entry.trim() && !entry.includes(marker));
  updatedLines.push(cronEntry);
  const finalCrontab = `${updatedLines.join("\n")}\n`;
  writeCrontab(finalCrontab);

  process.stdout.write(`${JSON.stringify({
    status: "ok",
    kind: "cron",
    task_name: taskName,
    task_time: effectiveTaskTime,
    cron_entry: cronEntry,
    scheduler_log: logPath,
    note: "POSIX scheduling currently uses cron. If the machine is asleep or off at run time, the missed run will not be replayed automatically."
  }, null, 2)}\n`);
}

function registerTraining() {
  const config = loadConfig();
  const taskTime = parseFlag("--task-time");
  const disableLegacy = process.argv.includes("--disable-legacy");
  const schedulerConfig = getSchedulerConfig(config);

  if (!schedulerConfig) {
    throw new Error(`No scheduler is configured for platform "${platform}".`);
  }

  if (schedulerConfig.kind === "windows-task") {
    registerWindowsTask(config, taskTime, disableLegacy);
    return 0;
  }

  if (schedulerConfig.kind === "cron") {
    registerCronScheduler(config, taskTime);
    return 0;
  }

  throw new Error(`Unsupported scheduler kind "${schedulerConfig.kind}".`);
}

function status() {
  const config = loadConfig();
  const summary = summarizeLatestReceipt();
  const latestMarkdownPath = path.join(rootDir, "state", "memory", "training-latest.md");
  const latestRunPath = path.join(rootDir, "state", "memory", "training-latest-run.json");
  const latestRun = fs.existsSync(latestRunPath) ? readJson(latestRunPath) : null;
  const hermesConfig = getHermesConfig(config);
  const hermesLogPath = hermesConfig?.gatewayLog ? resolvePathLike(hermesConfig.gatewayLog, getContext()) : "";
  let hermesLogTail = [];
  if (hermesLogPath && fs.existsSync(hermesLogPath)) {
    hermesLogTail = fs.readFileSync(hermesLogPath, "utf8").trim().split(/\r?\n/).slice(-5);
  }

  const schedulerConfig = getSchedulerConfig(config);
  let schedulerStatus = { kind: "none", exists: false };
  if (schedulerConfig?.kind === "windows-task") {
    schedulerStatus = getTaskQuery(schedulerConfig.taskPath, schedulerConfig.taskName);
  }
  else if (schedulerConfig?.kind === "cron") {
    const logPath = path.join(rootDir, "state", "logs", "ranchmind-scheduler.log");
    schedulerStatus = getCronQuery(schedulerConfig.taskName ?? "RanchMindNonTradingFactorTrainingDaily", logPath);
  }

  process.stdout.write(`${JSON.stringify({
    ranchmind_root: rootDir,
    platform,
    latest_receipt_path: summary.latestReceiptPath,
    latest_markdown_path: latestMarkdownPath,
    latest_run_path: latestRunPath,
    latest_receipt: summary.latestReceiptSummary ?? null,
    latest_harness_run: latestRun,
    scheduler: schedulerStatus,
    hermes: {
      task_name: hermesConfig?.taskName ?? "",
      gateway_log: hermesLogPath,
      gateway_log_tail: hermesLogTail
    }
  }, null, 2)}\n`);
  return 0;
}

function help() {
  console.log("RanchMind commands:");
  console.log("  node ./scripts/ranchmind.mjs run-training [--date YYYY-MM-DD] [--force] [--source TEXT]");
  console.log("  node ./scripts/ranchmind.mjs register-training [--task-time HH:mm] [--disable-legacy]");
  console.log("  node ./scripts/ranchmind.mjs status");
}

function main() {
  const command = process.argv[2];

  if (!command || command === "help" || command === "--help" || command === "-h") {
    help();
    return 0;
  }

  if (command === "run-training") {
    return runTrainingHarness();
  }

  if (command === "register-training") {
    return registerTraining();
  }

  if (command === "status") {
    return status();
  }

  console.error(`Unknown RanchMind command: ${command}`);
  return 1;
}

try {
  process.exit(main());
}
catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
