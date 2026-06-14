#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

process.env.HER_TOOL_QUEUE_MAX_CREATES_PER_MINUTE = "120";
process.env.HER_TOOL_QUEUE_MIN_START_INTERVAL_MS = "0";
process.env.HER_TOOL_QUEUE_BACKOFF_BASE_MS = "250";
process.env.HER_TOOL_QUEUE_BACKOFF_MAX_MS = "500";
process.env.HER_TOOL_QUEUE_TASK_TIMEOUT_MS = "1000";

const require = createRequire(import.meta.url);
const root = path.resolve(new URL("..", import.meta.url).pathname);
const distRegistryPath = path.join(root, "electron", "dist", "main", "tools", "registry.js");

if (!fs.existsSync(distRegistryPath)) {
  console.error("Missing compiled Electron main output. Run `tsc -p electron/tsconfig.json` first.");
  process.exit(1);
}

const { ToolRegistry } = require("../electron/dist/main/tools/registry.js");
const { ConfirmationQueue } = require("../electron/dist/main/tools/confirmation.js");
const { AuditLog } = require("../electron/dist/main/audit.js");
const { MemoryStore } = require("../electron/dist/main/memory-store.js");
const {
  allToolDefinitions,
  coreRealtimeToolNames,
  queueManagedToolDefinitions,
  toolGroupByName,
  toolGroups,
} = require("../electron/dist/main/tools/metadata.js");
const { manifestRealtimeToolDefinitions } = require("../electron/dist/main/tools/manifest.js");

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "her-tool-routing-"));
const sampleFile = path.join(tmpRoot, "sample.txt");
fs.writeFileSync(sampleFile, "HER tool routing smoke test fixture.\n", "utf8");

const samples = {
  system_status: {},
  confirmation_list: {},
  confirmation_decide: { approved: false },
  tool_result_read: { handle: "missing-routing-smoke-handle", offset: 0, maxChars: 200 },
  tool_catalog_list: {},
  tool_group_set: { group: "files", enabled: true },
  task_create: { toolName: "file_list", arguments: { path: tmpRoot }, priority: "normal", runAfterMs: 0 },
  task_status: { taskId: "missing-routing-smoke-task" },
  task_list: { limit: 10 },
  task_cancel: { taskId: "missing-routing-smoke-task" },
  task_route: { userRequest: "Open Google Chrome and search for HER local routing.", preference: "auto" },
  intent_route: {
    intent: {
      originalText: "播放钢琴曲",
      intent: "play_music",
      complexity: "simple",
      domain: "media",
      action: "play",
      entities: { query: "钢琴曲" },
      toolName: "music_play_song",
      toolArguments: { query: "钢琴曲" },
      candidateTools: ["music_play_song"],
      missingInfo: [],
      confidence: 0.92,
      routePreference: "direct",
    },
  },
  memory_lookup: { query: "routing smoke", limit: 5 },
  memory_save: {
    type: "preference",
    key: "routing-smoke",
    value: "Prefer local smoke tests for tool routing.",
    summary: "Routing smoke preference",
  },
  memory_forget: { idOrKey: "routing-smoke" },
  memory_status: {},
  codex_task_run: { prompt: "List the current directory.", cwd: tmpRoot, sandbox: "read_only", timeoutMs: 10000 },
  yolo_mode_set: { enabled: false },
  app_permission_search: { query: "", limit: 8 },
  app_permission_set: { appName: "Google Chrome", authorized: true },
  capability_set: { capability: "systemOperations", enabled: true },
  file_list: { path: tmpRoot, includeHidden: false },
  file_search: { root: tmpRoot, query: "sample", maxDepth: 2, limit: 5 },
  file_read: { path: sampleFile, maxChars: 500 },
  file_open: { path: sampleFile },
  file_create_folder: { parentPath: tmpRoot, folderName: "created-by-routing-smoke" },
  file_rename: { path: sampleFile, newName: "renamed-sample.txt" },
  file_move: { from: sampleFile, to: path.join(tmpRoot, "moved-sample.txt") },
  file_copy: { from: sampleFile, to: path.join(tmpRoot, "copied-sample.txt") },
  file_trash: { path: sampleFile },
  document_extract: { path: sampleFile, maxChars: 500 },
  document_folder_digest: { root: tmpRoot, query: "sample", limit: 1, charsPerFile: 300 },
  document_prepare_edit: { path: sampleFile, newContent: "Edited by routing smoke.\n" },
  email_search: { query: "routing", limit: 5 },
  email_read: { emailId: "missing-routing-smoke-email" },
  email_draft: { to: "person@example.com", subject: "Routing smoke", body: "Test draft body." },
  email_send: { draftId: "missing-routing-smoke-draft" },
  mac_mail_draft_create: { to: "person@example.com", subject: "Routing smoke", body: "Visible Mail draft smoke body." },
  weather_lookup: { location: "Los Angeles", date: "2026-06-06" },
  calendar_search: { from: "2026-06-05T00:00:00.000Z", to: "2026-06-06T00:00:00.000Z", query: "routing", limit: 5 },
  calendar_create: {
    title: "Routing smoke",
    start: "2026-06-05T12:00:00.000Z",
    end: "2026-06-05T12:30:00.000Z",
    attendees: [],
  },
  mac_calendar_create: {
    title: "Routing smoke macOS event",
    start: "2026-06-05T12:00:00.000Z",
    end: "2026-06-05T12:30:00.000Z",
    attendees: [],
  },
  mac_reminder_create: { title: "Routing smoke reminder", dueAt: "2026-06-05T13:00:00.000Z" },
  mac_note_create: { title: "Routing smoke note", body: "Routing smoke note body." },
  copy_search: { query: "routing", limit: 5 },
  copy_save_draft: { title: "Routing smoke", body: "Copy draft body.", project: "smoke" },
  copy_publish: { draftId: "missing-routing-smoke-copy" },
  music_open: {},
  music_play_song: { query: "Here Comes the Sun", artist: "The Beatles" },
  music_playback_state: {},
  music_spotify_search: { query: "Here Comes the Sun", artist: "The Beatles", limit: 5 },
  music_spotify_play: { query: "Here Comes the Sun", artist: "The Beatles" },
  music_spotify_playback_state: {},
  music_netease_open: { query: "晴天 周杰伦" },
  music_qq_open: { query: "晴天 周杰伦", target: "web" },
  media_key_control: { action: "play_pause", appName: "QQ音乐" },
  video_play: { service: "youtube", query: "lofi hip hop radio" },
  video_playback_control: { action: "state" },
  apple_tv_playback_state: {},
  social_x_search: { query: "from:openai", limit: 10 },
  social_x_post: { text: "Routing smoke test draft." },
  social_open: { service: "xiaohongshu", kind: "search", target: "咖啡", isolated: true },
  news_search: { query: "artificial intelligence", provider: "gdelt", limit: 3 },
  sec_filing_search: { company: "AAPL", forms: ["10-K", "10-Q"], limit: 5 },
  macro_series_lookup: { seriesId: "CUSR0000SA0", startYear: "2025", endYear: "2026" },
  market_quote_lookup: { symbol: "IBM" },
  shortcut_list: { limit: 5 },
  shortcut_run: { name: "Missing Routing Smoke Shortcut", input: "smoke", timeoutMs: 1000 },
  contacts_search: { query: "Alice", limit: 5 },
  phone_call: { phoneNumber: "+15555550100", contactName: "Routing Smoke", mode: "phone" },
  app_open: { appName: "Google Chrome" },
  app_focus: { appName: "Google Chrome" },
  app_quit: { appName: "Google Chrome" },
  window_list: {},
  window_close_all: {},
  window_hide_all: { preserveFrontmost: true, preserveFinder: true },
  window_minimize_all: {},
  window_auto_arrange: { appNames: ["Google Chrome"] },
  window_minimize_unrelated: { keepAppNames: ["Google Chrome"], keepTitleKeywords: ["routing"], preserveFrontmost: true },
  window_close: { appName: "Google Chrome" },
  window_minimize: { appName: "Google Chrome" },
  window_maximize: { appName: "Google Chrome" },
  window_move_resize: { appName: "Google Chrome", x: 80, y: 80, width: 800, height: 600 },
  desktop_show: {},
  desktop_open_app: { appName: "Google Chrome" },
  system_close_app: { appName: "Google Chrome" },
  system_sleep: {},
  system_lock_screen: {},
  system_set_volume: { level: 20 },
  system_get_volume: {},
  system_mute_volume: { muted: true },
  system_set_brightness: { level: 50 },
  system_set_dark_mode: { enabled: false },
  system_open_settings: { pane: "sound" },
  desktop_clipboard_write: { text: "routing smoke clipboard text" },
  desktop_clipboard_read: {},
  system_speak: { text: "routing smoke", voice: "Tingting" },
  system_notification: { title: "Routing smoke", message: "Notification smoke", dialog: false },
  screenshot_capture: { mode: "clipboard" },
  keyboard_shortcut: { action: "escape" },
  browser_open_url: { url: "https://example.com/" },
  browser_search_open: { query: "HER routing smoke", engine: "google", isolated: true },
  browser_isolated_open_url: { url: "https://example.com/" },
  browser_isolated_window_focus: {},
  browser_isolated_window_move_resize: { x: 100, y: 100, width: 900, height: 700 },
  browser_read_page: { maxChars: 500 },
  browser_read_video_state: {},
  browser_fill_form: { fields: [{ selector: "input[name=q]", value: "routing smoke" }] },
  browser_click: { selector: "button[type=submit]", purpose: "Submit the routing smoke form" },
  advanced_shell_command: { command: "pwd", reason: "Verify shell route validation", timeoutMs: 1000 },
};

const routingBlocker = {
  assertToolAllowed: async (name) => {
    throw new Error(`ROUTING_SMOKE_BLOCKED:${name}`);
  },
  authorizedAppNames: async () => new Set(),
};

const hangingGate = {
  assertToolAllowed: async () => new Promise(() => {}),
  authorizedAppNames: async () => new Set(),
};

const createRegistry = () =>
  new ToolRegistry(new ConfirmationQueue(), new AuditLog(), routingBlocker, undefined, new MemoryStore(tmpRoot));

const failures = [];
const notes = [];

const fail = (scope, detail) => failures.push({ scope, detail });

const definitionNames = allToolDefinitions.map((definition) => definition.name);
const sampleNames = Object.keys(samples);

for (const name of definitionNames) {
  if (!samples[name]) fail("sample", `${name} has no smoke-test arguments.`);
}

for (const name of sampleNames) {
  if (!definitionNames.includes(name)) fail("sample", `${name} has sample arguments but no tool definition.`);
}

const duplicateDefinitions = definitionNames.filter((name, index) => definitionNames.indexOf(name) !== index);
for (const name of duplicateDefinitions) fail("definition", `${name} is defined more than once.`);

const realtimeNames = coreRealtimeToolNames;
const realtimeDefinitionNames = manifestRealtimeToolDefinitions.map((definition) => definition.name);
for (const name of realtimeNames) {
  if (!definitionNames.includes(name)) fail("realtime-core", `${name} is not present in allToolDefinitions.`);
}
for (const name of realtimeNames) {
  if (!realtimeDefinitionNames.includes(name)) fail("realtime-definitions", `${name} is missing from manifestRealtimeToolDefinitions.`);
}
for (const name of realtimeDefinitionNames) {
  if (!realtimeNames.includes(name)) fail("realtime-definitions", `${name} is exposed by manifestRealtimeToolDefinitions but not listed as a core realtime tool.`);
}

for (const group of toolGroups) {
  const count = queueManagedToolDefinitions.filter((definition) => toolGroupByName[definition.name] === group).length;
  if (count === 0) fail("catalog", `Tool group ${group} has no queue-managed tools.`);
}

for (const name of definitionNames) {
  const registry = createRegistry();
  const result = await registry.execute({ name, arguments: samples[name], source: "local" });
  if (!result.ok && (result.code === "unknown_tool" || result.code === "invalid_arguments")) {
    fail("direct", `${name} failed direct routing: ${result.code} ${result.error}`);
    continue;
  }
  if (result.ok && !result.requiresConfirmation && typeof result.result === "undefined") {
    fail("direct", `${name} returned undefined; handler may be missing.`);
  }
}

const queueRegistry = createRegistry();
const queued = [];
for (const definition of queueManagedToolDefinitions) {
  const toolName = definition.name;
  const result = await queueRegistry.execute({
    name: "task_create",
    arguments: { toolName, arguments: samples[toolName], priority: "normal", runAfterMs: 0 },
    source: "local",
  });
  if (!result.ok) {
    fail("task_create", `${toolName} was not accepted by task_create: ${result.code ?? "error"} ${result.error}`);
    continue;
  }
  queued.push({ toolName, taskId: result.result.task.taskId });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const deadline = Date.now() + 15000;
while (Date.now() < deadline) {
  const pending = [];
  for (const item of queued) {
    const status = await queueRegistry.execute({
      name: "task_status",
      arguments: { taskId: item.taskId },
      source: "local",
    });
    if (!status.ok) {
      fail("task_status", `${item.toolName} task ${item.taskId} could not be read: ${status.error}`);
      continue;
    }
    const task = status.result.task;
    if (task.status === "queued" || task.status === "running") pending.push(item);
  }
  if (!pending.length) break;
  await sleep(50);
}

for (const item of queued) {
  const status = await queueRegistry.execute({
    name: "task_status",
    arguments: { taskId: item.taskId },
    source: "local",
  });
  if (!status.ok) {
    fail("task_status", `${item.toolName} final task status read failed: ${status.error}`);
    continue;
  }
  const task = status.result.task;
  if (task.status !== "failed" || !String(task.error ?? "").includes(`ROUTING_SMOKE_BLOCKED:${item.toolName}`)) {
    fail(
      "queue",
      `${item.toolName} task reached unexpected status ${task.status}; expected routing blocker failure, got ${task.error ?? "no error"}.`,
    );
  }
}

const timeoutRegistry = new ToolRegistry(new ConfirmationQueue(), new AuditLog(), hangingGate, undefined, new MemoryStore(tmpRoot));
const timeoutCreate = await timeoutRegistry.execute({
  name: "task_create",
  arguments: { toolName: "file_list", arguments: samples.file_list, priority: "normal", runAfterMs: 0 },
  source: "local",
});
if (!timeoutCreate.ok) {
  fail("timeout", `Timeout fixture task_create failed: ${timeoutCreate.error}`);
} else {
  const taskId = timeoutCreate.result.task.taskId;
  const timeoutDeadline = Date.now() + 4000;
  let timeoutTask;
  while (Date.now() < timeoutDeadline) {
    const status = await timeoutRegistry.execute({ name: "task_status", arguments: { taskId }, source: "local" });
    if (!status.ok) {
      fail("timeout", `Timeout fixture task_status failed: ${status.error}`);
      break;
    }
    timeoutTask = status.result.task;
    if (timeoutTask.status !== "queued" && timeoutTask.status !== "running") break;
    await sleep(50);
  }
  if (!timeoutTask || timeoutTask.status !== "failed" || !String(timeoutTask.error ?? "").includes("timed out after 1000ms")) {
    fail("timeout", `Hanging tool did not fail via queue timeout; got ${timeoutTask?.status ?? "missing"} ${timeoutTask?.error ?? ""}`);
  }
}

const unrestrictedRegistry = new ToolRegistry(new ConfirmationQueue(), new AuditLog(), undefined, undefined, new MemoryStore(tmpRoot));
const blockedXiaohongshuProfile = await unrestrictedRegistry.execute({
  name: "social_open",
  arguments: { service: "xiaohongshu", kind: "profile", target: "openai", isolated: false },
  source: "local",
});
if (blockedXiaohongshuProfile.ok || !String(blockedXiaohongshuProfile.error ?? "").includes("only opening search, note, or share")) {
  fail("social_scope", "xiaohongshu profile opening should be rejected before any browser action.");
}

const assertFirstReadyRoute = (scope, result, expectedTool, expectedArgs = {}) => {
  if (!result.ok) {
    fail(scope, `route failed: ${result.code ?? "error"} ${result.error}`);
    return;
  }
  const step = result.result?.plan?.[0];
  if (!step || step.status !== "ready" || step.toolName !== expectedTool) {
    fail(scope, `expected first ready step ${expectedTool}; got ${JSON.stringify(step)}`);
    return;
  }
  for (const [key, value] of Object.entries(expectedArgs)) {
    if (step.arguments?.[key] !== value) {
      fail(scope, `expected ${expectedTool}.${key}=${JSON.stringify(value)}; got ${JSON.stringify(step.arguments?.[key])}`);
    }
  }
};

const youtubeBrowserIntent = await unrestrictedRegistry.execute({
  name: "intent_route",
  arguments: {
    intent: {
      originalText: "请打开大耳朵视频。",
      intent: "search_video",
      complexity: "simple",
      domain: "browser",
      action: "search video",
      entities: { query: "大耳朵 视频", site: "YouTube" },
      confidence: 0.88,
      routePreference: "auto",
    },
  },
  source: "local",
});
assertFirstReadyRoute("youtube_intent", youtubeBrowserIntent, "video_play", { service: "youtube", mode: "play" });

const youtubePlatformIntent = await unrestrictedRegistry.execute({
  name: "intent_route",
  arguments: {
    intent: {
      originalText: "用YouTube打开 大耳朵视频",
      intent: "open_youtube_search",
      complexity: "simple",
      domain: "media",
      action: "search on youtube",
      entities: { platform: "YouTube", mode: "search", query: "大耳朵视频" },
      toolName: "video_play",
      toolArguments: { platform: "youtube", mode: "search", query: "大耳朵视频" },
      confidence: 0.95,
      routePreference: "auto",
    },
  },
  source: "local",
});
assertFirstReadyRoute("youtube_platform_alias", youtubePlatformIntent, "video_play", { service: "youtube", mode: "play" });

const youtubeTaskRoute = await unrestrictedRegistry.execute({
  name: "task_route",
  arguments: { userRequest: "用YouTube打开 大耳朵视频", preference: "auto" },
  source: "local",
});
assertFirstReadyRoute("youtube_task_route", youtubeTaskRoute, "video_play", { service: "youtube", mode: "play" });

const realtimeQueueRegistry = createRegistry();
const realtimeIntentQueue = await realtimeQueueRegistry.execute({
  name: "intent_route",
  arguments: {
    intent: {
      originalText: "列出测试目录文件",
      intent: "list_files",
      complexity: "simple",
      domain: "files",
      action: "list",
      entities: { path: tmpRoot },
      toolName: "file_list",
      toolArguments: { path: tmpRoot, includeHidden: false },
      confidence: 0.95,
      routePreference: "direct",
    },
  },
  source: "realtime",
});
if (!realtimeIntentQueue.ok) {
  fail("realtime_intent_queue", `intent_route realtime queue failed: ${realtimeIntentQueue.error}`);
} else {
  const queuedTask = realtimeIntentQueue.result?.queuedTasks?.[0];
  if (realtimeIntentQueue.result?.mode !== "queued" || queuedTask?.toolName !== "file_list" || !queuedTask?.taskId) {
    fail("realtime_intent_queue", `expected realtime intent_route to queue file_list; got ${JSON.stringify(realtimeIntentQueue.result)}`);
  }
}

notes.push(`Checked ${definitionNames.length} tool definitions.`);
notes.push(`Checked ${queueManagedToolDefinitions.length} queue-managed task_create routes.`);
notes.push(`Checked ${realtimeNames.length} core realtime route names without using realtime.`);
notes.push("Checked queue timeout for a hanging local tool.");
notes.push("Checked Xiaohongshu social_open scope rejects profile/home-style pages.");
notes.push("Checked YouTube video intents route to video_play instead of browser_search_open.");
notes.push("Checked Realtime intent_route queues ready tasks without exposing task_create.");

if (failures.length) {
  console.error(JSON.stringify({ ok: false, notes, failures }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({ ok: true, notes }, null, 2));
