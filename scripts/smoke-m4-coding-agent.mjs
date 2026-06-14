import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { CodexExecRunner } from "../electron/dist/main/agents/coding-agent/codex-exec-runner.js";
import { sanitizeCodexEnv } from "../electron/dist/main/agents/coding-agent/env-sanitizer.js";
import { parseCodexJsonLine, parseCodexJsonLines } from "../electron/dist/main/agents/coding-agent/jsonl-parser.js";
import { CodingAgentTaskStore } from "../electron/dist/main/agents/coding-agent/task-store.js";
import { assertGitRepository } from "../electron/dist/main/agents/coding-agent/worktree-manager.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "her-m4-"));

try {
  testEnvSanitizer();
  testJsonlParser();
  await testWorktreeRejectsNonGit();
  testTaskLifecycle();
  await testRunnerCancel();
  console.log(JSON.stringify({
    ok: true,
    checks: [
      "env sanitizer removes secrets",
      "JSONL parser extracts events",
      "worktree rejects non-git folder",
      "task lifecycle store updates",
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

async function waitFor(predicate, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
