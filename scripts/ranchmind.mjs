#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
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
  const spawnOptions = {
    cwd: options.cwd ?? rootDir,
    encoding: "utf8",
    input: options.input,
    env: options.env ?? process.env,
    maxBuffer: 16 * 1024 * 1024
  };
  if (options.timeoutMs && options.timeoutMs > 0) {
    spawnOptions.timeout = options.timeoutMs;
  }
  return spawnSync(command, args, spawnOptions);
}

function readJson(filePath) {
  const raw = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
  return JSON.parse(raw);
}

function writeTextFile(filePath, value) {
  ensureDirectory(path.dirname(filePath));
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tempPath, value, "utf8");
  try {
    fs.renameSync(tempPath, filePath);
  }
  catch {
    fs.rmSync(filePath, { force: true });
    fs.renameSync(tempPath, filePath);
  }
}

function writeJsonFile(filePath, value) {
  writeTextFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
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
    .replace(/\{\{qimenMethod\}\}/g, context.qimenMethod ?? "1")
    .replace(/\{\{limitStocks\}\}/g, context.limitStocks ?? "300")
    .replace(/\{\{startDate\}\}/g, context.startDate ?? "2024-01-01")
    .replace(/\{\{haircut\}\}/g, context.haircut ?? "0.45")
    .replace(/\{\{amplifier\}\}/g, context.amplifier ?? "1.50")
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

function getContext({ dateText = null, invocationSource = null, qimenMethod = null, limitStocks = null, startDate = null, haircut = null, amplifier = null } = {}) {
  return {
    rootDir,
    homeDir: os.homedir(),
    platform,
    dateText,
    invocationSource,
    qimenMethod: qimenMethod ?? parseFlag("--qimen-method") ?? "1",
    limitStocks: limitStocks ?? parseFlag("--limit-stocks") ?? "300",
    startDate: startDate ?? parseFlag("--start-date") ?? "2024-01-01",
    haircut: haircut ?? parseFlag("--haircut") ?? "0.45",
    amplifier: amplifier ?? parseFlag("--amplifier") ?? "1.50"
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

function getFeishuWatchdogConfig(config) {
  const watchdog = config.feishuWatchdog ?? {};
  return {
    failureThreshold: watchdog.failureThreshold ?? 3,
    taskPath: watchdog.taskPath ?? "\\RanchMind\\",
    taskName: watchdog.taskName ?? "RanchMindFeishuWatchdog",
    taskTime: watchdog.taskTime ?? "00:00",
    repeatMinutes: watchdog.repeatMinutes ?? 5,
    sourceCodexAuthPath: watchdog.sourceCodexAuthPath ?? "%USERPROFILE%\\.codex\\auth.json",
    runtimeHermesAuthPath: watchdog.runtimeHermesAuthPath ?? "%USERPROFILE%\\.hermes-windows\\runtime\\auth.json",
    gatewayStatePath: watchdog.gatewayStatePath ?? "%USERPROFILE%\\.hermes-windows\\runtime\\gateway_state.json",
    gatewayPidPath: watchdog.gatewayPidPath ?? "%USERPROFILE%\\.hermes-windows\\runtime\\gateway.pid",
    syncScriptPath: watchdog.syncScriptPath ?? "%USERPROFILE%\\.hermes-windows\\Sync-CodexAuthToHermes.ps1",
    gatewayTaskName: watchdog.gatewayTaskName ?? "Hermes Gateway",
    gatewayTaskPath: watchdog.gatewayTaskPath ?? "\\",
    syncSkewSeconds: watchdog.syncSkewSeconds ?? 3600,
    logTailLines: watchdog.logTailLines ?? 200
  };
}

function getSchedulingPolicyConfig(config) {
  const policy = config.schedulingPolicy ?? {};
  const watchdogConfig = getFeishuWatchdogConfig(config);
  return {
    lane: policy.lane ?? "training",
    historyScanLimit: policy.historyScanLimit ?? 200,
    feishuSnapshotMaxAgeSeconds: policy.feishuSnapshotMaxAgeSeconds
      ?? Math.max(600, (watchdogConfig.repeatMinutes ?? 5) * 120)
  };
}

function getAutonomyLoopConfig(config) {
  const loop = config.autonomyLoop ?? {};
  return {
    trainingHistoryScanLimit: loop.trainingHistoryScanLimit ?? 200,
    feishuHistoryScanLimit: loop.feishuHistoryScanLimit ?? 200,
    qmtHistoryScanLimit: loop.qmtHistoryScanLimit ?? 200,
    minSuccessfulRunsForEvaluation: loop.minSuccessfulRunsForEvaluation ?? 5
  };
}

function getQmtAdapter(config) {
  const platformConfig = config.qmt?.platforms?.[platform];
  if (platformConfig?.command) {
    return platformConfig;
  }

  throw new Error(`No QMT adapter is configured for platform "${platform}".`);
}

function getQmtHarnessConfig(config) {
  const h = config.qmt?.harness ?? {};
  const shared = getHarnessConfig(config);
  return {
    maxAttempts: h.maxAttempts ?? 3,
    retryDelaySeconds: h.retryDelaySeconds ?? 15,
    timeoutSeconds: h.timeoutSeconds ?? 900,
    startupWaitSeconds: h.startupWaitSeconds ?? 240,
    timeoutBackoffMultiplier: h.timeoutBackoffMultiplier ?? 20,
    runsRetainDays: h.runsRetainDays ?? shared.runsRetainDays,
    evaluator: {
      acceptStatuses: h.evaluator?.acceptStatuses ?? ["ok", "skipped"],
      requiredArtifactsOnOk: h.evaluator?.requiredArtifactsOnOk ?? [],
      requiredOutcomeFieldsOnOk: h.evaluator?.requiredOutcomeFieldsOnOk ?? [],
      metricThresholds: h.evaluator?.metricThresholds ?? {}
    }
  };
}

// ── Hermes / Feishu notify helpers ──────────────────────────────────────────

const KNOWN_FEISHU_FALLBACK_TARGET = "oc_223fa1db7fac3cc9ae9a0f2ad3af63f8";

function resolveHermesHomePath() {
  const candidates = [
    path.join(os.homedir(), ".hermes-windows", "runtime"),
    path.join(os.homedir(), ".hermes")
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, "config.yaml"))) {
      return candidate;
    }
  }
  return null;
}

function resolveHermesExePath() {
  const candidates = [
    path.join(os.homedir(), "tmp", "hermes-agent-win", ".venv", "Scripts", "hermes.exe"),
    path.join(os.homedir(), ".local", "bin", "hermes.exe")
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  const which = runCommand("where", ["hermes"], { timeoutMs: 5000 });
  if (which.status === 0 && which.stdout?.trim()) {
    return which.stdout.trim().split(/\r?\n/)[0].trim();
  }
  return null;
}

function resolveFeishuDmTarget() {
  const hermesHome = resolveHermesHomePath();
  if (hermesHome) {
    const chanDirPath = path.join(hermesHome, "channel_directory.json");
    const chanDir = safeReadJson(chanDirPath);
    const feishuEntries = chanDir?.platforms?.feishu ?? [];
    const dmEntry = feishuEntries.find((e) => e.type === "dm");
    if (dmEntry?.id) return String(dmEntry.id);
    if (feishuEntries.length > 0) {
      const first = feishuEntries[0];
      const id = String(first.id ?? first.name ?? "");
      if (id) return id;
    }
  }
  return KNOWN_FEISHU_FALLBACK_TARGET;
}

function sendHermesFeishuNotify(message) {
  const hermesExe = resolveHermesExePath();
  if (!hermesExe) {
    return { ok: false, reason: "hermes_not_found", raw: "" };
  }
  const hermesHome = resolveHermesHomePath();
  const target = resolveFeishuDmTarget();
  const env = { ...process.env };
  if (hermesHome) {
    env.HERMES_HOME = hermesHome;
  }
  const result = runCommand(hermesExe, ["send", "--to", `feishu:${target}`, message], { timeoutMs: 30000, env });
  return {
    ok: result.status === 0,
    target,
    raw: ((result.stdout ?? "") + (result.stderr ?? "")).trim(),
    exit_code: result.status ?? 1
  };
}

// ── QMT process lifecycle helpers ────────────────────────────────────────────

function checkQmtProcess(config) {
  const adapter = config.qmt?.platforms?.[platform] ?? {};
  const processName = adapter.processName ?? "XtItClient";
  const script = `$p = Get-Process -Name '${processName}' -ErrorAction SilentlyContinue; if ($p) { "running:" + $p[0].Id } else { "stopped" }`;
  const result = runCommand("powershell.exe", ["-NoProfile", "-Command", script], { timeoutMs: 10000 });
  const output = (result.stdout ?? "").trim();
  if (output.startsWith("running:")) {
    const pid = Number.parseInt(output.split(":")[1], 10) || 0;
    return { running: true, pid, name: processName };
  }
  return { running: false, pid: 0, name: processName };
}

function startQmtProcess(config) {
  const adapter = config.qmt?.platforms?.[platform] ?? {};
  const exePath = adapter.executable ?? "";
  if (!exePath || !fs.existsSync(exePath)) {
    return { ok: false, reason: "executable_not_found", path: exePath };
  }
  const script = `Start-Process -FilePath '${exePath.replace(/'/g, "''")}' -WindowStyle Normal; "started"`;
  const result = runCommand("powershell.exe", ["-NoProfile", "-Command", script], { timeoutMs: 15000 });
  const ok = result.status === 0 && (result.stdout ?? "").includes("started");
  return { ok, path: exePath, raw: (result.stdout ?? "").trim() };
}

function waitForQmtReady(config, maxSeconds) {
  const intervalMs = 10000;
  const maxMs = maxSeconds * 1000;
  const startMs = Date.now();
  while (Date.now() - startMs < maxMs) {
    const check = checkQmtProcess(config);
    if (check.running) {
      return { ready: true, elapsed_seconds: Math.round((Date.now() - startMs) / 1000), pid: check.pid };
    }
    sleepMilliseconds(intervalMs);
  }
  return { ready: false, elapsed_seconds: maxSeconds };
}

// ── Trading-day guard (lightweight JS mirror of KdLocal.Common.ps1) ──────────

const KNOWN_CN_NON_TRADING_DATES = new Set([
  "2026-01-01","2026-01-26","2026-01-27","2026-01-28","2026-01-29","2026-01-30","2026-02-02","2026-02-04",
  "2026-04-03","2026-04-04","2026-04-05","2026-04-06","2026-05-01","2026-05-04","2026-05-05",
  "2026-06-19","2026-06-22","2026-10-01","2026-10-02","2026-10-05","2026-10-06","2026-10-07","2026-10-08","2026-10-09"
]);

function isChinaAshareTradingDay(dateText) {
  const d = new Date(dateText + "T12:00:00+08:00");
  const dow = d.getDay();
  if (dow === 0 || dow === 6) return false;
  return !KNOWN_CN_NON_TRADING_DATES.has(dateText);
}

function getQmtSchedulerConfig(config) {
  const scheduler = config.qmt?.scheduler;
  if (!scheduler) {
    return null;
  }

  return scheduler;
}

function safeReadJson(filePath, fallback = null) {
  try {
    if (!filePath || !fs.existsSync(filePath)) {
      return fallback;
    }
    return readJson(filePath);
  }
  catch {
    return fallback;
  }
}

function compactText(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

function getAgeSeconds(timestamp) {
  if (!timestamp) {
    return null;
  }

  const parsed = Date.parse(timestamp);
  if (Number.isNaN(parsed)) {
    return null;
  }

  return Math.max(0, Math.floor((Date.now() - parsed) / 1000));
}

function readJsonLines(filePath, limit = 200) {
  if (!filePath || !fs.existsSync(filePath)) {
    return [];
  }

  const lines = fs.readFileSync(filePath, "utf8")
    .replace(/\r/g, "")
    .split("\n")
    .filter((line) => line.trim());
  const sliced = limit > 0 ? lines.slice(-limit) : lines;
  const entries = [];

  for (const line of sliced) {
    try {
      entries.push(JSON.parse(line));
    }
    catch {
      // Ignore malformed history lines so one bad write does not poison scheduling policy evaluation.
    }
  }

  return entries;
}

function fingerprintToken(token) {
  if (!token) {
    return "";
  }

  const digest = crypto.createHash("sha256").update(String(token)).digest("hex");
  return digest.slice(0, 12);
}

function decodeJwtExpiry(accessToken) {
  if (!accessToken) {
    return null;
  }

  const parts = String(accessToken).split(".");
  if (parts.length < 2) {
    return null;
  }

  try {
    const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const decoded = Buffer.from(payload.padEnd(payload.length + ((4 - (payload.length % 4)) % 4), "="), "base64").toString("utf8");
    const parsed = JSON.parse(decoded);
    if (!parsed.exp) {
      return null;
    }
    return new Date(parsed.exp * 1000).toISOString();
  }
  catch {
    return null;
  }
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

function buildWindowsRepeatedTaskXml(taskPath, taskName, taskTime, repeatMinutes, description, command, argumentsText, workingDirectory) {
  const { hour, minute } = parseTimeText(taskTime);
  const paddedHour = String(hour).padStart(2, "0");
  const paddedMinute = String(minute).padStart(2, "0");
  const now = new Date();
  const startBoundary = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}T${paddedHour}:${paddedMinute}:00`;
  const userId = process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}` : process.env.USERNAME;
  const taskUri = `${ensureWindowsTaskPath(taskPath)}${taskName}`;

  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>${escapeXml(description)}</Description>
    <URI>${escapeXml(taskUri)}</URI>
  </RegistrationInfo>
  <Triggers>
    <CalendarTrigger>
      <StartBoundary>${startBoundary}</StartBoundary>
      <Enabled>true</Enabled>
      <ScheduleByDay>
        <DaysInterval>1</DaysInterval>
      </ScheduleByDay>
      <Repetition>
        <Interval>PT${repeatMinutes}M</Interval>
        <Duration>P1D</Duration>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
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
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <DisallowStartOnRemoteAppSession>false</DisallowStartOnRemoteAppSession>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT15M</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${escapeXml(command)}</Command>
      <Arguments>${escapeXml(argumentsText)}</Arguments>
      <WorkingDirectory>${escapeXml(workingDirectory)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

function tailFileLines(filePath, maxLines) {
  if (!filePath || !fs.existsSync(filePath)) {
    return [];
  }

  const lines = fs.readFileSync(filePath, "utf8").replace(/\r/g, "").split("\n").filter(Boolean);
  return lines.slice(-maxLines);
}

function analyzeGatewayLog(lines, failureThreshold) {
  const failurePatterns = [
    /token_invalidated/i,
    /no Codex OAuth token found/i,
    /no available entries/i
  ];
  const successPatterns = [
    /Lark websocket connected/i,
    /Gateway running with/i,
    /websocket connected/i
  ];

  let lastSuccessIndex = -1;
  let consecutiveFailureCount = 0;
  let hasTokenInvalidated = false;
  let hasMissingCodexToken = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (successPatterns.some((pattern) => pattern.test(line))) {
      lastSuccessIndex = index;
    }
  }

  for (let index = Math.max(0, lastSuccessIndex + 1); index < lines.length; index += 1) {
    const line = lines[index];
    if (failurePatterns.some((pattern) => pattern.test(line))) {
      consecutiveFailureCount += 1;
    }
    if (/token_invalidated/i.test(line)) {
      hasTokenInvalidated = true;
    }
    if (/no Codex OAuth token found/i.test(line)) {
      hasMissingCodexToken = true;
    }
  }

  return {
    lines,
    last_success_index: lastSuccessIndex,
    consecutive_failure_count: consecutiveFailureCount,
    has_token_invalidated: hasTokenInvalidated,
    has_missing_codex_token: hasMissingCodexToken,
    stuck: consecutiveFailureCount >= failureThreshold
  };
}

function getCredentialPoolEntry(runtimeAuth) {
  return runtimeAuth?.credential_pool?.["openai-codex"]?.[0] ?? null;
}

function inspectGatewayProcess(pid) {
  if (!pid || pid <= 0) {
    return {
      pid: 0,
      running: false,
      process_name: "",
      path: "",
      expected_name: false
    };
  }

  const command = [
    "$p = Get-Process -Id",
    String(pid),
    "-ErrorAction SilentlyContinue;",
    "if ($p) { $p | Select-Object Id,ProcessName,Path | ConvertTo-Json -Compress }"
  ].join(" ");
  const result = runCommand("powershell.exe", ["-NoProfile", "-Command", command]);
  const raw = `${result.stdout ?? ""}`.trim();

  if (!raw) {
    return {
      pid,
      running: false,
      process_name: "",
      path: "",
      expected_name: false
    };
  }

  try {
    const parsed = JSON.parse(raw);
    const processName = String(parsed.ProcessName ?? "");
    return {
      pid,
      running: true,
      process_name: processName,
      path: String(parsed.Path ?? ""),
      expected_name: /python|uv|hermes/i.test(processName)
    };
  }
  catch {
    return {
      pid,
      running: false,
      process_name: "",
      path: "",
      expected_name: false
    };
  }
}

function stopProcessById(pid) {
  const result = runCommand("powershell.exe", [
    "-NoProfile",
    "-Command",
    `Stop-Process -Id ${pid} -Force`
  ]);

  return {
    ok: !result.error && result.status === 0,
    detail: compactText(`${result.stdout ?? ""} ${result.stderr ?? ""}`)
  };
}

function invokeAuthSync(sourcePath, runtimePath, syncScriptPath, skewSeconds) {
  const result = runCommand("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    syncScriptPath,
    "-WindowsCodexAuthPath",
    sourcePath,
    "-HermesAuthPath",
    runtimePath,
    "-SkewSeconds",
    String(skewSeconds)
  ]);

  const raw = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  let summary = null;
  try {
    summary = raw ? JSON.parse(raw) : null;
  }
  catch {
    summary = null;
  }

  return {
    ok: !result.error && result.status === 0,
    raw,
    summary
  };
}

function runTask(taskPath, taskName) {
  const fullName = `${ensureWindowsTaskPath(taskPath)}${taskName}`;
  const result = runCommand("schtasks.exe", ["/Run", "/TN", fullName]);
  return {
    ok: !result.error && result.status === 0,
    full_name: fullName,
    detail: compactText(`${result.stdout ?? ""} ${result.stderr ?? ""}`)
  };
}

function buildFeishuMarkdown(state) {
  const lines = [
    "# RanchMind Feishu Runtime",
    "",
    `- generated_at: ${state.generated_at}`,
    `- lifecycle_status: ${state.lifecycle_status}`,
    `- action: ${state.action}`,
    `- reason: ${state.reason}`,
    `- next_action: ${state.next_action}`
  ];

  if (state.gateway?.process) {
    lines.push(`- gateway_running: ${state.gateway.process.running}`);
    lines.push(`- gateway_pid: ${state.gateway.process.pid}`);
  }
  if (state.auth?.source?.fingerprint) {
    lines.push(`- source_auth_fingerprint: ${state.auth.source.fingerprint}`);
  }
  if (state.auth?.runtime?.fingerprint) {
    lines.push(`- runtime_auth_fingerprint: ${state.auth.runtime.fingerprint}`);
  }
  if (state.gateway?.log?.consecutive_failure_count !== undefined) {
    lines.push(`- consecutive_gateway_failures: ${state.gateway.log.consecutive_failure_count}`);
  }

  return `${lines.join("\n")}\n`;
}

function buildSchedulingPolicyMarkdown(policy) {
  const lines = [
    "# RanchMind Scheduling Policy",
    "",
    `- computed_at: ${policy.computed_at}`,
    `- lane: ${policy.lane}`,
    `- mode: ${policy.mode}`,
    `- verdict: ${policy.verdict}`,
    `- execution_gate: ${policy.execution_gate}`,
    `- next_action: ${policy.next_action}`
  ];

  for (const reason of policy.reasons ?? []) {
    lines.push(`- reason: ${reason}`);
  }
  for (const warning of policy.warnings ?? []) {
    lines.push(`- warning: ${warning}`);
  }

  const latestTraining = policy.sources?.latest_training_run;
  if (latestTraining) {
    lines.push(`- latest_training_lifecycle: ${latestTraining.lifecycle_status ?? "unknown"}`);
    lines.push(`- latest_training_decision: ${latestTraining.final_decision ?? "unknown"}`);
    lines.push(`- latest_training_age_seconds: ${latestTraining.age_seconds ?? ""}`);
  }

  const lastOkTraining = policy.sources?.last_successful_training;
  if (lastOkTraining) {
    lines.push(`- last_successful_training_at: ${lastOkTraining.generated_at ?? ""}`);
    lines.push(`- last_successful_training_age_seconds: ${lastOkTraining.age_seconds ?? ""}`);
    lines.push(`- last_successful_training_requested_date: ${lastOkTraining.requested_date ?? ""}`);
  }

  const feishuSnapshot = policy.sources?.feishu_snapshot;
  if (feishuSnapshot) {
    lines.push(`- feishu_snapshot_state: ${feishuSnapshot.lifecycle_status ?? "unknown"}`);
    lines.push(`- feishu_snapshot_age_seconds: ${feishuSnapshot.age_seconds ?? ""}`);
    lines.push(`- feishu_snapshot_stale: ${feishuSnapshot.stale ?? false}`);
  }

  return `${lines.join("\n")}\n`;
}

function buildAutonomyLoopMarkdown(loop) {
  const lines = [
    "# RanchMind Autonomy Loop",
    "",
    `- generated_at: ${loop.generated_at}`,
    `- mode: ${loop.mode}`,
    `- next_action: ${loop.next_action}`,
    `- baseline_autonomy_ratio: ${loop.baseline.training.autonomy_ratio}`,
    `- baseline_ok_runs: ${loop.baseline.training.ok_run_count}`,
    `- improvement_candidates: ${loop.plan.summary.total_candidates}`,
    `- operational_candidates: ${loop.plan.summary.operational_candidates}`,
    `- quality_candidates: ${loop.plan.summary.quality_candidates}`
  ];

  for (const insight of loop.evaluation.top_insights ?? []) {
    lines.push(`- insight: ${insight}`);
  }

  for (const candidate of loop.plan.operational_candidates ?? []) {
    lines.push(`- operational_candidate: ${candidate.id} (${candidate.priority})`);
  }
  for (const candidate of loop.plan.quality_candidates ?? []) {
    lines.push(`- quality_candidate: ${candidate.id} (${candidate.priority})`);
  }

  return `${lines.join("\n")}\n`;
}

function buildQmtMarkdownSummary(receipt) {
  const lines = [
    "# RanchMind QMT Summary",
    "",
    `- harness_status: ${receipt.harness.lifecycle_status}`,
    `- harness_decision: ${receipt.harness.final_decision}`,
    `- attempts: ${receipt.harness.attempts}/${receipt.harness.max_attempts}`,
    `- run_id: ${receipt.harness.run_id}`,
    `- status: ${receipt.outcome.status}`,
    `- invocation_source: ${receipt.invocation_source}`,
    `- requested_date: ${receipt.requested_date}`,
    `- generated_at: ${receipt.generated_at}`
  ];

  if (receipt.harness.next_action) {
    lines.push(`- next_action: ${receipt.harness.next_action}`);
  }

  if (receipt.outcome.reason) {
    lines.push(`- reason: ${receipt.outcome.reason}`);
  }

  if (receipt.outcome.notify?.status) {
    lines.push(`- notify_status: ${receipt.outcome.notify.status}`);
  }

  if (receipt.outcome.message) {
    lines.push("", "## Message", "", String(receipt.outcome.message).split("\n").slice(0, 12).join("\n"));
  }

  lines.push("", "## Harness", "");
  lines.push(`- run_dir: ${receipt.harness.run_dir}`);
  lines.push(`- contract_path: ${receipt.harness.contract_path}`);
  lines.push(`- evaluation_path: ${receipt.harness.evaluation_path}`);
  lines.push(`- run_state_path: ${receipt.harness.run_state_path}`);

  if (receipt.authoritative_status_json) {
    lines.push("", "## Artifacts", "");
    lines.push(`- output_json: ${receipt.authoritative_status_json}`);
  }

  return `${lines.join("\n")}\n`;
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

function makeQmtRunId() {
  const stamp = nowIso().replace(/[-:]/g, "").replace(/\./g, "").replace("T", "-").replace("Z", "");
  return `qmt-${stamp}`;
}

function getMetricValue(outcome, metricPath) {
  return metricPath.split(".").reduce((current, key) => (current && typeof current === "object" ? current[key] : undefined), outcome);
}

function collectNumericMetric(entries, metricPath) {
  const values = entries
    .map((entry) => getMetricValue(entry.outcome ?? {}, metricPath))
    .filter((value) => typeof value === "number" && Number.isFinite(value));

  if (values.length === 0) {
    return {
      count: 0,
      min: null,
      max: null,
      average: null,
      latest: null
    };
  }

  const sum = values.reduce((accumulator, value) => accumulator + value, 0);
  return {
    count: values.length,
    min: Math.min(...values),
    max: Math.max(...values),
    average: sum / values.length,
    latest: values[values.length - 1]
  };
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

function buildQmtInvocation(config, dateText, invocationSource, dryRun) {
  const context = getContext({ dateText, invocationSource });
  const adapter = getQmtAdapter(config);
  const command = renderTemplate(adapter.command, context);
  const args = [...(adapter.args ?? [])].map((value) => renderTemplate(value, context));

  if (dryRun && Array.isArray(adapter.dryRunArgs)) {
    args.push(...adapter.dryRunArgs.map((value) => renderTemplate(value, context)));
  }

  const outputJsonPath = adapter.outputJsonPath
    ? resolvePathLike(renderTemplate(adapter.outputJsonPath, context), context)
    : path.join(rootDir, "state", "tmp", "qmt-run-output.json");

  return {
    adapter,
    command,
    args,
    workingDirectory: adapter.workingDirectory ? resolvePathLike(adapter.workingDirectory, context) : rootDir,
    authoritativeStatusJson: outputJsonPath,
    outputJsonPath
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

function buildFeishuArtifacts(runId) {
  const stateRoot = path.join(rootDir, "state");
  const runsRoot = path.join(stateRoot, "runs");
  const runDir = path.join(runsRoot, runId);
  const memoryRoot = path.join(stateRoot, "memory");

  return {
    stateRoot,
    runsRoot,
    runDir,
    memoryRoot,
    resultPath: path.join(runDir, "result.json"),
    latestPath: path.join(memoryRoot, "feishu-runtime-latest.json"),
    latestMarkdownPath: path.join(memoryRoot, "feishu-runtime-latest.md"),
    historyPath: path.join(memoryRoot, "feishu-runtime-history.jsonl")
  };
}

function buildAutonomyLoopArtifacts(runId) {
  const stateRoot = path.join(rootDir, "state");
  const runsRoot = path.join(stateRoot, "runs");
  const runDir = path.join(runsRoot, runId);
  const memoryRoot = path.join(stateRoot, "memory");

  return {
    stateRoot,
    runsRoot,
    runDir,
    memoryRoot,
    baselinePath: path.join(runDir, "autonomy-baseline.json"),
    planPath: path.join(runDir, "improvement-plan.json"),
    evaluationPath: path.join(runDir, "evaluation.json"),
    resultPath: path.join(runDir, "result.json"),
    latestPath: path.join(memoryRoot, "autonomy-loop-latest.json"),
    latestMarkdownPath: path.join(memoryRoot, "autonomy-loop-latest.md"),
    historyPath: path.join(memoryRoot, "autonomy-loop-history.jsonl")
  };
}

function buildQmtRunArtifacts(runId) {
  const stateRoot = path.join(rootDir, "state");
  const runsRoot = path.join(stateRoot, "runs");
  const runDir = path.join(runsRoot, runId);
  const attemptsDir = path.join(runDir, "attempts");
  const receiptsRoot = path.join(stateRoot, "receipts", "qmt");
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
    latestReceiptPath: path.join(memoryRoot, "qmt-latest.json"),
    latestMarkdownPath: path.join(memoryRoot, "qmt-latest.md"),
    latestRunPath: path.join(memoryRoot, "qmt-latest-run.json"),
    historyPath: path.join(memoryRoot, "qmt-history.jsonl")
  };
}

function buildSchedulingPolicyArtifacts(runId) {
  const stateRoot = path.join(rootDir, "state");
  const runsRoot = path.join(stateRoot, "runs");
  const runDir = path.join(runsRoot, runId);
  const memoryRoot = path.join(stateRoot, "memory");

  return {
    stateRoot,
    runsRoot,
    runDir,
    memoryRoot,
    resultPath: path.join(runDir, "result.json"),
    latestPath: path.join(memoryRoot, "scheduling-policy-latest.json"),
    latestMarkdownPath: path.join(memoryRoot, "scheduling-policy-latest.md"),
    historyPath: path.join(memoryRoot, "scheduling-policy-history.jsonl")
  };
}

function buildAutonomyBaseline(loopConfig) {
  const trainingHistoryPath = path.join(rootDir, "state", "memory", "training-history.jsonl");
  const feishuHistoryPath = path.join(rootDir, "state", "memory", "feishu-runtime-history.jsonl");
  const qmtHistoryPath = path.join(rootDir, "state", "memory", "qmt-history.jsonl");
  const trainingHistory = readJsonLines(trainingHistoryPath, loopConfig.trainingHistoryScanLimit);
  const feishuHistory = readJsonLines(feishuHistoryPath, loopConfig.feishuHistoryScanLimit);
  const qmtHistory = readJsonLines(qmtHistoryPath, loopConfig.qmtHistoryScanLimit);
  const okRuns = trainingHistory.filter((entry) => entry?.outcome?.status === "ok");
  const skippedRuns = trainingHistory.filter((entry) => entry?.outcome?.status === "skipped");
  const blockedOrFailedRuns = trainingHistory.filter((entry) => {
    const lifecycle = String(entry?.harness?.lifecycle_status ?? "");
    const decision = String(entry?.harness?.final_decision ?? "");
    return ["blocked", "failed"].includes(lifecycle) || ["blocked", "failed"].includes(decision);
  });
  const qmtOkRuns = qmtHistory.filter((entry) => entry?.outcome?.status === "ok");
  const qmtSkippedRuns = qmtHistory.filter((entry) => entry?.outcome?.status === "skipped");
  const qmtBlockedOrFailed = qmtHistory.filter((entry) => {
    const lifecycle = String(entry?.harness?.lifecycle_status ?? "");
    const decision = String(entry?.harness?.final_decision ?? "");
    return ["blocked", "failed"].includes(lifecycle) || ["blocked", "failed"].includes(decision);
  });
  const feishuCounts = {
    healthy: feishuHistory.filter((entry) => entry?.lifecycle_status === "healthy").length,
    recovering: feishuHistory.filter((entry) => entry?.lifecycle_status === "recovering").length,
    degraded: feishuHistory.filter((entry) => entry?.lifecycle_status === "degraded").length,
    blocked: feishuHistory.filter((entry) => entry?.lifecycle_status === "blocked").length
  };

  return {
    generated_at: nowIso(),
    sources: {
      training_history: {
        path: trainingHistoryPath,
        scanned_entries: trainingHistory.length
      },
      feishu_history: {
        path: feishuHistoryPath,
        scanned_entries: feishuHistory.length
      },
      qmt_history: {
        path: qmtHistoryPath,
        scanned_entries: qmtHistory.length
      }
    },
    training: {
      total_runs: trainingHistory.length,
      ok_run_count: okRuns.length,
      skipped_run_count: skippedRuns.length,
      blocked_or_failed_count: blockedOrFailedRuns.length,
      autonomy_ratio: trainingHistory.length === 0
        ? null
        : (trainingHistory.length - blockedOrFailedRuns.length) / trainingHistory.length,
      metrics: {
        objective_score: collectNumericMetric(okRuns, "summary.objective_score"),
        validation_calendar_sharpe: collectNumericMetric(okRuns, "summary.validation_calendar_sharpe"),
        validation_max_drawdown: collectNumericMetric(okRuns, "summary.validation_max_drawdown")
      },
      latest_ok_run: okRuns.length > 0
        ? {
            generated_at: okRuns[okRuns.length - 1].generated_at ?? null,
            requested_date: okRuns[okRuns.length - 1].requested_date ?? null,
            run_id: okRuns[okRuns.length - 1].harness?.run_id ?? null
          }
        : null
    },
    qmt: {
      total_runs: qmtHistory.length,
      ok_run_count: qmtOkRuns.length,
      skipped_run_count: qmtSkippedRuns.length,
      blocked_or_failed_count: qmtBlockedOrFailed.length,
      autonomy_ratio: qmtHistory.length === 0
        ? null
        : (qmtHistory.length - qmtBlockedOrFailed.length) / qmtHistory.length,
      latest_ok_run: qmtOkRuns.length > 0
        ? {
            generated_at: qmtOkRuns[qmtOkRuns.length - 1].generated_at ?? null,
            requested_date: qmtOkRuns[qmtOkRuns.length - 1].requested_date ?? null,
            run_id: qmtOkRuns[qmtOkRuns.length - 1].harness?.run_id ?? null
          }
        : null
    },
    feishu: {
      total_runs: feishuHistory.length,
      lifecycle_counts: feishuCounts,
      blocked_ratio: feishuHistory.length === 0 ? null : feishuCounts.blocked / feishuHistory.length
    }
  };
}

function buildImprovementPlan(config, baseline, schedulingPolicy) {
  const loopConfig = getAutonomyLoopConfig(config);
  const metricThresholds = getHarnessConfig(config).evaluator.metricThresholds;
  const operationalCandidates = [];
  const qualityCandidates = [];

  if (schedulingPolicy.verdict === "degraded") {
    operationalCandidates.push({
      id: "review-latest-training-harness",
      priority: "high",
      auto_apply: false,
      reason: "The latest training harness run is degraded, so autonomy cannot improve until that lane is stable again.",
      validation_target: "training-latest-run.json returns completed/pass on the next successful cycle."
    });
  }

  if ((schedulingPolicy.warnings ?? []).some((warning) => warning.startsWith("feishu_"))) {
    operationalCandidates.push({
      id: "repair-feishu-runtime-signal",
      priority: "medium",
      auto_apply: false,
      reason: "Notification health is drifting or stale, which weakens unattended operation even if local training is still runnable.",
      validation_target: "feishu-runtime-latest.json remains healthy and fresh across multiple watchdog cycles."
    });
  }

  if (!config.qmt) {
    operationalCandidates.push({
      id: "generalize-training-harness-into-qmt-lane",
      priority: "high",
      auto_apply: false,
      reason: "RanchMind still has a validated training lane but not a first-class QMT task lane with the same contract/evaluator/state model.",
      validation_target: "A dedicated QMT lane gains contract, attempts, evaluation, and final receipt artifacts."
    });
  }

  if (Object.keys(metricThresholds ?? {}).length === 0) {
    qualityCandidates.push({
      id: "activate-reviewed-metric-thresholds",
      priority: "high",
      auto_apply: false,
      reason: "The harness quality gate is still inactive, so the loop can only measure operational reliability, not model quality.",
      validation_target: "At least one explicit metric threshold is configured and exercised by a real ok run."
    });
  }

  if ((baseline.training.ok_run_count ?? 0) < loopConfig.minSuccessfulRunsForEvaluation) {
    qualityCandidates.push({
      id: "accumulate-more-successful-training-runs",
      priority: "medium",
      auto_apply: false,
      reason: `Only ${baseline.training.ok_run_count} successful training runs are available; this is below the ${loopConfig.minSuccessfulRunsForEvaluation}-run floor for trustworthy tuning decisions.`,
      validation_target: `Collect at least ${loopConfig.minSuccessfulRunsForEvaluation} successful training runs before comparing candidate changes.`
    });
  }

  const objectiveAverage = baseline.training.metrics.objective_score.average;
  if (typeof objectiveAverage === "number" && objectiveAverage < 0) {
    qualityCandidates.push({
      id: "investigate-negative-objective-score",
      priority: "high",
      auto_apply: false,
      reason: `Average objective score across successful runs is ${objectiveAverage.toFixed(3)}, so the lane is running but not yet producing healthy output quality.`,
      validation_target: "Future successful runs show objective_score trending upward toward an operator-approved threshold."
    });
  }

  const sharpeAverage = baseline.training.metrics.validation_calendar_sharpe.average;
  if (typeof sharpeAverage === "number" && sharpeAverage < 0) {
    qualityCandidates.push({
      id: "investigate-negative-validation-sharpe",
      priority: "high",
      auto_apply: false,
      reason: `Average validation sharpe across successful runs is ${sharpeAverage.toFixed(3)}, indicating quality issues are currently hidden behind pass/fail operational checks.`,
      validation_target: "Validation sharpe improves over the next evaluated window of successful runs."
    });
  }

  return {
    generated_at: nowIso(),
    mode: "recommend_only",
    readiness: {
      safe_auto_apply_enabled: false,
      operator_review_required: true
    },
    summary: {
      total_candidates: operationalCandidates.length + qualityCandidates.length,
      operational_candidates: operationalCandidates.length,
      quality_candidates: qualityCandidates.length
    },
    operational_candidates: operationalCandidates,
    quality_candidates: qualityCandidates
  };
}

function buildAutonomyEvaluation(baseline, schedulingPolicy, plan) {
  const insights = [];
  if ((baseline.training.blocked_or_failed_count ?? 0) > 0) {
    insights.push("Recent training history still contains blocked or failed runs, so autonomy remains incomplete.");
  }
  if ((baseline.training.ok_run_count ?? 0) === 0) {
    insights.push("No successful training runs are available, so quality evaluation cannot begin.");
  }
  if ((plan.quality_candidates ?? []).length > 0) {
    insights.push("Quality work remains distinct from operational reliability; both must improve before unattended QMT autonomy is credible.");
  }
  if ((schedulingPolicy.warnings ?? []).length > 0) {
    insights.push("Auxiliary runtime signals still emit warnings, so unattended operation would have weak observability.");
  }
  if (insights.length === 0) {
    insights.push("Current signals are stable enough to continue the next bounded improvement cycle.");
  }

  return {
    generated_at: nowIso(),
    autonomy_ready: false,
    top_insights: insights,
    scorecard: {
      scheduling_verdict: schedulingPolicy.verdict,
      autonomy_ratio: baseline.training.autonomy_ratio,
      successful_training_runs: baseline.training.ok_run_count,
      feishu_blocked_ratio: baseline.feishu.blocked_ratio,
      improvement_candidate_count: plan.summary.total_candidates
    }
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

function createQmtRunContract(config, harnessConfig, dateText, invocationSource, requestedDryRun, invocation) {
  const schedulerConfig = getQmtSchedulerConfig(config);

  return {
    run_type: "qmt",
    created_at: nowIso(),
    planner: {
      style: "structured-contract",
      summary: "Execute the QMT overnight notify adapter, then evaluate status before accepting the run."
    },
    request: {
      requested_date: dateText,
      invocation_source: invocationSource,
      dry_run_requested: requestedDryRun
    },
    retry_policy: {
      max_attempts: harnessConfig.maxAttempts,
      retry_delay_seconds: harnessConfig.retryDelaySeconds,
      retryable_failures: [
        "process_error",
        "non_json_output",
        "empty_output",
        "non_zero_exit"
      ],
      retry_behavior: "Only execution failures retry automatically. Unexpected status failures block for operator review.",
      retry_force_behavior: "Retry attempts re-run the notify script without additional force flags."
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

function buildQmtReceipt(config, paths, contract, runState, finalAttempt, finalEvaluation) {
  const schedulerConfig = getQmtSchedulerConfig(config);
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

function executeQmtAttempt(config, runContext, attemptNumber) {
  const dryRun = runContext.dryRun ?? false;
  const harnessConfig = getQmtHarnessConfig(config);
  const timeoutMs = (harnessConfig.timeoutSeconds ?? 900) * 1000;
  const invocation = buildQmtInvocation(config, runContext.dateText, runContext.invocationSource, dryRun);
  const startedAt = nowIso();
  ensureDirectory(path.dirname(invocation.outputJsonPath));
  const result = runCommand(invocation.command, invocation.args, { cwd: invocation.workingDirectory, timeoutMs });
  const finishedAt = nowIso();
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const combined = `${stdout}${stderr}`.trim();

  const record = {
    attempt: attemptNumber,
    started_at: startedAt,
    finished_at: finishedAt,
    dry_run: dryRun,
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
    const isTimeout = result.error.code === "ETIMEDOUT";
    record.is_timeout = isTimeout;
    record.process_error = isTimeout
      ? `QMT adapter timed out after ${harnessConfig.timeoutSeconds}s. QMT may not be running or the export pipeline is stalled.`
      : result.error.message;
    return record;
  }

  if (!record.raw_output) {
    record.parse_error = "QMT adapter returned no output.";
    return record;
  }

  try {
    record.outcome = JSON.parse(record.raw_output);
  }
  catch {
    record.parse_error = `QMT adapter returned non-JSON output: ${record.raw_output.slice(0, 400)}`;
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
  writeTextFile(paths.latestMarkdownPath, buildMarkdownSummary(legacyReceipt));
  appendJsonLine(paths.historyPath, legacyReceipt);

  process.stdout.write(`${JSON.stringify(legacyReceipt, null, 2)}\n`);
  if (finalEvaluation.decision === "pass") {
    return 0;
  }
  return 1;
}

function runQmtHarness() {
  const config = loadConfig();
  if (!config.qmt) {
    console.error("QMT lane is not configured. Add a 'qmt' block to ranchmind.config.json.");
    return 1;
  }

  const harnessConfig = getQmtHarnessConfig(config);
  const dateText = parseFlag("--date") ?? new Date().toISOString().slice(0, 10);
  const invocationSource = parseFlag("--source") ?? "ranchmind.manual";
  const dryRun = process.argv.includes("--dry-run");
  const runId = makeQmtRunId();
  const paths = buildQmtRunArtifacts(runId);

  ensureDirectory(paths.attemptsDir);
  ensureDirectory(paths.receiptsRoot);
  ensureDirectory(paths.memoryRoot);
  trimOldRunDirectories(paths.runsRoot, harnessConfig.runsRetainDays);

  const initialInvocation = buildQmtInvocation(config, dateText, invocationSource, dryRun);
  const contract = createQmtRunContract(config, harnessConfig, dateText, invocationSource, dryRun, initialInvocation);
  writeJsonFile(paths.contractPath, contract);

  let runState = writeRunState(paths, null, {
    run_id: runId,
    lane: "qmt",
    status: "running",
    phase: "planning",
    started_at: nowIso(),
    contract_path: paths.contractPath,
    attempts: [],
    next_action: "Pre-flight: check QMT process."
  });

  // ── Pre-flight: QMT process check and auto-start ─────────────────────────
  const preflightLog = { checked_at: nowIso() };

  if (!dryRun && isChinaAshareTradingDay(dateText)) {
    const processCheck = checkQmtProcess(config);
    preflightLog.process_check = processCheck;

    if (!processCheck.running) {
      runState = writeRunState(paths, runState, {
        phase: "pre_flight",
        next_action: "QMT process not found — attempting auto-start."
      });

      const startResult = startQmtProcess(config);
      preflightLog.start_attempt = startResult;

      if (startResult.ok) {
        runState = writeRunState(paths, runState, {
          phase: "pre_flight",
          next_action: `QMT launched. Waiting up to ${harnessConfig.startupWaitSeconds}s for process to become ready.`
        });
        const waitResult = waitForQmtReady(config, harnessConfig.startupWaitSeconds);
        preflightLog.startup_wait = waitResult;

        if (!waitResult.ready) {
          const failMsg = `[RanchMind] QMT 自启动失败 — 进程在 ${harnessConfig.startupWaitSeconds}s 内未就绪。请手动启动 QMT 后重试。run_id: ${runId}`;
          const notify = sendHermesFeishuNotify(failMsg);
          preflightLog.feishu_notify = notify;

          runState = writeRunState(paths, runState, {
            status: "blocked",
            phase: "pre_flight_failed",
            completed_at: nowIso(),
            preflight_log: preflightLog,
            next_action: "QMT process did not start within the startup window. Manual intervention needed to launch QMT.",
            final_decision: "blocked",
            final_reason: "qmt_startup_timeout"
          });
          const blockedReceipt = buildQmtReceipt(config, paths, contract, runState, null, {
            decision: "blocked",
            lifecycle_status: "blocked",
            reason: "qmt_startup_timeout",
            next_action: "QMT process did not start within the startup window.",
            checks: []
          });
          writeJsonFile(paths.finalReceiptPath, blockedReceipt);
          writeJsonFile(blockedReceipt.receipt_path, blockedReceipt);
          writeJsonFile(paths.latestReceiptPath, blockedReceipt);
          writeJsonFile(paths.latestRunPath, {
            run_id: runId, run_dir: paths.runDir, lifecycle_status: "blocked",
            final_decision: "blocked", updated_at: nowIso()
          });
          appendJsonLine(paths.historyPath, blockedReceipt);
          process.stdout.write(`${JSON.stringify(blockedReceipt, null, 2)}\n`);
          return 1;
        }
      }
      else {
        // Executable not found — continue anyway; PS script will surface the real error
        preflightLog.start_skipped = true;
        preflightLog.start_reason = startResult.reason ?? "start_failed";
      }
    }
  }
  else {
    preflightLog.skipped = true;
    preflightLog.reason = dryRun ? "dry_run" : "non_trading_day";
  }

  runState = writeRunState(paths, runState, {
    phase: "executing",
    preflight_log: preflightLog,
    next_action: "Execute QMT notify attempt 1."
  });

  // ── Attempt loop ──────────────────────────────────────────────────────────
  const evaluationHistory = [];
  let finalAttempt = null;
  let finalEvaluation = null;

  for (let attemptNumber = 1; attemptNumber <= harnessConfig.maxAttempts; attemptNumber += 1) {
    runState = writeRunState(paths, runState, {
      phase: "executing",
      next_action: `Run QMT notify attempt ${attemptNumber}.`
    });

    const attemptRecord = executeQmtAttempt(config, { dateText, invocationSource, dryRun }, attemptNumber);
    attemptRecord.attempt_path = path.join(paths.attemptsDir, `attempt-${String(attemptNumber).padStart(2, "0")}.json`);
    writeJsonFile(attemptRecord.attempt_path, attemptRecord);

    runState = writeRunState(paths, runState, {
      phase: "evaluating",
      attempts: [
        ...runState.attempts,
        {
          attempt: attemptNumber,
          attempt_path: attemptRecord.attempt_path,
          dry_run: dryRun,
          exit_code: attemptRecord.exit_code,
          is_timeout: attemptRecord.is_timeout ?? false,
          finished_at: attemptRecord.finished_at
        }
      ],
      next_action: `Evaluate QMT attempt ${attemptNumber}.`
    });

    let evaluation = evaluateAttempt(harnessConfig, attemptRecord);
    evaluation = { ...evaluation, attempt: attemptNumber, evaluated_at: nowIso() };
    evaluationHistory.push(evaluation);
    finalAttempt = attemptRecord;
    finalEvaluation = evaluation;

    if (evaluation.decision === "pass") {
      break;
    }

    if (evaluation.decision === "retry" && attemptNumber < harnessConfig.maxAttempts) {
      // Use long backoff only for genuine timeouts so non-timeout errors recover quickly
      const isTimeout = attemptRecord.is_timeout ?? false;
      const backoffSeconds = isTimeout
        ? harnessConfig.retryDelaySeconds * harnessConfig.timeoutBackoffMultiplier
        : harnessConfig.retryDelaySeconds;
      runState = writeRunState(paths, runState, {
        status: "running",
        phase: "waiting_to_retry",
        next_action: `Retry after ${backoffSeconds}s because ${evaluation.reason}${isTimeout ? " (timeout backoff)" : ""}.`
      });
      sleepMilliseconds(backoffSeconds * 1000);
      continue;
    }

    if (evaluation.decision === "retry") {
      finalEvaluation = finalizeRetryExhausted(evaluation, harnessConfig.maxAttempts);
    }
    break;
  }

  // ── Post-run: autonomous Feishu notification on terminal failure ──────────
  const lifecycleStatus = finalEvaluation.lifecycle_status;
  let postRunNotify = null;

  if (finalEvaluation.decision !== "pass" && !dryRun) {
    const reason = finalEvaluation.reason ?? "unknown";
    const failMsg = [
      `[RanchMind QMT] 运行终止 — ${lifecycleStatus}`,
      `原因: ${reason}`,
      `次数: ${evaluationHistory.length}/${harnessConfig.maxAttempts}`,
      `建议: ${finalEvaluation.next_action ?? "请检查 QMT 是否运行正常。"}`,
      `run_id: ${runId}`
    ].join("\n");
    postRunNotify = sendHermesFeishuNotify(failMsg);
  }

  runState = writeRunState(paths, runState, {
    status: lifecycleStatus,
    phase: "completed",
    completed_at: nowIso(),
    next_action: finalEvaluation.next_action,
    final_decision: finalEvaluation.decision,
    final_reason: finalEvaluation.reason,
    post_run_notify: postRunNotify
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

  const receipt = buildQmtReceipt(config, paths, contract, runState, finalAttempt, finalEvaluation);
  writeJsonFile(paths.finalReceiptPath, receipt);
  writeJsonFile(receipt.receipt_path, receipt);
  writeJsonFile(paths.latestReceiptPath, receipt);
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
  writeTextFile(paths.latestMarkdownPath, buildQmtMarkdownSummary(receipt));
  appendJsonLine(paths.historyPath, receipt);

  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  return finalEvaluation.decision === "pass" ? 0 : 1;
}

function ensureFeishuRuntime() {
  if (platform !== "win32") {
    throw new Error("Feishu watchdog is currently implemented for Windows only.");
  }

  const config = loadConfig();
  const watchdogConfig = getFeishuWatchdogConfig(config);
  const context = getContext();
  const runId = `feishu-runtime-${nowIso().replace(/[-:]/g, "").replace(/\./g, "").replace("T", "-").replace("Z", "")}`;
  const paths = buildFeishuArtifacts(runId);
  ensureDirectory(paths.runDir);
  ensureDirectory(paths.memoryRoot);
  trimOldRunDirectories(paths.runsRoot, getHarnessConfig(config).runsRetainDays);

  const sourceCodexAuthPath = resolvePathLike(watchdogConfig.sourceCodexAuthPath, context);
  const runtimeHermesAuthPath = resolvePathLike(watchdogConfig.runtimeHermesAuthPath, context);
  const gatewayStatePath = resolvePathLike(watchdogConfig.gatewayStatePath, context);
  const gatewayPidPath = resolvePathLike(watchdogConfig.gatewayPidPath, context);
  const syncScriptPath = resolvePathLike(watchdogConfig.syncScriptPath, context);
  const gatewayLogPath = resolvePathLike(getHermesConfig(config)?.gatewayLog ?? "", context);

  const sourceAuth = safeReadJson(sourceCodexAuthPath);
  const runtimeAuthBefore = safeReadJson(runtimeHermesAuthPath);
  const gatewayState = safeReadJson(gatewayStatePath);
  const gatewayPidRecord = safeReadJson(gatewayPidPath);
  const gatewayPid = Number.parseInt(String(gatewayState?.pid ?? gatewayPidRecord?.pid ?? "0"), 10) || 0;
  const gatewayProcess = inspectGatewayProcess(gatewayPid);
  const gatewayAvailable = gatewayProcess.running && gatewayProcess.expected_name;
  const logLines = tailFileLines(gatewayLogPath, watchdogConfig.logTailLines);
  const logAnalysis = analyzeGatewayLog(logLines, watchdogConfig.failureThreshold);
  const runtimePoolBefore = getCredentialPoolEntry(runtimeAuthBefore);

  const sourceAccessToken = sourceAuth?.tokens?.access_token ?? "";
  const runtimeAccessToken = runtimePoolBefore?.access_token ?? "";
  const sourceFingerprint = fingerprintToken(sourceAccessToken);
  const runtimeFingerprint = fingerprintToken(runtimeAccessToken);
  const sourceExpiry = decodeJwtExpiry(sourceAccessToken);
  const sourceHealthy = Boolean(sourceAccessToken) && Boolean(sourceExpiry) && (new Date(sourceExpiry).getTime() - Date.now()) > (watchdogConfig.syncSkewSeconds * 1000);
  const runtimeErrorReason = String(runtimePoolBefore?.last_error_reason ?? runtimePoolBefore?.last_status ?? "");
  const authSameAsRejected = Boolean(sourceFingerprint) && sourceFingerprint === runtimeFingerprint && /token_invalidated|401/i.test(runtimeErrorReason);
  const runtimeMissingToken = !runtimeAccessToken;
  const runtimeMismatch = sourceFingerprint && runtimeFingerprint && sourceFingerprint !== runtimeFingerprint;
  const runtimeNeedsSync = sourceHealthy && (runtimeMissingToken || runtimeMismatch || Boolean(runtimeErrorReason));

  const state = {
    run_id: runId,
    generated_at: nowIso(),
    lifecycle_status: "healthy",
    action: "noop",
    reason: "already_healthy",
    next_action: "No intervention required.",
    paths: {
      source_codex_auth: sourceCodexAuthPath,
      runtime_hermes_auth: runtimeHermesAuthPath,
      gateway_state: gatewayStatePath,
      gateway_pid: gatewayPidPath,
      sync_script: syncScriptPath,
      gateway_log: gatewayLogPath
    },
    auth: {
      source: {
        exists: Boolean(sourceAuth),
        fingerprint: sourceFingerprint,
        expiry_utc: sourceExpiry,
        healthy: sourceHealthy
      },
      runtime: {
        exists: Boolean(runtimeAuthBefore),
        fingerprint: runtimeFingerprint,
        last_error_reason: runtimeErrorReason
      }
    },
    gateway: {
      task: getTaskQuery(watchdogConfig.gatewayTaskPath, watchdogConfig.gatewayTaskName),
      process: gatewayProcess,
      available: gatewayAvailable,
      log: {
        consecutive_failure_count: logAnalysis.consecutive_failure_count,
        stuck: logAnalysis.stuck,
        has_token_invalidated: logAnalysis.has_token_invalidated,
        has_missing_codex_token: logAnalysis.has_missing_codex_token,
        tail: logLines.slice(-10)
      }
    }
  };

  if (!sourceAuth?.tokens?.access_token) {
    state.lifecycle_status = "blocked";
    state.action = "blocked";
    state.reason = "source_auth_missing";
    state.next_action = "Re-authenticate the source Codex CLI because RanchMind cannot recover a missing source token.";
  }
  else if (!sourceHealthy) {
    state.lifecycle_status = "blocked";
    state.action = "blocked";
    state.reason = "source_auth_expired_or_expiring";
    state.next_action = "Refresh the local Codex auth first; the watchdog will not restart Hermes with an expiring source token.";
  }
  else if (authSameAsRejected && logAnalysis.stuck) {
    state.lifecycle_status = "blocked";
    state.action = "blocked";
    state.reason = "source_token_server_revoked";
    state.next_action = "The source token fingerprint matches the token that Hermes already had rejected by the server. Re-authenticate the local CLI before any restart.";
  }
  else if (logAnalysis.stuck && runtimeNeedsSync) {
    const syncResult = invokeAuthSync(sourceCodexAuthPath, runtimeHermesAuthPath, syncScriptPath, watchdogConfig.syncSkewSeconds);
    state.sync = {
      ok: syncResult.ok,
      raw: syncResult.raw,
      summary: syncResult.summary
    };

    if (syncResult.ok && gatewayAvailable) {
      const stopResult = stopProcessById(gatewayProcess.pid);
      state.restart = {
        mode: "kill_gateway_pid",
        pid: gatewayProcess.pid,
        ok: stopResult.ok,
        detail: stopResult.detail
      };
      state.lifecycle_status = stopResult.ok ? "recovering" : "degraded";
      state.action = stopResult.ok ? "restarted_gateway" : "sync_only";
      state.reason = stopResult.ok ? "stuck_gateway_with_new_auth" : "gateway_stop_failed";
      state.next_action = stopResult.ok
        ? "The Hermes launcher should re-run auth sync and restart the gateway automatically."
        : "Review the Hermes launcher because sync succeeded but stopping the stuck gateway failed.";
    }
    else if (syncResult.ok) {
      const startResult = runTask(watchdogConfig.gatewayTaskPath, watchdogConfig.gatewayTaskName);
      state.restart = {
        mode: "run_gateway_task",
        ok: startResult.ok,
        detail: startResult.detail
      };
      state.lifecycle_status = startResult.ok ? "recovering" : "degraded";
      state.action = startResult.ok ? "started_gateway_task" : "sync_only";
      state.reason = startResult.ok ? "gateway_not_running_after_sync" : "gateway_task_start_failed";
      state.next_action = startResult.ok
        ? "Wait for the Hermes launcher to start the gateway with refreshed auth."
        : "Review the Hermes Gateway task because RanchMind could sync auth but could not start the launcher task.";
    }
    else {
      state.lifecycle_status = "degraded";
      state.action = "sync_failed";
      state.reason = "runtime_sync_failed";
      state.next_action = "Review the sync script or auth files because RanchMind could not refresh the Hermes runtime auth.";
    }
  }
  else if (!gatewayAvailable) {
    if (runtimeNeedsSync) {
      const syncResult = invokeAuthSync(sourceCodexAuthPath, runtimeHermesAuthPath, syncScriptPath, watchdogConfig.syncSkewSeconds);
      state.sync = {
        ok: syncResult.ok,
        raw: syncResult.raw,
        summary: syncResult.summary
      };
      if (!syncResult.ok) {
        state.lifecycle_status = "degraded";
        state.action = "sync_failed";
        state.reason = "gateway_down_and_sync_failed";
        state.next_action = "Fix auth sync first, then re-run the watchdog.";
      }
    }

    if (state.lifecycle_status !== "degraded") {
      const startResult = runTask(watchdogConfig.gatewayTaskPath, watchdogConfig.gatewayTaskName);
      state.restart = {
        mode: "run_gateway_task",
        ok: startResult.ok,
        detail: startResult.detail
      };
      state.lifecycle_status = startResult.ok ? "recovering" : "degraded";
      state.action = startResult.ok ? "started_gateway_task" : "task_start_failed";
      state.reason = startResult.ok ? "gateway_not_running" : "gateway_task_start_failed";
      state.next_action = startResult.ok
        ? "Wait for the Hermes launcher to restore the Feishu gateway."
        : "Inspect the Hermes Gateway task and launcher logs because the gateway is down and the task could not be started.";
    }
  }
  else if (runtimeNeedsSync && !logAnalysis.stuck) {
    const syncResult = invokeAuthSync(sourceCodexAuthPath, runtimeHermesAuthPath, syncScriptPath, watchdogConfig.syncSkewSeconds);
    state.sync = {
      ok: syncResult.ok,
      raw: syncResult.raw,
      summary: syncResult.summary
    };
    state.lifecycle_status = syncResult.ok ? "healthy" : "degraded";
    state.action = syncResult.ok ? "synced_runtime_auth" : "sync_failed";
    state.reason = syncResult.ok ? "runtime_auth_drift" : "runtime_sync_failed";
    state.next_action = syncResult.ok
      ? "Runtime auth drift was corrected without restarting the gateway."
      : "Review runtime auth because RanchMind detected drift but could not sync it.";
  }

  writeJsonFile(paths.resultPath, state);
  writeJsonFile(paths.latestPath, state);
  writeTextFile(paths.latestMarkdownPath, buildFeishuMarkdown(state));
  appendJsonLine(paths.historyPath, state);

  process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
  return 0;
}

function evaluateSchedulingPolicy({ persist = true } = {}) {
  const config = loadConfig();
  const policyConfig = getSchedulingPolicyConfig(config);
  const runId = `scheduling-policy-${nowIso().replace(/[-:]/g, "").replace(/\./g, "").replace("T", "-").replace("Z", "")}`;
  const paths = buildSchedulingPolicyArtifacts(runId);

  if (persist) {
    ensureDirectory(paths.runDir);
    ensureDirectory(paths.memoryRoot);
    trimOldRunDirectories(paths.runsRoot, getHarnessConfig(config).runsRetainDays);
  }

  const latestTrainingRunPath = path.join(rootDir, "state", "memory", "training-latest-run.json");
  const latestFeishuPath = path.join(rootDir, "state", "memory", "feishu-runtime-latest.json");
  const trainingHistoryPath = path.join(rootDir, "state", "memory", "training-history.jsonl");
  const latestTrainingRun = safeReadJson(latestTrainingRunPath);
  const latestFeishu = safeReadJson(latestFeishuPath);
  const trainingHistory = readJsonLines(trainingHistoryPath, policyConfig.historyScanLimit);
  const lastSuccessfulTraining = [...trainingHistory].reverse().find((entry) => entry?.outcome?.status === "ok") ?? null;

  const reasons = [];
  const warnings = [];
  let verdict = latestTrainingRun ? "allowed" : "unknown";
  let nextAction = "Scheduling signals look healthy enough for the next training dispatch.";

  const latestTrainingAgeSeconds = getAgeSeconds(latestTrainingRun?.updated_at);
  const feishuAgeSeconds = getAgeSeconds(latestFeishu?.generated_at);
  const feishuStale = latestFeishu
    ? feishuAgeSeconds === null || feishuAgeSeconds > policyConfig.feishuSnapshotMaxAgeSeconds
    : false;
  const lastSuccessfulTrainingAgeSeconds = getAgeSeconds(lastSuccessfulTraining?.generated_at);

  if (!latestTrainingRun) {
    verdict = "unknown";
    reasons.push("training_latest_run_missing");
    nextAction = "Run or inspect a harnessed training lane first so dispatch policy has a durable baseline.";
  }
  else if (["failed", "blocked"].includes(String(latestTrainingRun.lifecycle_status ?? "")) || ["failed", "blocked"].includes(String(latestTrainingRun.final_decision ?? ""))) {
    verdict = "degraded";
    reasons.push(`training_lane_${latestTrainingRun.lifecycle_status ?? latestTrainingRun.final_decision}`);
    nextAction = "Review the latest harness run before trusting the next scheduled training invocation.";
  }

  if (!lastSuccessfulTraining) {
    warnings.push("no_successful_training_found_in_recent_history");
  }

  if (!latestFeishu) {
    warnings.push("feishu_snapshot_missing");
  }
  else if (feishuStale) {
    warnings.push("feishu_snapshot_stale");
  }
  else if (latestFeishu.lifecycle_status === "blocked") {
    warnings.push("feishu_notifications_blocked");
  }
  else if (latestFeishu.lifecycle_status === "degraded") {
    warnings.push("feishu_notifications_degraded");
  }
  else if (latestFeishu.lifecycle_status === "recovering") {
    warnings.push("feishu_notifications_recovering");
  }

  if (verdict === "allowed" && warnings.includes("feishu_notifications_blocked")) {
    nextAction = "Training may still run, but notification delivery is blocked; repair Hermes/Feishu separately.";
  }
  else if (verdict === "allowed" && warnings.includes("feishu_snapshot_stale")) {
    nextAction = "Training looks healthy, but refresh Feishu supervision before trusting notification delivery state.";
  }

  const policy = {
    policy_version: 1,
    computed_at: nowIso(),
    lane: policyConfig.lane,
    mode: "report_only",
    verdict,
    execution_gate: "observe_only",
    reasons,
    warnings,
    next_action: nextAction,
    sources: {
      latest_training_run: {
        path: latestTrainingRunPath,
        exists: Boolean(latestTrainingRun),
        updated_at: latestTrainingRun?.updated_at ?? null,
        age_seconds: latestTrainingAgeSeconds,
        lifecycle_status: latestTrainingRun?.lifecycle_status ?? null,
        final_decision: latestTrainingRun?.final_decision ?? null,
        run_id: latestTrainingRun?.run_id ?? null
      },
      feishu_snapshot: {
        path: latestFeishuPath,
        exists: Boolean(latestFeishu),
        generated_at: latestFeishu?.generated_at ?? null,
        age_seconds: feishuAgeSeconds,
        stale: feishuStale,
        lifecycle_status: latestFeishu?.lifecycle_status ?? null,
        reason: latestFeishu?.reason ?? null
      },
      last_successful_training: {
        path: trainingHistoryPath,
        scanned_entries: trainingHistory.length,
        exists: Boolean(lastSuccessfulTraining),
        generated_at: lastSuccessfulTraining?.generated_at ?? null,
        age_seconds: lastSuccessfulTrainingAgeSeconds,
        requested_date: lastSuccessfulTraining?.requested_date ?? null,
        outcome_status: lastSuccessfulTraining?.outcome?.status ?? null,
        run_id: lastSuccessfulTraining?.harness?.run_id ?? null
      }
    }
  };

  if (persist) {
    writeJsonFile(paths.resultPath, policy);
    writeJsonFile(paths.latestPath, policy);
    writeTextFile(paths.latestMarkdownPath, buildSchedulingPolicyMarkdown(policy));
    appendJsonLine(paths.historyPath, policy);
  }

  return { policy, paths };
}

function runSchedulingPolicyEvaluation() {
  const result = evaluateSchedulingPolicy({ persist: true });
  process.stdout.write(`${JSON.stringify(result.policy, null, 2)}\n`);
  return 0;
}

function runAutonomyLoop() {
  const config = loadConfig();
  const loopConfig = getAutonomyLoopConfig(config);
  const runId = `autonomy-loop-${nowIso().replace(/[-:]/g, "").replace(/\./g, "").replace("T", "-").replace("Z", "")}`;
  const paths = buildAutonomyLoopArtifacts(runId);
  ensureDirectory(paths.runDir);
  ensureDirectory(paths.memoryRoot);
  trimOldRunDirectories(paths.runsRoot, getHarnessConfig(config).runsRetainDays);

  const schedulingPolicy = evaluateSchedulingPolicy({ persist: true }).policy;
  const baseline = buildAutonomyBaseline(loopConfig);
  const plan = buildImprovementPlan(config, baseline, schedulingPolicy);
  const evaluation = buildAutonomyEvaluation(baseline, schedulingPolicy, plan);

  const result = {
    generated_at: nowIso(),
    mode: "recommend_only",
    next_action: plan.summary.total_candidates > 0
      ? "Use the ranked candidates to drive the next bounded RanchMind improvement change, then rerun the loop after validation."
      : "No obvious improvement candidates were detected from the current structured signals.",
    scheduling_policy: schedulingPolicy,
    baseline,
    plan,
    evaluation
  };

  writeJsonFile(paths.baselinePath, baseline);
  writeJsonFile(paths.planPath, plan);
  writeJsonFile(paths.evaluationPath, evaluation);
  writeJsonFile(paths.resultPath, result);
  writeJsonFile(paths.latestPath, result);
  writeTextFile(paths.latestMarkdownPath, buildAutonomyLoopMarkdown(result));
  appendJsonLine(paths.historyPath, result);

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return 0;
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

function buildWindowsQmtTaskXml(taskPath, taskName, taskTime) {
  const { hour, minute } = parseTimeText(taskTime);
  const paddedHour = String(hour).padStart(2, "0");
  const paddedMinute = String(minute).padStart(2, "0");
  const now = new Date();
  const startBoundary = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}T${paddedHour}:${paddedMinute}:00`;
  const userId = process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}` : process.env.USERNAME;
  const taskUri = `${ensureWindowsTaskPath(taskPath)}${taskName}`;
  const command = process.execPath;
  const scriptPath = path.join(rootDir, "scripts", "ranchmind.mjs");
  const argumentsText = `${windowsQuote(scriptPath)} run-qmt --source scheduled_task`;

  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>RanchMind harness-driven QMT overnight notify orchestrator.</Description>
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
    <ExecutionTimeLimit>PT2H</ExecutionTimeLimit>
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

function registerQmtTask() {
  if (platform !== "win32") {
    throw new Error("QMT task registration is currently implemented for Windows only.");
  }

  const config = loadConfig();
  if (!config.qmt) {
    throw new Error("QMT lane is not configured. Add a 'qmt' block to ranchmind.config.json.");
  }

  const schedulerConfig = getQmtSchedulerConfig(config);
  if (!schedulerConfig) {
    throw new Error("No QMT scheduler is configured in ranchmind.config.json under qmt.scheduler.");
  }

  const taskTime = parseFlag("--task-time") ?? schedulerConfig.taskTime ?? "14:30";
  const taskPath = schedulerConfig.taskPath ?? "\\RanchMind\\";
  const taskName = schedulerConfig.taskName ?? "RanchMindOvernightQmtDaily";
  const fullName = `${ensureWindowsTaskPath(taskPath)}${taskName}`;
  const xmlPath = path.join(rootDir, "state", "tmp", "ranchmind-qmt-task.xml");
  ensureDirectory(path.dirname(xmlPath));
  fs.writeFileSync(xmlPath, `\uFEFF${buildWindowsQmtTaskXml(taskPath, taskName, taskTime)}`, "utf16le");

  const createResult = runCommand("schtasks.exe", ["/Create", "/TN", fullName, "/XML", xmlPath, "/F"]);
  fs.rmSync(xmlPath, { force: true });
  commandOrThrow(createResult, "Failed to create QMT Windows Scheduled Task");

  const query = getTaskQuery(taskPath, taskName);
  process.stdout.write(`${JSON.stringify({
    status: "ok",
    kind: "windows-task",
    task_path: ensureWindowsTaskPath(taskPath),
    task_name: taskName,
    task_time: taskTime,
    principal_logon_type: "S4U",
    entrypoint: {
      command: process.execPath,
      script: path.join(rootDir, "scripts", "ranchmind.mjs"),
      args: ["run-qmt", "--source", "scheduled_task"]
    },
    query
  }, null, 2)}\n`);
  return 0;
}

function registerFeishuWatchdog() {
  if (platform !== "win32") {
    throw new Error("Feishu watchdog registration is currently implemented for Windows only.");
  }

  const config = loadConfig();
  const watchdogConfig = getFeishuWatchdogConfig(config);
  const xmlPath = path.join(rootDir, "state", "tmp", "ranchmind-feishu-watchdog.xml");
  ensureDirectory(path.dirname(xmlPath));
  const argumentsText = `${windowsQuote(path.join(rootDir, "scripts", "ranchmind.mjs"))} ensure-feishu-runtime`;
  const xml = buildWindowsRepeatedTaskXml(
    watchdogConfig.taskPath,
    watchdogConfig.taskName,
    watchdogConfig.taskTime,
    watchdogConfig.repeatMinutes,
    "RanchMind Feishu runtime watchdog.",
    process.execPath,
    argumentsText,
    rootDir
  );

  fs.writeFileSync(xmlPath, `\uFEFF${xml}`, "utf16le");
  const fullName = `${ensureWindowsTaskPath(watchdogConfig.taskPath)}${watchdogConfig.taskName}`;
  const createResult = runCommand("schtasks.exe", ["/Create", "/TN", fullName, "/XML", xmlPath, "/F"]);
  fs.rmSync(xmlPath, { force: true });
  commandOrThrow(createResult, "Failed to create Feishu watchdog task");

  const query = getTaskQuery(watchdogConfig.taskPath, watchdogConfig.taskName);
  process.stdout.write(`${JSON.stringify({
    status: "ok",
    kind: "windows-task",
    task_path: ensureWindowsTaskPath(watchdogConfig.taskPath),
    task_name: watchdogConfig.taskName,
    task_time: watchdogConfig.taskTime,
    repeat_minutes: watchdogConfig.repeatMinutes,
    entrypoint: {
      command: process.execPath,
      script: path.join(rootDir, "scripts", "ranchmind.mjs"),
      args: ["ensure-feishu-runtime"]
    },
    query
  }, null, 2)}\n`);
  return 0;
}

function status() {
  const config = loadConfig();
  const summary = summarizeLatestReceipt();
  const latestMarkdownPath = path.join(rootDir, "state", "memory", "training-latest.md");
  const latestRunPath = path.join(rootDir, "state", "memory", "training-latest-run.json");
  const latestFeishuPath = path.join(rootDir, "state", "memory", "feishu-runtime-latest.json");
  const latestAutonomyLoopPath = path.join(rootDir, "state", "memory", "autonomy-loop-latest.json");
  const latestQmtRunPath = path.join(rootDir, "state", "memory", "qmt-latest-run.json");
  const latestRun = fs.existsSync(latestRunPath) ? readJson(latestRunPath) : null;
  const latestFeishu = fs.existsSync(latestFeishuPath) ? readJson(latestFeishuPath) : null;
  const latestAutonomyLoop = fs.existsSync(latestAutonomyLoopPath) ? readJson(latestAutonomyLoopPath) : null;
  const latestQmtRun = fs.existsSync(latestQmtRunPath) ? readJson(latestQmtRunPath) : null;
  const schedulingPolicy = evaluateSchedulingPolicy({ persist: false });
  const hermesConfig = getHermesConfig(config);
  const watchdogConfig = getFeishuWatchdogConfig(config);
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

  const qmtSchedulerConfig = getQmtSchedulerConfig(config);
  let qmtSchedulerStatus = { kind: "none", exists: false };
  if (qmtSchedulerConfig?.kind === "windows-task") {
    qmtSchedulerStatus = getTaskQuery(qmtSchedulerConfig.taskPath, qmtSchedulerConfig.taskName);
  }

  process.stdout.write(`${JSON.stringify({
    ranchmind_root: rootDir,
    platform,
    latest_receipt_path: summary.latestReceiptPath,
    latest_markdown_path: latestMarkdownPath,
    latest_run_path: latestRunPath,
    latest_receipt: summary.latestReceiptSummary ?? null,
    latest_harness_run: latestRun,
    latest_feishu_runtime: latestFeishu,
    latest_autonomy_loop: latestAutonomyLoop,
    latest_qmt_run: latestQmtRun,
    qmt_scheduler: qmtSchedulerStatus,
    scheduling_policy: schedulingPolicy.policy,
    scheduling_policy_paths: {
      latest_state_path: schedulingPolicy.paths.latestPath,
      latest_markdown_path: schedulingPolicy.paths.latestMarkdownPath,
      history_path: schedulingPolicy.paths.historyPath
    },
    scheduler: schedulerStatus,
    hermes: {
      task_name: hermesConfig?.taskName ?? "",
      gateway_log: hermesLogPath,
      gateway_log_tail: hermesLogTail
    },
    feishu_watchdog: {
      task: getTaskQuery(watchdogConfig.taskPath, watchdogConfig.taskName),
      latest_state_path: latestFeishuPath
    }
  }, null, 2)}\n`);
  return 0;
}

function help() {
  console.log("RanchMind commands:");
  console.log("  node ./scripts/ranchmind.mjs run-training [--date YYYY-MM-DD] [--force] [--source TEXT]");
  console.log("  node ./scripts/ranchmind.mjs register-training [--task-time HH:mm] [--disable-legacy]");
  console.log("  node ./scripts/ranchmind.mjs run-qmt [--date YYYY-MM-DD] [--dry-run] [--source TEXT]");
  console.log("  node ./scripts/ranchmind.mjs register-qmt [--task-time HH:mm]");
  console.log("  node ./scripts/ranchmind.mjs evaluate-scheduling");
  console.log("  node ./scripts/ranchmind.mjs run-autonomy-loop");
  console.log("  node ./scripts/ranchmind.mjs ensure-feishu-runtime");
  console.log("  node ./scripts/ranchmind.mjs register-feishu-watchdog");
  console.log("  node ./scripts/ranchmind.mjs serve [--port 3000]");
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

  if (command === "run-qmt") {
    return runQmtHarness();
  }

  if (command === "register-qmt") {
    return registerQmtTask();
  }

  if (command === "evaluate-scheduling") {
    return runSchedulingPolicyEvaluation();
  }

  if (command === "run-autonomy-loop") {
    return runAutonomyLoop();
  }

  if (command === "ensure-feishu-runtime") {
    return ensureFeishuRuntime();
  }

  if (command === "register-feishu-watchdog") {
    return registerFeishuWatchdog();
  }

  if (command === "status") {
    return status();
  }

  if (command === "serve") {
    const port = parseFlag("--port") ?? "3000";
    const serverPath = path.join(rootDir, "apps", "human-plane", "server.mjs");
    console.log(`Starting Human Plane Dashboard on port ${port}...`);
    const proc = spawnSync(process.execPath, [serverPath], {
      cwd: rootDir,
      stdio: "inherit",
      env: { ...process.env, PORT: port }
    });
    return proc.status ?? 0;
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
