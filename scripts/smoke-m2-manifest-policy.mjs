#!/usr/bin/env node

import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  allToolDefinitions,
} = require("../electron/dist/shared/tools.js");
const {
  toolManifest,
  toolRiskByName,
  toolRequiresConfirmation,
  toolBundles,
} = require("../electron/dist/main/tools/manifest.js");
const { ApprovalPolicy } = require("../electron/dist/main/policy/approval-policy.js");
const { ConfirmationQueue } = require("../electron/dist/main/tools/confirmation.js");
const { ToolRegistry } = require("../electron/dist/main/tools/registry.js");
const { AuditLog } = require("../electron/dist/main/audit.js");
const { MemoryStore } = require("../electron/dist/main/memory-store.js");

const failures = [];
const fail = (message) => failures.push(message);

const definitionNames = allToolDefinitions.map((definition) => definition.name);
const uniqueNames = new Set(definitionNames);
if (uniqueNames.size !== definitionNames.length) fail("Tool names are not unique.");

for (const name of definitionNames) {
  const entry = toolManifest[name];
  if (!entry) {
    fail(`${name} is missing from toolManifest.`);
    continue;
  }
  for (const field of ["title", "description", "bundle", "risk", "parameters"]) {
    if (!entry[field]) fail(`${name} manifest is missing ${field}.`);
  }
  if (!toolRiskByName[name]) fail(`${name} is missing toolRiskByName.`);
}

for (const bundle of ["core", "filesystem", "documents", "comms", "media", "desktop", "browser", "shell"]) {
  if (!toolBundles[bundle]) fail(`Missing tool bundle metadata: ${bundle}`);
}

const policy = new ApprovalPolicy();
const readDecision = policy.decide({
  toolName: "file_read",
  args: { path: "/tmp/example.txt" },
  summary: "Read file",
  yoloMode: false,
});
if (readDecision.type !== "allow") fail(`file_read should be allowed without confirmation, got ${readDecision.type}.`);

const writeDecision = policy.decide({
  toolName: "file_trash",
  args: { path: "/tmp/example.txt" },
  summary: "Trash file",
  yoloMode: false,
});
if (writeDecision.type !== "require_confirmation") fail(`file_trash should require confirmation, got ${writeDecision.type}.`);
if (writeDecision.type === "require_confirmation" && writeDecision.plan.risk !== "local_write") {
  fail(`file_trash plan risk should be local_write, got ${writeDecision.plan.risk}.`);
}

const shellDecision = policy.decide({
  toolName: "advanced_shell_command",
  args: { command: "pwd", reason: "smoke" },
  summary: "Run shell",
  yoloMode: true,
});
if (shellDecision.type !== "require_confirmation") fail("YOLO must not bypass shell confirmation.");

if (!toolRequiresConfirmation("advanced_shell_command")) fail("advanced_shell_command should require confirmation.");
if (toolRequiresConfirmation("file_read")) fail("file_read should not require confirmation.");

const queue = new ConfirmationQueue();
if (writeDecision.type === "require_confirmation") {
  const pending = queue.add(writeDecision.plan);
  if (typeof pending.run !== "undefined") fail("Pending confirmation must not store a run closure.");
  const decided = await queue.decide(pending.id, true);
  if (decided.rejected || decided.plan.toolName !== "file_trash") fail("Confirmation approval should return the original ActionPlan.");
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "her-m2-smoke-"));
const registry = new ToolRegistry(
  new ConfirmationQueue(),
  new AuditLog(),
  { assertToolAllowed: async () => {}, authorizedAppNames: async () => new Set() },
  undefined,
  new MemoryStore(tmpRoot),
);
const invalid = await registry.execute({ name: "file_read", arguments: {}, source: "local" });
if (invalid.ok || invalid.code !== "invalid_arguments") fail(`Invalid schema arguments were not rejected: ${JSON.stringify(invalid)}`);

if (failures.length) {
  console.error(JSON.stringify({ ok: false, failures }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({
  ok: true,
  checked: {
    toolDefinitions: definitionNames.length,
    manifestEntries: Object.keys(toolManifest).length,
    bundles: Object.keys(toolBundles).length,
    approvalPolicy: true,
    actionPlanConfirmation: true,
    schemaValidation: true,
  },
}, null, 2));
