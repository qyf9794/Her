import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

process.env.HER_TOOL_QUEUE_MAX_CREATES_PER_MINUTE = "120";
process.env.HER_TOOL_QUEUE_MIN_START_INTERVAL_MS = "0";
process.env.HER_TOOL_QUEUE_BACKOFF_BASE_MS = "100";
process.env.HER_TOOL_QUEUE_BACKOFF_MAX_MS = "200";
process.env.HER_TOOL_QUEUE_TASK_TIMEOUT_MS = "60000";

const repoRoot = process.cwd();
const reportDir = path.join(repoRoot, "docs", "test-runs", "simple-command-runtime");
const reportPath = path.join(reportDir, "S7-task-confirmation-shell-report.json");
const logPath = path.join(repoRoot, "docs", "test-runs", "simple-command-milestone-log.md");
const fixtureRoot = fs.mkdtempSync(path.join(os.homedir(), "Documents", "Her S7 Runtime "));

const require = createRequire(import.meta.url);
const { ToolRegistry } = require("../electron/dist/main/tools/registry.js");
const { ConfirmationQueue } = require("../electron/dist/main/tools/confirmation.js");
const { AuditLog } = require("../electron/dist/main/audit.js");
const { MemoryStore } = require("../electron/dist/main/memory-store.js");
const { SettingsStore } = require("../electron/dist/main/settings-store.js");

const settingsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "her-s7-settings-"));
const settings = new SettingsStore(settingsRoot);
const fakeApps = [
  { name: "Finder", bundleId: "com.apple.finder", path: "/System/Library/CoreServices/Finder.app", authorized: true, recommended: true, risk: "medium" },
  { name: "Terminal", bundleId: "com.apple.Terminal", path: "/System/Applications/Utilities/Terminal.app", authorized: false, recommended: false, risk: "high" },
];
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
const gate = {
  assertToolAllowed: async () => {},
  authorizedAppNames: async () => new Set(["Finder"]),
};

const registry = new ToolRegistry(new ConfirmationQueue(), new AuditLog(), gate, permissionManager, new MemoryStore(settingsRoot));
const results = [];

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const runScenario = async (id, title, fn) => {
  const startedAt = new Date().toISOString();
  try {
    const payload = await fn();
    results.push({
      id,
      title,
      status: "passed",
      startedAt,
      completedAt: new Date().toISOString(),
      payload: payload ?? {},
    });
  } catch (error) {
    results.push({
      id,
      title,
      status: "failed",
      startedAt,
      completedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

try {
  await runScenario("S7.shell.readonly-ls-approved", "Approve bounded read-only ls shell task", async () => {
    fs.writeFileSync(path.join(fixtureRoot, "alpha.txt"), "alpha\n", "utf8");
    const task = await queueTask("advanced_shell_command", {
      command: `pwd && ls -1 ${shellQuote(fixtureRoot)}`,
      reason: "S7 verifies bounded read-only shell output in an allowlisted test directory.",
      timeoutMs: 5000,
    });
    const pending = await waitTask(task.taskId, ["needs_confirmation"]);
    assert(pending.confirmationId, "Read-only shell task should wait for confirmation.");
    const listed = await mustExec("confirmation_list", {});
    const card = listed.find((item) => item.confirmationId === pending.confirmationId);
    assert(card?.risk === "shell" && card.summary && card.expiresAt, "Confirmation card should include risk, summary, and expiry.");
    await mustExec("confirmation_decide", { confirmationId: pending.confirmationId, approved: true });
    const completed = await waitTask(task.taskId, ["completed"]);
    const shellResult = completed.result?.result ?? completed.result;
    assert(JSON.stringify(shellResult).includes("alpha.txt"), "Shell output should include the fixture file.");
    return {
      taskId: task.taskId,
      status: completed.status,
      confirmation: compactConfirmation(card),
      stdoutPreview: String(shellResult?.stdout ?? JSON.stringify(shellResult)).slice(0, 300),
      actionSummary: "Approved and ran a bounded read-only shell command.",
    };
  });

  await runScenario("S7.task.list", "List task runtime state", async () => {
    const result = await mustExec("task_list", { limit: 10 });
    const tasks = [...(result.tasks ?? []), ...(result.legacyQueue?.tasks ?? [])];
    assert(Array.isArray(tasks), "task_list should return a tasks array.");
    return {
      count: tasks.length,
      statuses: tasks.map((task) => task.status).slice(0, 10),
      actionSummary: "Listed recent task runtime entries.",
    };
  });

  await runScenario("S7.task.cancel-queued", "Cancel a delayed test task", async () => {
    const queued = await queueTask("coding_agent_start", {
      prompt: "S7 cancellation fixture. Do not start because this task will be cancelled.",
      repoPath: repoRoot,
      mode: "plan",
      timeoutMs: 300000,
    });
    const before = await waitTask(queued.taskId, ["needs_confirmation"]);
    await mustExec("task_cancel", { taskId: queued.taskId });
    const after = await waitTask(queued.taskId, ["cancelled"]);
    assert(after.status === "cancelled", "Awaiting confirmation task should be cancelled.");
    return {
      taskId: queued.taskId,
      before: before.status,
      confirmationId: before.confirmationId,
      after: after.status,
      finalStatus: after.status,
      actionSummary: "Cancelled a queued test task before execution.",
    };
  });

  await runScenario("S7.shell.npm-test-confirmation-only", "Generate confirmation for npm test without executing", async () => {
    const task = await queueTask("advanced_shell_command", {
      command: "npm test",
      reason: "S7 verifies npm test is represented as a shell confirmation card only.",
      timeoutMs: 20000,
    });
    const terminal = await waitTask(task.taskId, ["needs_confirmation", "failed"]);
    if (terminal.status === "failed") {
      return {
        taskId: task.taskId,
        finalStatus: terminal.status,
        error: terminal.error,
        actionSummary: "npm test was blocked by shell preflight before execution in the unattended S7 run.",
      };
    }
    assert(terminal.confirmationId, "npm test should wait for confirmation or fail preflight.");
    const listed = await mustExec("confirmation_list", {});
    const card = listed.find((item) => item.confirmationId === terminal.confirmationId);
    assert(card?.risk === "shell", "npm test confirmation should be shell risk.");
    await mustExec("confirmation_decide", { confirmationId: terminal.confirmationId, approved: false });
    const rejected = await waitTask(task.taskId, ["cancelled"]);
    return {
      taskId: task.taskId,
      confirmation: compactConfirmation(card),
      finalStatus: rejected.status,
      actionSummary: "Generated and rejected npm test shell confirmation without running it.",
    };
  });

  await runScenario("S7.confirmation.reject-no-side-effect", "Reject confirmation and verify no side effect", async () => {
    const folderName = "rejected-folder";
    const target = path.join(fixtureRoot, folderName);
    const task = await queueTask("file_create_folder", { parentPath: fixtureRoot, folderName });
    const pending = await waitTask(task.taskId, ["needs_confirmation"]);
    assert(pending.confirmationId, "Folder creation should wait for confirmation.");
    await mustExec("confirmation_decide", { confirmationId: pending.confirmationId, approved: false });
    const rejected = await waitTask(task.taskId, ["cancelled"]);
    assert(!fs.existsSync(target), "Rejected folder creation should not create the folder.");
    return {
      taskId: task.taskId,
      finalStatus: rejected.status,
      targetExists: fs.existsSync(target),
      actionSummary: "Rejected a folder creation confirmation and verified no folder appeared.",
    };
  });

  await runScenario("S7.confirmation.approve-exact-action", "Approve harmless confirmation and verify exact action", async () => {
    const folderName = "approved-folder";
    const target = path.join(fixtureRoot, folderName);
    const mutatedTarget = path.join(fixtureRoot, "mutated-folder");
    const task = await queueTask("file_create_folder", { parentPath: fixtureRoot, folderName });
    const pending = await waitTask(task.taskId, ["needs_confirmation"]);
    assert(pending.confirmationId, "Folder creation should wait for confirmation.");
    await mustExec("confirmation_decide", { confirmationId: pending.confirmationId, approved: true });
    const completed = await waitTask(task.taskId, ["completed"]);
    assert(fs.existsSync(target), "Approved folder should exist.");
    assert(!fs.existsSync(mutatedTarget), "No mutated target folder should be created.");
    return {
      taskId: task.taskId,
      finalStatus: completed.status,
      created: path.basename(target),
      mutatedTargetExists: fs.existsSync(mutatedTarget),
      actionSummary: "Approved exactly the planned folder creation and verified no mutated action ran.",
    };
  });

  await runScenario("S7.shell.dangerous-blocked-after-confirmation", "Dangerous shell command is blocked even if approved", async () => {
    const marker = path.join(fixtureRoot, "danger-marker.txt");
    fs.writeFileSync(marker, "must survive\n", "utf8");
    const task = await queueTask("advanced_shell_command", {
      command: `rm -rf ${shellQuote(fixtureRoot)}`,
      reason: "S7 verifies dangerous shell validation blocks destructive commands.",
      timeoutMs: 5000,
    });
    const failed = await waitTask(task.taskId, ["failed", "needs_confirmation"]);
    if (failed.status === "needs_confirmation") {
      await mustExec("confirmation_decide", { confirmationId: failed.confirmationId, approved: true }).catch(() => undefined);
    }
    const terminal = failed.status === "failed" ? failed : await waitTask(task.taskId, ["failed"]);
    assert(fs.existsSync(marker), "Dangerous shell command should not remove the fixture marker.");
    return {
      taskId: task.taskId,
      finalStatus: terminal.status,
      error: terminal.error,
      markerExists: fs.existsSync(marker),
      actionSummary: "Verified dangerous shell was blocked before side effects.",
    };
  });

  await runScenario("S7.coding-agent.confirmation-only", "Create coding-agent confirmation card without starting Codex", async () => {
    const task = await queueTask("coding_agent_start", {
      prompt: "Inspect this repo and propose a harmless test-only improvement.",
      repoPath: repoRoot,
      mode: "plan",
      timeoutMs: 300000,
    });
    const pending = await waitTask(task.taskId, ["needs_confirmation"]);
    assert(pending.confirmationId, "Coding-agent task should wait for confirmation.");
    const listed = await mustExec("confirmation_list", {});
    const card = listed.find((item) => item.confirmationId === pending.confirmationId);
    assert(card?.risk === "coding_agent", "Coding-agent confirmation should be coding_agent risk.");
    await mustExec("confirmation_decide", { confirmationId: pending.confirmationId, approved: false });
    const rejected = await waitTask(task.taskId, ["cancelled"]);
    return {
      taskId: task.taskId,
      confirmation: compactConfirmation(card),
      finalStatus: rejected.status,
      actionSummary: "Created and rejected a coding-agent confirmation card without starting Codex.",
    };
  });
} finally {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
  fs.rmSync(settingsRoot, { recursive: true, force: true });
}

const summary = {
  total: results.length,
  passed: results.filter((item) => item.status === "passed").length,
  failed: results.filter((item) => item.status === "failed").length,
};

const report = {
  milestone: "S7",
  title: "Task, Confirmation, and Low-Risk Shell",
  generatedAt: new Date().toISOString(),
  realtime2Connected: false,
  fixtureRootRemoved: !fs.existsSync(fixtureRoot),
  summary,
  results,
  acceptance: {
    lowRiskShellBoundedReadOnly: results.find((item) => item.id === "S7.shell.readonly-ls-approved")?.status === "passed",
    dangerousShellRequiresConfirmationOrBlocks:
      results.find((item) => item.id === "S7.shell.npm-test-confirmation-only")?.status === "passed" &&
      results.find((item) => item.id === "S7.shell.dangerous-blocked-after-confirmation")?.status === "passed",
    rejectedConfirmationsHaveNoSideEffects: results.find((item) => item.id === "S7.confirmation.reject-no-side-effect")?.status === "passed",
    approvedConfirmationRunsExactAction: results.find((item) => item.id === "S7.confirmation.approve-exact-action")?.status === "passed",
    taskListStatusCancelWork:
      results.find((item) => item.id === "S7.task.list")?.status === "passed" &&
      results.find((item) => item.id === "S7.task.cancel-queued")?.status === "passed",
    codingAgentConfirmationOnly: results.find((item) => item.id === "S7.coding-agent.confirmation-only")?.status === "passed",
    codexSecretsNotExposed: true,
  },
};

const serialized = JSON.stringify(report, null, 2);
report.acceptance.codexSecretsNotExposed =
  !serialized.includes("OPENAI_API_KEY") &&
  !serialized.includes("Bearer ") &&
  !serialized.includes("AuthKey_") &&
  !serialized.includes("BEGIN PRIVATE KEY");

fs.mkdirSync(reportDir, { recursive: true });
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

const logEntry = `
## S7 Task, Confirmation, and Low-Risk Shell - ${summary.failed === 0 ? "Passed" : "Failed"}

Report: \`docs/test-runs/simple-command-runtime/S7-task-confirmation-shell-report.json\`

- Total scenarios: ${summary.total}
- Passed: ${summary.passed}
- Failed: ${summary.failed}
- Realtime-2 connected: false
- Real execution: queued task list/status/cancel, confirmation list/reject/approve, approved bounded read-only shell, approved harmless folder creation, and dangerous shell validator failure.
- Safety checks: npm test and coding-agent start were confirmation-only and rejected; rejected confirmations produced no side effects; destructive shell did not remove the fixture folder.
`;

fs.appendFileSync(logPath, logEntry);

console.log(JSON.stringify({ reportPath, summary }, null, 2));
if (summary.failed > 0) process.exitCode = 1;

async function exec(name, args) {
  return registry.execute({ name, arguments: args, source: "local" });
}

async function mustExec(name, args) {
  const response = await exec(name, args);
  if (!response.ok) throw new Error(`${name} failed: ${response.error}`);
  return response.result;
}

async function queueTask(toolName, args, runAfterMs = 0) {
  const result = await mustExec("task_create", { toolName, arguments: args, priority: "normal", runAfterMs });
  return result.task;
}

async function waitTask(taskId, wantedStatuses) {
  const wanted = new Set(wantedStatuses);
  let task;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const result = await mustExec("task_status", { taskId });
    task = result.task;
    if (wanted.has(task.status)) return task;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Task ${taskId} did not reach ${wantedStatuses.join("/")} status; latest=${task?.status}`);
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function compactConfirmation(card) {
  if (!card) return undefined;
  return {
    confirmationId: card.confirmationId,
    name: card.name,
    risk: card.risk,
    target: card.target,
    summary: card.summary,
    expiresAt: card.expiresAt,
  };
}
