#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

function resolveScript(...segments) {
  return path.join(rootDir, ...segments);
}

function runPowerShell(scriptPath, args) {
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, ...args],
    {
      cwd: rootDir,
      encoding: "utf8"
    }
  );

  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }

  if (result.error) {
    return 1;
  }

  return result.status ?? 1;
}

function parseFlag(flag) {
  const index = process.argv.indexOf(flag);
  if (index === -1) {
    return null;
  }
  return process.argv[index + 1] ?? null;
}

async function main() {
  const command = process.argv[2];
  const horseScripts = ["packages", "horse-plane", "scripts"];

  if (!command || command === "help" || command === "--help" || command === "-h") {
    console.log("RanchMind commands:");
    console.log("  node scripts/ranchmind.mjs run-training [--date YYYY-MM-DD] [--force] [--source TEXT]");
    console.log("  node scripts/ranchmind.mjs register-training [--task-time HH:mm] [--disable-legacy]");
    console.log("  node scripts/ranchmind.mjs status");
    process.exit(0);
  }

  if (command === "run-training") {
    const scriptPath = resolveScript(...horseScripts, "Invoke-RanchMindNonTradingTraining.ps1");
    const date = parseFlag("--date");
    const source = parseFlag("--source");
    const args = [];
    if (date) {
      args.push("-Date", date);
    }
    if (source) {
      args.push("-InvocationSource", source);
    }
    if (process.argv.includes("--force")) {
      args.push("-Force");
    }
    const code = runPowerShell(scriptPath, args);
    process.exit(code);
  }

  if (command === "register-training") {
    const scriptPath = resolveScript(...horseScripts, "Register-RanchMindNonTradingTrainingTask.ps1");
    const taskTime = parseFlag("--task-time");
    const args = [];
    if (taskTime) {
      args.push("-TaskTime", taskTime);
    }
    if (process.argv.includes("--disable-legacy")) {
      args.push("-DisableLegacyKdTask");
    }
    const code = runPowerShell(scriptPath, args);
    process.exit(code);
  }

  if (command === "status") {
    const scriptPath = resolveScript(...horseScripts, "Get-RanchMindStatus.ps1");
    const code = runPowerShell(scriptPath, []);
    process.exit(code);
  }

  console.error(`Unknown RanchMind command: ${command}`);
  process.exit(1);
}

main();
