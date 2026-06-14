#!/usr/bin/env node

import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  allToolDefinitions,
} = require("../electron/dist/main/tools/metadata.js");
const { allToolDefinitions: sharedToolDefinitions } = require("../electron/dist/shared/tools.js");
const {
  toolManifest,
  toolRiskByName,
  toolRequiresConfirmation,
  toolBundles,
  manifestRealtimeToolDefinitions,
} = require("../electron/dist/main/tools/manifest.js");
const { ApprovalPolicy } = require("../electron/dist/main/policy/approval-policy.js");
const { ConfirmationQueue } = require("../electron/dist/main/tools/confirmation.js");
const { ToolRegistry } = require("../electron/dist/main/tools/registry.js");
const { domainManifests } = require("../electron/dist/main/tools/domain-manifests.js");
const { toolHandlerNames } = require("../electron/dist/main/tools/handlers.js");
const { toolSchemas } = require("../electron/dist/main/tools/schemas.js");
const { summarizeToolCall } = require("../electron/dist/main/tools/summaries.js");
const { AuditLog } = require("../electron/dist/main/audit.js");
const { MemoryStore } = require("../electron/dist/main/memory-store.js");
const { CapabilityGate } = require("../electron/dist/main/capability-gate.js");
const { SettingsStore } = require("../electron/dist/main/settings-store.js");

const failures = [];
const fail = (message) => failures.push(message);

const definitionNames = allToolDefinitions.map((definition) => definition.name);
if (allToolDefinitions === sharedToolDefinitions) fail("M2 manifest metadata must not use shared static tool definitions as its source object.");
const uniqueNames = new Set(definitionNames);
if (uniqueNames.size !== definitionNames.length) fail("Tool names are not unique.");
const handlerNames = new Set(toolHandlerNames);
if (handlerNames.size !== toolHandlerNames.length) fail("Tool handler names are not unique.");

for (const name of definitionNames) {
  const entry = toolManifest[name];
  if (!entry) {
    fail(`${name} is missing from toolManifest.`);
    continue;
  }
  for (const field of ["title", "description", "bundle", "risk", "parameters", "schema", "summarize", "handler"]) {
    if (!entry[field]) fail(`${name} manifest is missing ${field}.`);
  }
  if (typeof entry.summarize !== "function") fail(`${name} manifest summarize must be a function.`);
  if (typeof entry.handler !== "function") fail(`${name} manifest handler must be a function.`);
  if (entry.schema !== toolSchemas[name]) fail(`${name} manifest schema does not reference toolSchemas.`);
  if (!handlerNames.has(name)) fail(`${name} is missing from explicit toolHandlerNames.`);
  if (!toolRiskByName[name]) fail(`${name} is missing toolRiskByName.`);
}

for (const bundle of ["core", "filesystem", "documents", "comms", "media", "desktop", "browser", "shell"]) {
  if (!toolBundles[bundle]) fail(`Missing tool bundle metadata: ${bundle}`);
  if (!domainManifests[bundle]) fail(`Missing domain manifest: ${bundle}`);
  for (const [name, entry] of Object.entries(domainManifests[bundle] ?? {})) {
    if (toolManifest[name] !== entry) fail(`${bundle} domain manifest entry for ${name} does not reference central manifest.`);
  }
}

const sampleSummaryArgs = { path: "/tmp/example.txt", maxChars: 2000 };
if (toolManifest.file_read.summarize(sampleSummaryArgs) !== summarizeToolCall("file_read", sampleSummaryArgs)) {
  fail("Manifest file_read summary is not generated from tool summaries.");
}

const realtimeManifestNames = new Set(manifestRealtimeToolDefinitions.map((definition) => definition.name));
if (realtimeManifestNames.size !== manifestRealtimeToolDefinitions.length) {
  fail("Manifest-generated Realtime tool names are not unique.");
}
for (const definition of manifestRealtimeToolDefinitions) {
  const entry = toolManifest[definition.name];
  if (!entry) fail(`${definition.name} Realtime definition is missing from manifest.`);
  if (entry && definition.description !== (entry.realtimeDescription ?? entry.description)) {
    fail(`${definition.name} Realtime description is not generated from manifest metadata.`);
  }
  if (entry && definition.parameters !== entry.parameters) {
    fail(`${definition.name} Realtime parameters are not generated from manifest metadata.`);
  }
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

const systemStatus = await registry.execute({ name: "system_status", arguments: {}, source: "local" });
if (!systemStatus.ok || systemStatus.requiresConfirmation || !systemStatus.result) {
  fail(`Read-only manifest-bound handler did not execute directly: ${JSON.stringify(systemStatus)}`);
}

const highRiskRegistry = new ToolRegistry(
  new ConfirmationQueue(),
  new AuditLog(),
  { assertToolAllowed: async () => {}, authorizedAppNames: async () => new Set() },
  undefined,
  new MemoryStore(path.join(tmpRoot, "high-risk-memory")),
);
const highRiskConfirmation = await highRiskRegistry.execute({
  name: "file_trash",
  arguments: { path: "/tmp/example.txt" },
  source: "local",
});
if (!highRiskConfirmation.ok || !highRiskConfirmation.requiresConfirmation || !highRiskConfirmation.confirmationId) {
  fail(`High-risk manifest-bound handler did not require confirmation: ${JSON.stringify(highRiskConfirmation)}`);
}

const disabledSettings = new SettingsStore(path.join(tmpRoot, "disabled-capability"));
disabledSettings.setCapabilities({ fileManagement: false, systemOperations: true });
const disabledGate = new CapabilityGate(disabledSettings, async () => []);
const disabledRegistry = new ToolRegistry(
  new ConfirmationQueue(),
  new AuditLog(),
  disabledGate,
  undefined,
  new MemoryStore(path.join(tmpRoot, "disabled-memory")),
);
const disabledCapability = await disabledRegistry.execute({
  name: "file_read",
  arguments: { path: "/tmp/example.txt" },
  source: "local",
});
if (disabledCapability.ok || disabledCapability.code !== "capability_denied") {
  fail(`Disabled capability was not denied: ${JSON.stringify(disabledCapability)}`);
}

const unauthorizedSettings = new SettingsStore(path.join(tmpRoot, "unauthorized-app"));
unauthorizedSettings.setCapabilities({ systemOperations: true });
const unauthorizedGate = new CapabilityGate(unauthorizedSettings, async () => [{
  name: "UntrustedApp",
  path: "/Applications/UntrustedApp.app",
  bundleId: "com.example.untrusted",
  executable: "UntrustedApp",
  iconUrl: "",
  scriptable: false,
  risk: "high",
  capabilities: ["open"],
  recommended: false,
  authorized: false,
}]);
const unauthorizedRegistry = new ToolRegistry(
  new ConfirmationQueue(),
  new AuditLog(),
  unauthorizedGate,
  undefined,
  new MemoryStore(path.join(tmpRoot, "unauthorized-memory")),
);
const unauthorizedApp = await unauthorizedRegistry.execute({
  name: "app_open",
  arguments: { appName: "UntrustedApp" },
  source: "local",
});
if (unauthorizedApp.ok || unauthorizedApp.code !== "capability_denied") {
  fail(`Unauthorized app was not denied: ${JSON.stringify(unauthorizedApp)}`);
}

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
    domainManifests: Object.keys(domainManifests).length,
    realtimeToolDefinitions: manifestRealtimeToolDefinitions.length,
    approvalPolicy: true,
    actionPlanConfirmation: true,
    schemaValidation: true,
    manifestSchemaOwnership: true,
    manifestSummaryOwnership: true,
    explicitHandlerNames: toolHandlerNames.length,
    manifestHandlerExecution: true,
    highRiskRuntimeConfirmation: true,
    disabledCapabilityDenied: true,
    unauthorizedAppDenied: true,
  },
}, null, 2));
