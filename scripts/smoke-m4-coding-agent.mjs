import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { CodexExecRunner } from "../electron/dist/main/agents/coding-agent/codex-exec-runner.js";
import { sanitizeCodexEnv } from "../electron/dist/main/agents/coding-agent/env-sanitizer.js";
import { parseCodexJsonLine, parseCodexJsonLines } from "../electron/dist/main/agents/coding-agent/jsonl-parser.js";
import { CodingAgentTaskStore } from "../electron/dist/main/agents/coding-agent/task-store.js";
import { assertGitRepository } from "../electron/dist/main/agents/coding-agent/worktree-manager.js";
import { applyCodingAgentReviewToRepo, buildCodingAgentReview } from "../electron/dist/main/agents/coding-agent/artifact-adapter.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "her-m4-"));

try {
  testEnvSanitizer();
  testJsonlParser();
  await testWorktreeRejectsNonGit();
  testTaskLifecycle();
  await testReviewAndApplyAdapter();
  await testRunnerCancel();
  console.log(JSON.stringify({
    ok: true,
    checks: [
      "env sanitizer removes secrets",
      "JSONL parser extracts events",
      "worktree rejects non-git folder",
      "task lifecycle store updates",
      "review adapter summarizes and applies selected worktree changes",
      "runner cancel terminates fake codex process",
    ],
  }, null, 2));
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

function testEnvSanitizer() {
  const env = sanitizeCodexEnv({
    HOME: "/tmp/home",
    PATH: "/usr/bin",
    OPENAI_API_KEY: "sk-secret",
    HER_LOCAL_API_TOKEN: "local",
    NPM_TOKEN: "npm",
    RANDOM_USER_ENV: "do-not-pass",
  });
  assert.equal(env.HOME, "/tmp/home");
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.HER_LOCAL_API_TOKEN, undefined);
  assert.equal(env.NPM_TOKEN, undefined);
  assert.equal(env.RANDOM_USER_ENV, undefined);
}

function testJsonlParser() {
  const event = parseCodexJsonLine(JSON.stringify({ type: "message", message: "hello" }));
  assert.equal(event?.type, "message");
  assert.equal(event?.message, "hello");
  const events = parseCodexJsonLines('{"type":"delta","text":"a"}\nnot-json\n{"event":"done","summary":"b"}');
  assert.equal(events.length, 2);
  assert.equal(events[0].message, "a");
  assert.equal(events[1].type, "done");
}

async function testWorktreeRejectsNonGit() {
  const nonGit = path.join(tmp, "not-git");
  fs.mkdirSync(nonGit);
  await assert.rejects(() => assertGitRepository(nonGit), /not a git repository|rev-parse|fatal/i);
}

function testTaskLifecycle() {
  const store = new CodingAgentTaskStore();
  const view = store.create({
    prompt: "inspect repo",
    mode: "plan",
    repoPath: process.cwd(),
    sandbox: "read-only",
  });
  assert.equal(view.status, "queued");
  store.update(view.id, { status: "running" });
  store.addEvent(view.id, { level: "info", kind: "test", message: "running" });
  const running = store.get(view.id);
  assert.equal(running.status, "running");
  assert.equal(running.events.length, 1);
  store.update(view.id, { status: "completed", resultText: "done" });
  assert.equal(store.get(view.id).resultText, "done");
}

async function testReviewAndApplyAdapter() {
  const repo = path.join(tmp, "review-repo");
  fs.mkdirSync(repo);
  git(repo, ["init", "-b", "main"]);
  fs.writeFileSync(path.join(repo, "README.md"), "before\n");
  git(repo, ["add", "README.md"]);
  git(repo, ["-c", "user.email=test@example.com", "-c", "user.name=Her Test", "commit", "-m", "init"]);
  const worktree = path.join(tmp, "review-worktree");
  git(repo, ["worktree", "add", "-b", "her/codex/smoke-review", worktree]);
  fs.writeFileSync(path.join(worktree, "README.md"), "after\n");
  fs.writeFileSync(path.join(worktree, "scratch.md"), "scratch\n");

  const task = {
    id: "smoke-review",
    prompt: "fix tests",
    mode: "patch",
    status: "completed",
    repoPath: repo,
    worktreePath: worktree,
    branch: "her/codex/smoke-review",
    sandbox: "workspace-write",
    approvalPolicy: "on-request",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    exitCode: 0,
    resultText: "npm run test passed\nFollow-up: inspect diff",
    eventCount: 0,
    events: [],
  };
  const review = await buildCodingAgentReview(task);
  assert.equal(review.applyAvailable, true);
  assert.ok(review.changedFiles.some((file) => file.path === "README.md" && file.status === "modified"));
  assert.ok(review.changedFiles.some((file) => file.path === "scratch.md" && file.status === "untracked"));
  assert.equal(fs.readFileSync(path.join(repo, "README.md"), "utf8"), "before\n");
  const applied = await applyCodingAgentReviewToRepo({ ...task, review }, { taskId: task.id, paths: ["README.md"] });
  assert.deepEqual(applied.appliedPaths, ["README.md"]);
  assert.equal(fs.readFileSync(path.join(repo, "README.md"), "utf8"), "after\n");
  assert.equal(fs.existsSync(path.join(repo, "scratch.md")), false);
}

async function testRunnerCancel() {
  const fakeCodex = path.join(tmp, "fake-codex.mjs");
  fs.writeFileSync(fakeCodex, `#!/usr/bin/env node
console.log(JSON.stringify({ type: "message", message: "started" }));
setInterval(() => {}, 1000);
`);
  fs.chmodSync(fakeCodex, 0o755);
  const runner = new CodexExecRunner(fakeCodex);
  const events = [];
  const run = runner.run({
    taskId: "cancel-test",
    prompt: "long task",
    cwd: process.cwd(),
    sandbox: "read-only",
    timeoutMs: 30000,
    onEvent: (event) => events.push(event),
  });
  await waitFor(() => events.some((event) => event.message === "started"), 2000);
  assert.equal(runner.cancel("cancel-test"), true);
  await assert.rejects(run, /exited with code|null|SIGTERM|started/i);
  assert.equal(runner.isRunning("cancel-test"), false);
  assert.ok(events.some((event) => event.message === "started"));
}

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `git ${args.join(" ")} failed`);
  }
  return result.stdout;
}

async function waitFor(predicate, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
