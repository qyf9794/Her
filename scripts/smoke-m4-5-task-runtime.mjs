#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

process.env.HER_TOOL_QUEUE_MAX_CREATES_PER_MINUTE = "120";
process.env.HER_TOOL_QUEUE_MIN_START_INTERVAL_MS = "0";
process.env.HER_TOOL_QUEUE_BACKOFF_BASE_MS = "250";
process.env.HER_TOOL_QUEUE_BACKOFF_MAX_MS = "500";
process.env.HER_TOOL_QUEUE_TASK_TIMEOUT_MS = "1000";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "her-m45-"));
process.env.HER_ALLOWED_DIRECTORIES = tmpRoot;

const require = createRequire(import.meta.url);
const { TaskStore } = require("../electron/dist/main/tasks/task-store.js");
const { TaskQueue } = require("../electron/dist/main/tasks/task-queue.js");
const { ArtifactStore } = require("../electron/dist/main/tasks/artifact-store.js");
const { ResourceLockManager } = require("../electron/dist/main/tasks/resource-lock-manager.js");
const { classifyTaskExecution } = require("../electron/dist/main/tasks/task-classifier.js");
const { ToolRegistry } = require("../electron/dist/main/tools/registry.js");
const { ConfirmationQueue } = require("../electron/dist/main/tools/confirmation.js");
const { AuditLog } = require("../electron/dist/main/audit.js");

try {
  await testTaskStorePersistence();
  testResourceLocks();
  testClassifier();
  await testQueueConcurrency();
  await testPilotConfirmationBinding();
  await testTaskLinkedCommandArtifact();
  await testImmediateToolWhileTaskRunning();
  console.log(JSON.stringify({
    ok: true,
    checks: [
      "TaskStore persists recent redacted task history",
      "ResourceLockManager blocks conflicts and allows non-conflicts",
      "TaskClassifier maps pilot tools to locks",
      "TaskQueue runs non-conflicting work concurrently and conflicting work serially",
      "pilot high-risk tool binds confirmation to taskId",
      "approved shell task creates command artifact event",
      "immediate system_status is not blocked by running queued work",
    ],
  }, null, 2));
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

async function testTaskStorePersistence() {
  const userData = path.join(tmpRoot, "userData");
  const store = new TaskStore(userData);
  const task = store.create({
    kind: "exclusive",
    title: "Redaction smoke",
    summary: "Create task",
    toolName: "advanced_shell_command",
    arguments: { command: "pwd", OPENAI_API_KEY: "sk-secret" },
    resourceLocks: ["shell:local"],
  });
  store.update(task.id, { status: "completed", result: { token: "secret", ok: true } });
  const reloaded = new TaskStore(userData);
  const loaded = reloaded.get(task.id);
  assert.equal(loaded.status, "completed");
  assert.equal(loaded.arguments.OPENAI_API_KEY, "[redacted]");
  assert.equal(loaded.result.token, "[redacted]");
}

function testResourceLocks() {
  const locks = new ResourceLockManager();
  assert.equal(locks.canAcquire("a", ["file:/tmp/a"]), true);
  locks.acquire("a", ["file:/tmp/a"]);
  assert.equal(locks.canAcquire("b", ["file:/tmp/a"]), false);
  assert.equal(locks.canAcquire("b", ["file:/tmp/b"]), true);
  locks.releaseAll("a");
  assert.equal(locks.canAcquire("b", ["file:/tmp/a"]), true);
}

function testClassifier() {
  assert.deepEqual(classifyTaskExecution("file_rename", { path: "/tmp/a" }).resourceLocks, ["file:/tmp/a"]);
  assert.equal(classifyTaskExecution("file_rename", { path: "/tmp/a" }).managed, true);
  assert.equal(classifyTaskExecution("system_status", {}).kind, "immediate");
  assert.equal(classifyTaskExecution("coding_agent_start", { repoPath: process.cwd() }).kind, "long_running");
}

async function testQueueConcurrency() {
  const store = new TaskStore();
  const queue = new TaskQueue(store);
  const starts = {};
  const finishes = {};
  const enqueue = (name, lock, delayMs) => queue.enqueue({
    title: name,
    summary: name,
    toolName: "advanced_shell_command",
    arguments: { name },
    resourceLocks: [lock],
    execute: async (taskId) => {
      starts[name] = Date.now();
      await sleep(delayMs);
      finishes[name] = Date.now();
      return { taskId, name };
    },
  });

  const a = enqueue("a", "file:/tmp/a", 180);
  const b = enqueue("b", "file:/tmp/b", 180);
  const c = enqueue("c", "file:/tmp/a", 10);
  await waitFor(() => store.get(a.id).status === "completed" && store.get(b.id).status === "completed" && store.get(c.id).status === "completed", 3000);
  assert.ok(Math.abs(starts.a - starts.b) < 120, "non-conflicting tasks should start close together");
  assert.ok(starts.c >= finishes.a, "conflicting task should wait for prior lock release");
}

async function testPilotConfirmationBinding() {
  const filePath = path.join(tmpRoot, "rename-me.txt");
  const renamed = path.join(tmpRoot, "renamed.txt");
  fs.writeFileSync(filePath, "rename smoke\n");
  const confirmations = new ConfirmationQueue();
  const registry = new ToolRegistry(confirmations, new AuditLog(), undefined, undefined, undefined, undefined, new TaskStore());
  const created = await registry.execute({ name: "file_rename", source: "local", arguments: { path: filePath, newName: "renamed.txt" } });
  const taskId = created.result.task.id;
  await waitFor(async () => {
    const status = await registry.execute({ name: "task_status", source: "local", arguments: { taskId } });
    return status.result.task.status === "awaiting_confirmation";
  }, 3000);
  const status = await registry.execute({ name: "task_status", source: "local", arguments: { taskId } });
  assert.equal(status.result.task.status, "awaiting_confirmation");
  assert.ok(status.result.task.confirmationId);
  const events = await registry.execute({ name: "task_events", source: "local", arguments: { taskId } });
  const confirmationEvent = events.result.events.find((event) => event.type === "task_confirmation_required");
  assert.equal(confirmationEvent.risk, "local_write");
  assert.equal(confirmationEvent.target, `path: ${filePath}`);
  const pending = confirmations.list()[0];
  assert.equal(pending.plan.taskId, taskId);
  assert.equal(pending.plan.riskLabel, "Local write");
  assert.equal(fs.existsSync(filePath), true);

  await registry.confirm(status.result.task.confirmationId, true);
  await waitFor(async () => {
    const next = await registry.execute({ name: "task_status", source: "local", arguments: { taskId } });
    return next.ok && next.result?.task?.status === "completed";
  }, 3000);
  assert.equal(fs.existsSync(renamed), true);
}

async function testTaskLinkedCommandArtifact() {
  const store = new TaskStore();
  const queue = new TaskQueue(store);
  const artifacts = new ArtifactStore();
  const registry = new ToolRegistry(new ConfirmationQueue(), new AuditLog(), undefined, undefined, undefined, undefined, store, queue, undefined, artifacts);
  const created = await registry.execute({ name: "advanced_shell_command", source: "local", arguments: { command: "pwd", reason: "artifact smoke", timeoutMs: 1000 } });
  const taskId = created.result.task.id;
  await waitFor(async () => {
    const status = await registry.execute({ name: "task_status", source: "local", arguments: { taskId } });
    return status.result.task.status === "awaiting_confirmation";
  }, 3000);
  const status = await registry.execute({ name: "task_status", source: "local", arguments: { taskId } });
  await registry.confirm(status.result.task.confirmationId, true);
  await waitFor(async () => {
    const next = await registry.execute({ name: "task_status", source: "local", arguments: { taskId } });
    return next.ok && next.result?.task?.status === "completed";
  }, 3000);
  const artifact = artifacts.list(1)[0];
  assert.equal(artifact.type, "command_output");
  assert.equal(artifact.sourceTaskId, taskId);
  const events = await registry.execute({ name: "task_events", source: "local", arguments: { taskId } });
  assert.ok(events.result.events.some((event) => event.type === "artifact_created" && event.artifactId === artifact.id));
}

async function testImmediateToolWhileTaskRunning() {
  const store = new TaskStore();
  const queue = new TaskQueue(store);
  const registry = new ToolRegistry(new ConfirmationQueue(), new AuditLog(), undefined, undefined, undefined, undefined, store, queue);
  queue.enqueue({
    title: "slow",
    summary: "slow",
    toolName: "advanced_shell_command",
    arguments: {},
    resourceLocks: ["shell:local"],
    execute: async () => {
      await sleep(1200);
      return { ok: true };
    },
  });
  await waitFor(() => store.list({ status: "running" }).length === 1, 1000);
  const startedAt = Date.now();
  const status = await registry.execute({ name: "system_status", source: "local", arguments: {} });
  const elapsed = Date.now() - startedAt;
  assert.equal(status.ok, true);
  assert.ok(elapsed < 500, `immediate tool took ${elapsed}ms`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) return;
    await sleep(50);
  }
  throw new Error("Timed out waiting for condition.");
}
