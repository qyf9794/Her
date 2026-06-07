#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const args = new Set(process.argv.slice(2));
const valueArg = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
};

const auditPath = path.resolve(valueArg("--path", path.join(process.cwd(), "data", "audit.jsonl")));
const follow = args.has("--follow") || (!args.has("--all") && !args.has("--summary"));
const showAll = args.has("--all");
const json = args.has("--json");
const summary = args.has("--summary");
const limit = Number(valueArg("--limit", showAll ? "0" : "80"));
const actionFilter = valueArg("--action", "");
const statusFilter = new Set(
  valueArg("--status", "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean),
);

let offset = 0;
let partial = "";
const counts = new Map();
const errors = [];

const colors = {
  started: "\x1b[36m",
  queued: "\x1b[34m",
  running: "\x1b[35m",
  backoff: "\x1b[33m",
  ok: "\x1b[32m",
  needs_confirmation: "\x1b[33m",
  rejected: "\x1b[31m",
  cancelled: "\x1b[90m",
  error: "\x1b[31m",
  reset: "\x1b[0m",
};

const readExistingLines = () => {
  if (!fs.existsSync(auditPath)) return [];
  const content = fs.readFileSync(auditPath, "utf8");
  offset = Buffer.byteLength(content);
  const lines = content.split(/\r?\n/).filter(Boolean);
  if (!limit || lines.length <= limit) return lines;
  return lines.slice(-limit);
};

const readNewLines = () => {
  if (!fs.existsSync(auditPath)) return [];
  const size = fs.statSync(auditPath).size;
  if (size < offset) {
    offset = 0;
    partial = "";
  }
  if (size === offset) return [];
  const fd = fs.openSync(auditPath, "r");
  const buffer = Buffer.alloc(size - offset);
  fs.readSync(fd, buffer, 0, buffer.length, offset);
  fs.closeSync(fd);
  offset = size;
  const text = partial + buffer.toString("utf8");
  const lines = text.split(/\r?\n/);
  partial = lines.pop() ?? "";
  return lines.filter(Boolean);
};

const parseLine = (line) => {
  try {
    return JSON.parse(line);
  } catch {
    return {
      timestamp: new Date().toISOString(),
      action: "audit.parse",
      status: "error",
      summary: `Could not parse audit line: ${line.slice(0, 160)}`,
    };
  }
};

const matches = (event) => {
  if (actionFilter && !String(event.action ?? "").includes(actionFilter)) return false;
  if (statusFilter.size && !statusFilter.has(String(event.status ?? ""))) return false;
  return true;
};

const printEvent = (event) => {
  if (!matches(event)) return;
  counts.set(event.status, (counts.get(event.status) ?? 0) + 1);
  if (event.status === "error" || event.status === "backoff") errors.push(event);

  if (json) {
    console.log(JSON.stringify(event));
    return;
  }

  const color = colors[event.status] ?? "";
  const reset = color ? colors.reset : "";
  const details = compactDetails(event.details);
  console.log(
    `${event.timestamp ?? ""} ${color}${pad(String(event.status ?? ""), 18)}${reset} ${pad(String(event.action ?? ""), 28)} ${event.summary ?? ""}${details}`,
  );
};

const compactDetails = (details) => {
  if (!details || json) return "";
  const interesting = [
    "taskId",
    "toolName",
    "source",
    "attempt",
    "attempts",
    "confirmationId",
    "delayMs",
    "error",
    "maxOutputTokens",
    "realtimeModel",
  ];
  const picked = Object.fromEntries(
    interesting
      .filter((key) => Object.prototype.hasOwnProperty.call(details, key) && typeof details[key] !== "undefined")
      .map((key) => [key, details[key]]),
  );
  const serialized = JSON.stringify(picked);
  return serialized && serialized !== "{}" ? ` ${serialized}` : "";
};

const printSummary = () => {
  const events = readExistingLines().map(parseLine).filter(matches);
  const byStatus = new Map();
  const byAction = new Map();
  for (const event of events) {
    byStatus.set(event.status, (byStatus.get(event.status) ?? 0) + 1);
    byAction.set(event.action, (byAction.get(event.action) ?? 0) + 1);
  }
  console.log(`Audit file: ${auditPath}`);
  console.log(`Events: ${events.length}`);
  console.log("By status:");
  for (const [status, count] of [...byStatus.entries()].sort()) console.log(`  ${pad(String(status), 18)} ${count}`);
  console.log("Top actions:");
  for (const [action, count] of [...byAction.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
    console.log(`  ${pad(String(action), 28)} ${count}`);
  }
};

const pad = (value, size) => value.length >= size ? value : `${value}${" ".repeat(size - value.length)}`;

if (summary) {
  printSummary();
  process.exit(0);
}

console.log(`Monitoring audit log: ${auditPath}`);
for (const line of readExistingLines()) printEvent(parseLine(line));

if (follow) {
  if (!fs.existsSync(auditPath)) {
    fs.mkdirSync(path.dirname(auditPath), { recursive: true });
    fs.closeSync(fs.openSync(auditPath, "a"));
  }
  fs.watchFile(auditPath, { interval: 500 }, () => {
    for (const line of readNewLines()) printEvent(parseLine(line));
  });
  process.on("SIGINT", () => {
    if (!json) {
      console.log("\nSession summary:");
      for (const [status, count] of [...counts.entries()].sort()) console.log(`  ${pad(String(status), 18)} ${count}`);
      const recentIssues = errors.slice(-5);
      if (recentIssues.length) {
        console.log("Recent issues:");
        for (const event of recentIssues) console.log(`  ${event.timestamp} ${event.action}: ${event.summary}`);
      }
    }
    process.exit(0);
  });
}
