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
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function appendJsonLine(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
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
    `- status: ${receipt.outcome.status}`,
    `- invocation_source: ${receipt.invocation_source}`,
    `- requested_date: ${receipt.requested_date}`,
    `- target_end_date: ${receipt.outcome.target_end_date ?? ""}`,
    `- generated_at: ${receipt.generated_at}`
  ];

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
  const scriptPath = path.join(rootDir, "packages", "horse-plane", "scripts", "Invoke-RanchMindNonTradingTraining.ps1");
  const argumentsText = `-NoProfile -ExecutionPolicy Bypass -File "${scriptPath}" -InvocationSource scheduled_task`;
  const taskUri = `${ensureWindowsTaskPath(taskPath)}${taskName}`;

  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>RanchMind daily non-trading factor training orchestrator.</Description>
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
      <Command>powershell.exe</Command>
      <Arguments>${escapeXml(argumentsText)}</Arguments>
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
    latestReceipt: {
      generated_at: latestReceipt.generated_at,
      requested_date: latestReceipt.requested_date,
      invocation_source: latestReceipt.invocation_source,
      outcome_status: latestReceipt.outcome.status,
      outcome_reason: latestReceipt.outcome.reason ?? "",
      outcome_target_end_date: latestReceipt.outcome.target_end_date ?? "",
      outcome_summary: outcomeSummary
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

function runTraining() {
  const config = loadConfig();
  const dateText = parseFlag("--date") ?? new Date().toISOString().slice(0, 10);
  const invocationSource = parseFlag("--source") ?? "ranchmind.manual";
  const force = process.argv.includes("--force");
  const context = getContext({ dateText, invocationSource });
  const adapter = getTrainingAdapter(config);
  const command = renderTemplate(adapter.command, context);
  const args = [...(adapter.args ?? [])].map((value) => renderTemplate(value, context));
  if (force && Array.isArray(adapter.forceArgs)) {
    args.push(...adapter.forceArgs.map((value) => renderTemplate(value, context)));
  }

  const workingDirectory = adapter.workingDirectory ? resolvePathLike(adapter.workingDirectory, context) : rootDir;
  const authoritativeStatusJson = adapter.authoritativeStatusPath
    ? resolvePathLike(adapter.authoritativeStatusPath, context)
    : "";

  const result = runCommand(command, args, { cwd: workingDirectory });
  if (result.error) {
    throw result.error;
  }

  const rawOutput = `${result.stdout ?? ""}`.trim() || `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  if (!rawOutput) {
    throw new Error("Training adapter returned no output.");
  }

  let outcome;
  try {
    outcome = JSON.parse(rawOutput);
  }
  catch {
    throw new Error(`Training adapter returned non-JSON output: ${rawOutput}`);
  }

  const stateRoot = path.join(rootDir, "state");
  const receiptsRoot = path.join(stateRoot, "receipts", "training");
  const memoryRoot = path.join(stateRoot, "memory");
  fs.mkdirSync(receiptsRoot, { recursive: true });
  fs.mkdirSync(memoryRoot, { recursive: true });

  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
  const receiptPath = path.join(receiptsRoot, `ranchmind-training-${stamp}.json`);
  const latestReceiptPath = path.join(memoryRoot, "training-latest.json");
  const latestMarkdownPath = path.join(memoryRoot, "training-latest.md");
  const historyPath = path.join(memoryRoot, "training-history.jsonl");
  const schedulerConfig = getSchedulerConfig(config);

  const receipt = {
    generated_at: new Date().toISOString(),
    requested_date: dateText,
    invocation_source: invocationSource,
    receipt_path: receiptPath,
    authoritative_status_json: authoritativeStatusJson,
    planes: {
      human: {
        latest_json: latestReceiptPath,
        latest_markdown: latestMarkdownPath,
        history_jsonl: historyPath
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
        command,
        args,
        working_directory: workingDirectory,
        exit_code: result.status ?? 1
      }
    },
    outcome
  };

  writeJsonFile(receiptPath, receipt);
  writeJsonFile(latestReceiptPath, receipt);
  fs.writeFileSync(latestMarkdownPath, buildMarkdownSummary(receipt), "utf8");
  appendJsonLine(historyPath, receipt);

  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  process.exit(result.status ?? 1);
}

function registerWindowsTask(config, taskTime, disableLegacy) {
  const schedulerConfig = getSchedulerConfig(config);
  const effectiveTaskTime = taskTime ?? schedulerConfig?.taskTime ?? "10:20";
  const taskPath = schedulerConfig?.taskPath ?? "\\RanchMind\\";
  const taskName = schedulerConfig?.taskName ?? "RanchMindNonTradingFactorTrainingDaily";
  const fullName = `${ensureWindowsTaskPath(taskPath)}${taskName}`;
  const xmlPath = path.join(rootDir, "state", "tmp", "ranchmind-scheduled-task.xml");
  fs.mkdirSync(path.dirname(xmlPath), { recursive: true });
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
  fs.mkdirSync(logRoot, { recursive: true });

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
    process.exit(0);
    return;
  }

  if (schedulerConfig.kind === "cron") {
    registerCronScheduler(config, taskTime);
    process.exit(0);
  }

  throw new Error(`Unsupported scheduler kind "${schedulerConfig.kind}".`);
}

function status() {
  const config = loadConfig();
  const summary = summarizeLatestReceipt();
  const latestMarkdownPath = path.join(rootDir, "state", "memory", "training-latest.md");
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
    latest_receipt: summary.latestReceipt,
    scheduler: schedulerStatus,
    hermes: {
      task_name: hermesConfig?.taskName ?? "",
      gateway_log: hermesLogPath,
      gateway_log_tail: hermesLogTail
    }
  }, null, 2)}\n`);
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
    process.exit(0);
  }

  if (command === "run-training") {
    runTraining();
    return;
  }

  if (command === "register-training") {
    registerTraining();
    return;
  }

  if (command === "status") {
    status();
    process.exit(0);
  }

  console.error(`Unknown RanchMind command: ${command}`);
  process.exit(1);
}

try {
  main();
}
catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
