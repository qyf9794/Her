#!/usr/bin/env node

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  manifestRealtimeToolDefinitions,
  manifestRealtimeToolDefinitionsForBundles,
  toolManifest,
  toolRequiresConfirmation,
} = require("../electron/dist/main/tools/manifest.js");
const { selectToolBundles } = require("../electron/dist/main/agent/tool-bundle-router.js");
const { createRealtimeSessionConfig, createRealtimeClientSecretSession } = require("../electron/dist/shared/realtime-config.js");

const failures = [];
const fail = (message) => failures.push(message);

const requiredCoreTools = [
  "system_status",
  "confirmation_list",
  "confirmation_decide",
  "app_permission_search",
  "app_permission_set",
  "capability_set",
  "yolo_mode_set",
  "her_select_bundle",
];

const coreNames = manifestRealtimeToolDefinitions.map((definition) => definition.name);
for (const name of requiredCoreTools) {
  if (!coreNames.includes(name)) fail(`Core Realtime tools missing ${name}.`);
}
if (manifestRealtimeToolDefinitions.length >= Object.keys(toolManifest).length) {
  fail("Core Realtime tools must not expose the full manifest.");
}

const cases = [
  { text: "帮我把这个文件夹里的 pdf 文档总结一下", bundles: ["file", "document"] },
  { text: "打开网页填写表单并点击提交", bundles: ["browser"] },
  { text: "给 Alex 写一封邮件并安排明天会议", bundles: ["comms"] },
  { text: "播放 YouTube 上的 lofi 视频", bundles: ["media"] },
  { text: "把窗口排列好然后打开系统设置", bundles: ["desktop", "system"] },
  { text: "在这个 repo 里跑测试并检查 PR", bundles: ["coding"] },
];

for (const testCase of cases) {
  const selection = selectToolBundles(testCase.text);
  for (const bundle of testCase.bundles) {
    if (!selection.bundles.includes(bundle)) {
      fail(`Transcript "${testCase.text}" did not select bundle ${bundle}: ${JSON.stringify(selection)}`);
    }
  }
  if (selection.shouldAskModelToSelect) {
    fail(`Transcript "${testCase.text}" should not fall back to her_select_bundle: ${JSON.stringify(selection)}`);
  }
}

const lowConfidence = selectToolBundles("帮我处理一下");
if (!lowConfidence.shouldAskModelToSelect || lowConfidence.bundles.length !== 1 || lowConfidence.bundles[0] !== "core") {
  fail(`Low-confidence transcript should fall back to core + her_select_bundle: ${JSON.stringify(lowConfidence)}`);
}

const browserTools = manifestRealtimeToolDefinitionsForBundles(["browser"]);
const browserToolNames = browserTools.map((definition) => definition.name);
if (!browserToolNames.includes("browser_click")) fail("Browser bundle should expose browser_click.");
if (!browserToolNames.includes("her_select_bundle")) fail("Dynamic bundles should keep core her_select_bundle available.");
if (browserTools.length >= Object.keys(toolManifest).length) fail("Browser bundle must not expose all tools.");

const codingTools = manifestRealtimeToolDefinitionsForBundles(["coding"]);
if (!codingTools.some((definition) => definition.name === "codex_task_run")) fail("Coding bundle should expose codex_task_run.");

if (!toolRequiresConfirmation("browser_click")) fail("High-risk browser_click should still require confirmation.");
if (!toolRequiresConfirmation("codex_task_run")) fail("High-risk codex_task_run should still require confirmation.");

const clientConfig = createRealtimeSessionConfig("marin");
if (clientConfig.audio.input.turnDetection.createResponse !== false) {
  fail("Client Realtime session config must use createResponse=false.");
}
const secretSession = createRealtimeClientSecretSession({
  model: "gpt-realtime-2",
  voice: "marin",
  instructions: "test",
});
if (secretSession.audio.input.turn_detection.create_response !== false) {
  fail("Client-secret Realtime session config must use create_response=false.");
}

if (failures.length) {
  console.error(JSON.stringify({ ok: false, failures }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({
  ok: true,
  checked: {
    coreRealtimeTools: manifestRealtimeToolDefinitions.length,
    manifestTools: Object.keys(toolManifest).length,
    deterministicCases: cases.length,
    lowConfidenceFallback: true,
    dynamicBrowserTools: browserTools.length,
    createResponseFalse: true,
    highRiskPolicyPreserved: true,
  },
}, null, 2));
