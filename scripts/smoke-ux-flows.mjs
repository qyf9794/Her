#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";

process.env.HER_TOOL_QUEUE_MAX_CREATES_PER_MINUTE = "120";
process.env.HER_TOOL_QUEUE_MIN_START_INTERVAL_MS = "0";
process.env.HER_TOOL_QUEUE_BACKOFF_BASE_MS = "250";
process.env.HER_TOOL_QUEUE_BACKOFF_MAX_MS = "500";
process.env.HER_TOOL_QUEUE_TASK_TIMEOUT_MS = "90000";

const require = createRequire(import.meta.url);
const { ToolRegistry } = require("../electron/dist/main/tools/registry.js");
const { ConfirmationQueue } = require("../electron/dist/main/tools/confirmation.js");
const { AuditLog } = require("../electron/dist/main/audit.js");
const { MemoryStore } = require("../electron/dist/main/memory-store.js");
const { SettingsStore } = require("../electron/dist/main/settings-store.js");

const root = process.cwd();
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "her-ux-smoke-"));
const fixtureRoot = fs.mkdtempSync(path.join(os.homedir(), "Documents", "HER UX Smoke "));
const largeFile = path.join(fixtureRoot, "large-result.txt");
const renameFile = path.join(fixtureRoot, "rename-me.txt");
const renamedFile = path.join(fixtureRoot, "renamed.txt");
fs.writeFileSync(largeFile, `${"HER UX large result line\n".repeat(420)}\n`, "utf8");
fs.writeFileSync(renameFile, "rename/trash confirmation smoke\n", "utf8");

const fakeApps = [
  { name: "Safari", bundleId: "com.apple.Safari", path: "/Applications/Safari.app", authorized: true, recommended: true, risk: "medium" },
  { name: "Mail", bundleId: "com.apple.mail", path: "/System/Applications/Mail.app", authorized: true, recommended: true, risk: "medium" },
  { name: "Notes", bundleId: "com.apple.Notes", path: "/System/Applications/Notes.app", authorized: true, recommended: true, risk: "medium" },
  { name: "Music", bundleId: "com.apple.Music", path: "/System/Applications/Music.app", authorized: true, recommended: true, risk: "medium" },
  { name: "Terminal", bundleId: "com.apple.Terminal", path: "/System/Applications/Utilities/Terminal.app", authorized: false, recommended: false, risk: "high" },
];

const settings = new SettingsStore(tmpRoot);
const permissionManager = {
  listApps: async () => fakeApps.map((app) => {
    const current = settings.read();
    return {
      ...app,
      authorized: current.yoloMode || (current.appPermissions[app.bundleId] ?? app.authorized),
    };
  }),
  readSettings: () => settings.read(),
  setAppPermissions: (appPermissions) => settings.setAppPermissions(appPermissions),
  setCapabilities: (capabilities) => settings.setCapabilities(capabilities),
  setYoloMode: (enabled, appPermissions) => settings.setYoloMode(enabled, appPermissions),
};

const smokeGate = {
  assertToolAllowed: async () => {},
  authorizedAppNames: async () => new Set(["Safari", "Mail", "Notes", "Music"]),
};

const registry = new ToolRegistry(new ConfirmationQueue(), new AuditLog(), smokeGate, permissionManager, new MemoryStore(tmpRoot));
const results = [];

try {
  await runCase("memory roundtrip saves, looks up, and forgets explicit preference", async () => {
    const saved = await mustExec("memory_save", {
      type: "preference",
      key: "ux-smoke-output-style",
      summary: "Prefer concise Chinese smoke summaries.",
      content: "For HER UX smoke, answer in concise Chinese and mention confirmation state.",
      aliases: ["ux smoke style"],
      tags: ["ux-smoke"],
    });
    const lookup = await mustExec("memory_lookup", { query: "ux smoke style", types: ["preference"], limit: 5 });
    assert(lookup.matches.some((item) => item.key === "ux-smoke-output-style"), "memory_lookup did not find saved preference");
    const forgotten = await mustExec("memory_forget", { idOrKey: saved.memory.id });
    assert(forgotten.removed === 1, "memory_forget did not remove saved preference");
    const status = await mustExec("memory_status", {});
    return { savedKey: saved.memory.key, lookupCount: lookup.count, remaining: status.total };
  });

  await runCase("tool group disable blocks browser task, then re-enable allows it", async () => {
    const disabled = await mustExec("tool_group_set", { group: "browser", enabled: false });
    assert(disabled.enabled === false, "browser group was not disabled");
    const blocked = await exec("task_create", {
      toolName: "browser_isolated_open_url",
      arguments: { url: "https://example.com" },
      priority: "normal",
      runAfterMs: 0,
    });
    assert(!blocked.ok && /disabled: browser/i.test(blocked.error ?? ""), `browser task was not blocked: ${JSON.stringify(blocked)}`);
    const enabled = await mustExec("tool_group_set", { group: "browser", enabled: true });
    assert(enabled.enabled === true, "browser group was not re-enabled");
    const queued = await mustExec("task_create", {
      toolName: "browser_isolated_open_url",
      arguments: { url: "https://example.com" },
      priority: "normal",
      runAfterMs: 0,
    });
    const task = await waitTask(queued.task.taskId);
    assert(task.status === "completed", `browser task did not complete: ${JSON.stringify(task)}`);
    return { blocked: blocked.error, completedTool: task.toolName };
  });

  await runCase("confirmation reject cancels clipboard write", async () => {
    const before = readClipboard();
    const queued = await mustExec("task_create", {
      toolName: "desktop_clipboard_write",
      arguments: { text: "HER UX rejected clipboard write" },
      priority: "normal",
      runAfterMs: 0,
    });
    const pending = await waitTask(queued.task.taskId, ["needs_confirmation"]);
    assert(pending.confirmationId, "clipboard task did not expose confirmation id");
    await mustExec("confirmation_decide", { confirmationId: pending.confirmationId, approved: false });
    const finalTask = await waitTask(queued.task.taskId, ["cancelled"]);
    assert(finalTask.status === "cancelled", "rejected clipboard task was not cancelled");
    const after = readClipboard();
    assert(after === before, "clipboard changed even though confirmation was rejected");
    return { status: finalTask.status, unchanged: true };
  });

  await runCase("confirmation approve writes clipboard and updates task", async () => {
    const text = `HER UX approved clipboard ${Date.now()}`;
    const task = await queueAndApprove("desktop_clipboard_write", { text });
    assert(task.status === "completed", "approved clipboard task did not complete");
    assert(readClipboard() === text, "clipboard does not contain approved text");
    return { status: task.status, clipboardChars: text.length };
  });

  await runCase("file rename and trash require confirmation and affect allowlisted files", async () => {
    const renameTask = await queueAndApprove("file_rename", { path: renameFile, newName: "renamed.txt" });
    assert(renameTask.status === "completed", "file_rename did not complete");
    assert(fs.existsSync(renamedFile), "renamed file is missing");
    const trashTask = await queueAndApprove("file_trash", { path: renamedFile });
    assert(trashTask.status === "completed", "file_trash did not complete");
    assert(!fs.existsSync(renamedFile), "trashed file still exists in fixture folder");
    return { renamed: true, trashed: true };
  });

  await runCase("dangerous shell command is blocked before confirmation", async () => {
    const queued = await mustExec("task_create", {
      toolName: "advanced_shell_command",
      arguments: {
        command: `rm -rf ${JSON.stringify(fixtureRoot)}`,
        reason: "UX smoke verifies dangerous shell commands are blocked.",
        timeoutMs: 5000,
      },
      priority: "normal",
      runAfterMs: 0,
    });
    const task = await waitTask(queued.task.taskId, ["failed"]);
    assert(task.status === "failed", "dangerous shell task was not failed before confirmation");
    assert(/Blocked unsafe shell command/i.test(task.error ?? ""), `unexpected shell error: ${task.error}`);
    assert(fs.existsSync(fixtureRoot), "fixture folder was removed by blocked command");
    return { blockedBeforeConfirmation: true, error: task.error };
  });

  await runCase("safe read-only shell command completes after confirmation", async () => {
    const task = await queueAndApprove("advanced_shell_command", {
      command: "pwd",
      reason: "UX smoke verifies safe read-only shell command execution.",
      timeoutMs: 5000,
    });
    assert(task.status === "completed", "safe shell task did not complete");
    return { status: task.status };
  });

  await runCase("shell command outside allowlisted write scope is blocked before confirmation", async () => {
    const queued = await mustExec("task_create", {
      toolName: "advanced_shell_command",
      arguments: {
        command: "touch /tmp/her-ux-smoke-outside-allowlist",
        reason: "UX smoke verifies shell writes must reference allowlisted directories.",
        timeoutMs: 5000,
      },
      priority: "normal",
      runAfterMs: 0,
    });
    const task = await waitTask(queued.task.taskId, ["failed"]);
    assert(task.status === "failed", "outside-allowlist shell task was not failed before confirmation");
    assert(/allowlisted directory|clearly read-only/i.test(task.error ?? ""), `unexpected shell error: ${task.error}`);
    return { blockedBeforeConfirmation: true, error: task.error };
  });

  await runCase("allowlisted shell write completes after confirmation", async () => {
    const createdPath = path.join(fixtureRoot, "shell-created.txt");
    const task = await queueAndApprove("advanced_shell_command", {
      command: `printf 'shell ok\\n' > ${JSON.stringify(createdPath)}`,
      reason: "UX smoke verifies allowlisted shell writes can run after confirmation.",
      timeoutMs: 5000,
    });
    assert(task.status === "completed", "allowlisted shell write did not complete");
    assert(fs.existsSync(createdPath), "allowlisted shell write did not create the file");
    return { status: task.status, fileCreated: true };
  });

  await runCase("large direct result returns handle and tool_result_read can page it", async () => {
    const response = await exec("file_read", { path: largeFile, maxChars: 10000 });
    assert(response.ok, `file_read failed: ${response.error}`);
    assert(response.result?.truncated === true && response.result?.handle, "file_read did not return truncated handle");
    const chunk = await mustExec("tool_result_read", { handle: response.result.handle, offset: 0, maxChars: 1200 });
    assert(chunk.content.includes("HER UX large result line"), "tool_result_read did not return expected content");
    return { handle: response.result.handle, chars: chunk.chars, totalChars: chunk.totalChars };
  });

  await runCase("permission tools search, capability toggle, app authorization, and yolo mode", async () => {
    const search = await mustExec("app_permission_search", { query: "Terminal", limit: 5 });
    assert(search.matches.some((app) => app.name === "Terminal"), "app_permission_search did not find Terminal");
    const authorized = await mustExec("app_permission_set", { appName: "Terminal", authorized: true });
    assert(authorized.updated === true && authorized.app.authorized === true, "app_permission_set did not authorize Terminal");
    const disabled = await mustExec("capability_set", { capability: "browserAutomation", enabled: false });
    assert(disabled.enabled === false, "capability_set did not disable browserAutomation");
    const yolo = await mustExec("yolo_mode_set", { enabled: true });
    assert(yolo.enabled === true, "yolo_mode_set did not enable YOLO mode");
    const off = await mustExec("yolo_mode_set", { enabled: false });
    assert(off.enabled === false, "yolo_mode_set did not disable YOLO mode");
    return { terminalAuthorized: authorized.app.authorized, yoloEnabledThenDisabled: true };
  });

  await runCase("calendar search and local draft read cover read-only text adapters", async () => {
    const eventTask = await queueAndApprove("calendar_create", {
      title: "HER UX local calendar adapter smoke",
      start: "2026-06-06T10:00:00+08:00",
      end: "2026-06-06T10:30:00+08:00",
      attendees: [],
      notes: "local adapter read-only search smoke",
    });
    assert(eventTask.status === "completed", "calendar_create did not complete");
    const events = await mustExec("calendar_search", {
      from: "2026-06-06T00:00:00+08:00",
      to: "2026-06-07T00:00:00+08:00",
      query: "HER UX local calendar",
      limit: 5,
    });
    assert(events.some((item) => item.title === "HER UX local calendar adapter smoke"), "calendar_search did not find local adapter event");
    const draft = await mustExec("email_draft", {
      to: "local-adapter@example.com",
      subject: "HER UX local draft adapter",
      body: "This is a local adapter draft used for email_read smoke.",
    });
    const email = await mustExec("email_read", { emailId: draft.id });
    assert(email.subject === "HER UX local draft adapter", "email_read did not return local draft subject");
    return { calendarMatches: events.length, emailId: email.id };
  });

  const summary = {
    ok: true,
    checked: results.length,
    passed: results.length,
    failed: 0,
    tmpRoot,
    fixtureRoot,
    results,
  };
  console.log(JSON.stringify(summary, null, 2));
} catch (error) {
  const summary = {
    ok: false,
    checked: results.length + 1,
    passed: results.filter((item) => item.ok).length,
    failed: 1,
    error: error instanceof Error ? error.message : String(error),
    tmpRoot,
    fixtureRoot,
    results,
  };
  console.error(JSON.stringify(summary, null, 2));
  process.exitCode = 1;
} finally {
  try {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  } catch {
    // Nothing else to do; individual file tests already verify user-facing behavior.
  }
}

async function runCase(id, fn) {
  const startedAt = Date.now();
  const result = await fn();
  const item = { id, ok: true, ms: Date.now() - startedAt, result };
  results.push(item);
  console.log(JSON.stringify(item, null, 2));
}

async function exec(name, args) {
  return registry.execute({ name, arguments: args, source: "local" });
}

async function mustExec(name, args) {
  const response = await exec(name, args);
  if (!response.ok) throw new Error(`${name} failed: ${response.error}`);
  return readFullResult(response.result);
}

async function queueAndApprove(toolName, args, terminalStatuses = ["completed"]) {
  const queued = await mustExec("task_create", { toolName, arguments: args, priority: "normal", runAfterMs: 0 });
  const pending = await waitTask(queued.task.taskId, ["needs_confirmation"]);
  assert(pending.confirmationId, `${toolName} did not request confirmation`);
  await mustExec("confirmation_decide", { confirmationId: pending.confirmationId, approved: true });
  return waitTask(queued.task.taskId, terminalStatuses);
}

async function waitTask(taskId, wantedStatuses = ["completed", "failed", "cancelled"]) {
  const wanted = new Set(wantedStatuses);
  let task;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const result = await mustExec("task_status", { taskId });
    task = result.task;
    if (wanted.has(task.status)) return task;
    await sleep(500);
  }
  throw new Error(`Task ${taskId} did not reach ${wantedStatuses.join("/")} status; latest=${task?.status}`);
}

async function readFullResult(result) {
  if (!result?.truncated || !result.handle) return result;
  let offset = 0;
  let content = "";
  for (let index = 0; index < 20; index += 1) {
    const response = await exec("tool_result_read", { handle: result.handle, offset, maxChars: 6000 });
    if (!response.ok) throw new Error(`tool_result_read failed: ${response.error}`);
    content += response.result.content ?? "";
    if (!response.result.hasMore) return JSON.parse(content);
    offset = response.result.nextOffset;
  }
  throw new Error(`tool_result_read exceeded chunk limit for handle ${result.handle}`);
}

function readClipboard() {
  try {
    return execFileSync("pbpaste", [], { encoding: "utf8" });
  } catch {
    return "";
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
