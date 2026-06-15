import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyCodingAgentReviewToRepo, buildCodingAgentReview } from "../../src/main/agents/coding-agent/artifact-adapter";
import { selectToolBundles } from "../../src/main/agent/tool-bundle-router";
import { createLocalApiAuth, requireLocalApiAuth } from "../../src/main/api/auth";
import { CapabilityGate } from "../../src/main/capability-gate";
import { summarizeText } from "../../src/main/context/desktop-snapshot";
import { createActionPlan, ApprovalPolicy } from "../../src/main/policy/approval-policy";
import { SettingsStore } from "../../src/main/settings-store";
import { ArtifactStore } from "../../src/main/tasks/artifact-store";
import { parseCodexJsonLine, parseCodexJsonLines } from "../../src/main/agents/coding-agent/jsonl-parser";
import { isSecretEnvKey, sanitizeCodexEnv } from "../../src/main/agents/coding-agent/env-sanitizer";
import { ConfirmationQueue } from "../../src/main/tools/confirmation";
import { allToolDefinitions } from "../../src/main/tools/metadata";
import { manifestRealtimeToolDefinitionsForBundles, toolManifest, toolRequiresConfirmation } from "../../src/main/tools/manifest";
import { redactTaskValue } from "../../src/main/tasks/task-redaction";
import type { CodingAgentTaskView } from "../../src/shared/agents/coding-agent";

const tmpDirs: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("tool manifest and routing", () => {
  it("keeps tool manifest as a unique single source for tool names", () => {
    const definitionNames = allToolDefinitions.map((definition) => definition.name);
    expect(new Set(definitionNames).size).toBe(definitionNames.length);
    expect(Object.keys(toolManifest).sort()).toEqual([...definitionNames].sort());
  });

  it("generates bundled realtime definitions from manifest entries", () => {
    const tools = manifestRealtimeToolDefinitionsForBundles(["media"]);
    const names = tools.map((tool) => tool.name);
    expect(names).toContain("system_status");
    expect(names).toContain("music_play_song");
    expect(new Set(names).size).toBe(names.length);
  });

  it("selects deterministic bundles for mixed coding and media requests", () => {
    const selection = selectToolBundles("运行 Codex 修复 bug，同时播放周杰伦的晴天");
    expect(selection.bundles).toEqual(expect.arrayContaining(["core", "coding", "media"]));
    expect(selection.shouldAskModelToSelect).toBe(false);
  });

  it("uses compact desktop context as a weak realtime bundle signal", () => {
    const selection = selectToolBundles("帮我处理这个", {
      activeApp: "Finder",
      activeWindowTitle: "Desktop",
      clipboard: { status: "redacted", chars: 42 },
      selectedText: { status: "unsupported", chars: 0 },
      recentFiles: [],
    });
    expect(selection.bundles).toEqual(expect.arrayContaining(["core", "desktop", "file"]));
    expect(selection.reason).toContain("context");
  });
});

describe("approval policy", () => {
  it("requires confirmation for high-risk tools and denies unknown tools", () => {
    const policy = new ApprovalPolicy();
    const decision = policy.decide({
      toolName: "file_rename",
      args: { path: "/tmp/a", newName: "b" },
      summary: "Rename file",
      yoloMode: false,
      now: new Date("2026-01-01T00:00:00.000Z"),
    });
    expect(decision.type).toBe("require_confirmation");
    if (decision.type === "require_confirmation") {
      expect(decision.plan).toMatchObject({
        risk: "local_write",
        riskLabel: "Local write",
        target: "path: /tmp/a",
        reversible: true,
        policy: { name: "path-policy" },
      });
      expect(decision.plan.policyRationale).toContain("The user must approve the exact local target before the write executes.");
      expect(decision.plan.expiresAt).toBe("2026-01-01T00:05:00.000Z");
    }
    expect(toolRequiresConfirmation("file_rename")).toBe(true);

    const unknown = policy.decide({
      toolName: "missing_tool" as never,
      args: {},
      summary: "Unknown",
      yoloMode: false,
    });
    expect(unknown).toMatchObject({ type: "deny", code: "unknown_tool" });
  });

  it("does not let YOLO bypass shell, system change, external send, browser submit, or coding agent", () => {
    const policy = new ApprovalPolicy();
    for (const toolName of ["advanced_shell_command", "system_sleep", "email_send", "browser_click", "coding_agent_start", "coding_agent_apply_to_repo"] as const) {
      const decision = policy.decide({
        toolName,
        args: toolName === "coding_agent_start" ? { prompt: "plan" } : toolName === "coding_agent_apply_to_repo" ? { taskId: "task-1" } : {},
        summary: toolName,
        yoloMode: true,
      });
      expect(decision.type, toolName).toBe("require_confirmation");
    }
  });

  it("lets active YOLO bypass low-risk local writes but not expired YOLO", () => {
    const policy = new ApprovalPolicy();
    const active = policy.decide({
      toolName: "file_create_folder",
      args: { parentPath: "/tmp", folderName: "ok" },
      summary: "Create folder",
      yoloMode: true,
      yoloExpiresAt: "2026-01-01T00:10:00.000Z",
      now: new Date("2026-01-01T00:00:00.000Z"),
    });
    expect(active.type).toBe("allow");

    const expired = policy.decide({
      toolName: "file_create_folder",
      args: { parentPath: "/tmp", folderName: "ok" },
      summary: "Create folder",
      yoloMode: true,
      yoloExpiresAt: "2025-12-31T23:59:59.000Z",
      now: new Date("2026-01-01T00:00:00.000Z"),
    });
    expect(expired.type).toBe("require_confirmation");
  });
});

describe("capability gate and path allowlist", () => {
  it("blocks disabled capabilities", async () => {
    const userData = makeTmpDir();
    const settings = new SettingsStore(userData);
    settings.setCapabilities({ fileManagement: false });
    const gate = new CapabilityGate(settings, async () => []);

    await expect(gate.assertToolAllowed("file_list", { path: userData })).rejects.toThrow("Capability is disabled: fileManagement");
  });

  it("enforces FileManager allowed directories from config", async () => {
    const allowed = makeTmpDir();
    const outside = makeTmpDir();
    const previous = process.env.HER_ALLOWED_DIRECTORIES;
    process.env.HER_ALLOWED_DIRECTORIES = allowed;
    vi.resetModules();
    const { FileManager } = await import("../../src/main/tools/file-manager");
    const manager = new FileManager();

    expect(manager.resolveAllowed(path.join(allowed, "ok.txt"))).toBe(path.join(allowed, "ok.txt"));
    expect(() => manager.resolveAllowed(path.join(outside, "no.txt"))).toThrow("Path is outside allowed directories");

    if (typeof previous === "string") process.env.HER_ALLOWED_DIRECTORIES = previous;
    else delete process.env.HER_ALLOWED_DIRECTORIES;
  });
});

describe("auth, confirmation, parser, and redaction utilities", () => {
  it("requires a valid bearer token in local API auth middleware", async () => {
    const auth = createLocalApiAuth();
    const app = express();
    app.get("/protected", requireLocalApiAuth(auth), (_req, res) => res.json({ ok: true }));
    const server = await listen(app);
    try {
      expect((await fetch(`http://127.0.0.1:${server.port}/protected`)).status).toBe(401);
      expect((await fetch(`http://127.0.0.1:${server.port}/protected`, { headers: { Authorization: "Bearer bad" } })).status).toBe(401);
      const ok = await fetch(`http://127.0.0.1:${server.port}/protected`, { headers: { Authorization: `Bearer ${auth.token}` } });
      expect(ok.status).toBe(200);
    } finally {
      await server.close();
    }
  });

  it("expires stale confirmations and refuses approval", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:10:01.000Z"));
    const queue = new ConfirmationQueue();
    const plan = createActionPlan({
      toolName: "file_create_folder",
      args: { parentPath: "/tmp", folderName: "x" },
      risk: "local_write",
      summary: "Create folder",
    }, new Date("2026-01-01T00:00:00.000Z"));

    queue.add(plan);
    expect(queue.list()).toHaveLength(0);
    await expect(queue.decide(plan.id, true)).rejects.toThrow("Confirmation request not found or expired.");
  });

  it("parses Codex JSONL and ignores malformed lines", () => {
    expect(parseCodexJsonLine('{"type":"message","message":"hello"}')).toMatchObject({ type: "message", message: "hello" });
    expect(parseCodexJsonLines('{"event":"delta","delta":"x"}\nnot-json\n')).toHaveLength(1);
  });

  it("sanitizes Codex env and task/audit-like secret payloads", () => {
    const env = sanitizeCodexEnv({
      HOME: "/Users/test",
      PATH: "/bin",
      OPENAI_API_KEY: "sk-secret",
      NPM_TOKEN: "npm-secret",
      RANDOM_VALUE: "drop-me",
    });
    expect(env).toEqual({ HOME: "/Users/test", PATH: "/bin" });
    expect(isSecretEnvKey("OPENAI_API_KEY")).toBe(true);
    expect(redactTaskValue({ token: "secret", nested: { password: "pw", ok: true } })).toEqual({
      token: "[redacted]",
      nested: { password: "[redacted]", ok: true },
    });
  });

  it("summarizes context text without exposing secret-like content", () => {
    expect(summarizeText("OPENAI_API_KEY=sk-abcdefghi")).toMatchObject({
      status: "redacted",
      redacted: true,
      preview: "[redacted secret-like content]",
    });
    expect(summarizeText("A short harmless clipboard note")).toMatchObject({
      status: "available",
      preview: "A short harmless clipboard note",
    });
  });

  it("persists redacted artifacts and marks large payloads truncated", () => {
    const userData = makeTmpDir();
    const store = new ArtifactStore(userData);
    const artifact = store.create({
      type: "command_output",
      title: "Command",
      summary: "Ran command",
      sourceTool: "advanced_shell_command",
      sourceTaskId: "task-1",
      payload: {
        command: "echo ok",
        token: "secret",
        ...Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`field${index}`, "x".repeat(800)])),
      },
    });
    expect(artifact.truncated).toBe(true);
    expect(JSON.stringify(artifact.payload)).not.toContain("secret");

    const reloaded = new ArtifactStore(userData);
    expect(reloaded.list(1)[0]).toMatchObject({
      id: artifact.id,
      type: "command_output",
      sourceTaskId: "task-1",
    });
  });

  it("redacts secret-like audit details before writing JSONL", async () => {
    const originalCwd = process.cwd();
    const cwd = makeTmpDir();
    process.chdir(cwd);
    vi.resetModules();
    try {
      const { AuditLog } = await import("../../src/main/audit");
      const audit = new AuditLog();
      audit.write({
        action: "secret-test",
        summary: "redact",
        status: "ok",
        details: {
          OPENAI_API_KEY: "sk-secret",
          plan: {
            toolName: "advanced_shell_command",
            args: { command: "echo ok", OPENAI_API_KEY: "sk-secret", nested: { password: "pw" } },
          },
          nested: { token: "secret", value: "safe" },
        },
      });

      const line = fs.readFileSync(path.join(cwd, "data", "audit.jsonl"), "utf8").trim();
      const entry = JSON.parse(line) as { details: Record<string, unknown> };
      expect(entry.details.OPENAI_API_KEY).toBe("[redacted]");
      expect(entry.details.plan).toEqual({
        toolName: "advanced_shell_command",
        args: { command: "echo ok", OPENAI_API_KEY: "[redacted]", nested: { password: "[redacted]" } },
      });
      expect(entry.details.nested).toEqual({ token: "[redacted]", value: "safe" });
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("builds Codex review artifacts and applies selected worktree files explicitly", async () => {
    const repo = makeTmpDir();
    runGit(repo, ["init", "-b", "main"]);
    fs.writeFileSync(path.join(repo, "README.md"), "before\n");
    runGit(repo, ["add", "README.md"]);
    runGit(repo, ["-c", "user.email=test@example.com", "-c", "user.name=Her Test", "commit", "-m", "init"]);

    const worktree = path.join(makeTmpDir(), "repo");
    runGit(repo, ["worktree", "add", "-b", "her/codex/test-review", worktree]);
    fs.writeFileSync(path.join(worktree, "README.md"), "after\n");
    fs.writeFileSync(path.join(worktree, "notes.md"), "new file\n");

    const task = makeCompletedCodingTask(repo, worktree);
    const review = await buildCodingAgentReview(task);
    expect(review.applyAvailable).toBe(true);
    expect(review.changedFiles).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "README.md", status: "modified" }),
      expect.objectContaining({ path: "notes.md", status: "untracked" }),
    ]));
    expect(review.diffPreview).toContain("-before");
    expect(fs.readFileSync(path.join(repo, "README.md"), "utf8")).toBe("before\n");

    const applied = await applyCodingAgentReviewToRepo({ ...task, review }, { taskId: task.id, paths: ["README.md"] });
    expect(applied.appliedPaths).toEqual(["README.md"]);
    expect(fs.readFileSync(path.join(repo, "README.md"), "utf8")).toBe("after\n");
    expect(fs.existsSync(path.join(repo, "notes.md"))).toBe(false);
  });
});

const makeTmpDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "her-vitest-"));
  tmpDirs.push(dir);
  return dir;
};

const listen = (app: express.Express) =>
  new Promise<{ port: number; close: () => Promise<void> }>((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Missing test server address."));
        return;
      }
      resolve({
        port: address.port,
        close: () => new Promise((done, fail) => server.close((error) => (error ? fail(error) : done()))),
      });
    });
    server.on("error", reject);
  });

const runGit = (cwd: string, args: string[]) => {
  execFileSync("git", args, { cwd, stdio: "pipe" });
};

const makeCompletedCodingTask = (repoPath: string, worktreePath: string): CodingAgentTaskView => ({
  id: "task-review",
  prompt: "fix tests",
  mode: "patch",
  status: "completed",
  repoPath,
  worktreePath,
  branch: "her/codex/test-review",
  sandbox: "workspace-write",
  approvalPolicy: "on-request",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:01:00.000Z",
  completedAt: "2026-01-01T00:01:00.000Z",
  exitCode: 0,
  resultText: "npm run test passed\nFollow-up: review manually",
  eventCount: 0,
  events: [],
});
