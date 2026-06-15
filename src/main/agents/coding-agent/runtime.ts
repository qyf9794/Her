import path from "node:path";
import { config } from "../../config";
import { applyCodingAgentReviewToRepo, buildCodingAgentReview } from "./artifact-adapter";
import { CodexExecRunner } from "./codex-exec-runner";
import { CodingAgentTaskStore } from "./task-store";
import { CodingAgentWorktreeManager } from "./worktree-manager";
import type {
  CodingAgentApplyInput,
  CodingAgentContinueInput,
  CodingAgentMode,
  CodingAgentSandbox,
  CodingAgentStartInput,
  CodingAgentStatus,
} from "../../../shared/agents/coding-agent";

export class CodingAgentRuntime {
  constructor(
    private store = new CodingAgentTaskStore(),
    private worktrees = new CodingAgentWorktreeManager(),
    private runner = new CodexExecRunner(),
  ) {}

  start(input: CodingAgentStartInput) {
    if (!config.codexEnabled) throw new Error("Codex provider is disabled. HER will not fall back to another provider.");
    const mode = input.mode ?? "plan";
    const repoPath = path.resolve(input.repoPath || process.cwd());
    const task = this.store.create({
      prompt: input.prompt,
      mode,
      repoPath,
      sandbox: sandboxForMode(mode),
    });
    this.store.addEvent(task.id, { level: "info", kind: "queued", message: "Coding agent task queued." });
    void this.runTask(task.id, input.prompt, input.timeoutMs ?? config.codexTurnTimeoutMs);
    return {
      task: this.get(task.id),
      note: "Coding agent task started asynchronously. Use coding_agent_status or the Agent Runs panel to monitor it.",
    };
  }

  continue(input: CodingAgentContinueInput) {
    const task = this.store.require(input.taskId);
    if (task.status === "running") throw new Error("Cannot continue a task while it is still running.");
    if (!task.worktreePath) throw new Error("Cannot continue before the task worktree exists.");
    this.store.update(task.id, {
      prompt: `${task.prompt}\n\nFollow-up:\n${input.prompt}`,
      status: "queued",
      completedAt: undefined,
      error: undefined,
      resultText: undefined,
      exitCode: undefined,
    });
    this.store.addEvent(task.id, { level: "info", kind: "continue", message: "Queued follow-up Codex turn." });
    void this.runCodexInWorktree(task.id, input.prompt, input.timeoutMs ?? config.codexTurnTimeoutMs);
    return {
      task: this.get(task.id),
      note: "Coding agent follow-up started asynchronously.",
    };
  }

  status(taskId: string) {
    return { task: this.get(taskId) };
  }

  result(taskId: string) {
    const task = this.get(taskId);
    return {
      task,
      result: task.resultText,
      worktreePath: task.worktreePath,
      branch: task.branch,
      review: task.review,
    };
  }

  async review(taskId: string) {
    const task = this.get(taskId);
    const review = await buildCodingAgentReview(task);
    this.store.update(taskId, { review });
    return { task: this.get(taskId), review };
  }

  async applyToRepo(input: CodingAgentApplyInput) {
    const task = this.get(input.taskId);
    const review = task.review ?? (await this.review(input.taskId)).review;
    const applied = await applyCodingAgentReviewToRepo({ ...task, review }, input);
    this.store.update(input.taskId, {
      review: applied.review,
      appliedAt: new Date().toISOString(),
      appliedPaths: [...applied.appliedPaths, ...applied.deletedPaths],
    });
    this.store.addEvent(input.taskId, {
      level: "info",
      kind: "apply",
      message: `Applied ${applied.appliedPaths.length + applied.deletedPaths.length} Codex file change(s) to the original repository.`,
    });
    return { ...applied, task: this.get(input.taskId) };
  }

  async waitForTerminal(taskId: string, timeoutMs = config.codexTurnTimeoutMs + 60000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const task = this.get(taskId);
      if (task.status === "completed" || task.status === "failed" || task.status === "cancelled") return task;
      await delay(500);
    }
    throw new Error(`Timed out waiting for coding agent task: ${taskId}`);
  }

  list(status?: CodingAgentStatus, limit = 10) {
    return { tasks: this.store.list(limit, status) };
  }

  cancel(taskId: string) {
    const task = this.store.require(taskId);
    if (task.status !== "queued" && task.status !== "running") {
      return { task: this.get(taskId), cancelled: false, reason: `Task is already ${task.status}.` };
    }
    const killed = this.runner.cancel(taskId);
    this.store.update(taskId, {
      status: "cancelled",
      completedAt: new Date().toISOString(),
      error: killed ? "Cancelled by user." : "Cancelled before Codex process started.",
    });
    this.store.addEvent(taskId, { level: "warning", kind: "cancel", message: "Coding agent task cancelled." });
    return { task: this.get(taskId), cancelled: true };
  }

  private get(taskId: string) {
    const task = this.store.get(taskId);
    if (!task) throw new Error(`Coding agent task not found: ${taskId}`);
    return task;
  }

  private async runTask(taskId: string, prompt: string, timeoutMs: number) {
    try {
      const task = this.store.require(taskId);
      this.store.update(taskId, { status: "running", startedAt: new Date().toISOString() });
      this.store.addEvent(taskId, { level: "info", kind: "worktree", message: "Creating isolated git worktree." });
      const worktree = await this.worktrees.create(taskId, task.repoPath);
      this.store.update(taskId, {
        worktreePath: worktree.worktreePath,
        branch: worktree.branch,
      });
      await this.runCodexInWorktree(taskId, prompt, timeoutMs);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (this.store.require(taskId).status === "cancelled") return;
      this.store.update(taskId, {
        status: "failed",
        completedAt: new Date().toISOString(),
        error: message,
      });
      this.store.addEvent(taskId, { level: "error", kind: "error", message });
    }
  }

  private async runCodexInWorktree(taskId: string, prompt: string, timeoutMs: number) {
    const task = this.store.require(taskId);
    if (!task.worktreePath) throw new Error("Missing coding agent worktree.");
    this.store.update(taskId, { status: "running", startedAt: task.startedAt ?? new Date().toISOString() });
    this.store.addEvent(taskId, {
      level: "info",
      kind: "codex_exec",
      message: `Launching codex exec --json in ${task.worktreePath}.`,
    });
    try {
      const result = await this.runner.run({
        taskId,
        prompt,
        cwd: task.worktreePath,
        sandbox: task.sandbox,
        timeoutMs,
        onEvent: (event) => this.store.addEvent(taskId, event),
      });
      if (this.store.require(taskId).status === "cancelled") return;
      this.store.update(taskId, {
        status: "completed",
        completedAt: new Date().toISOString(),
        exitCode: result.exitCode,
        resultText: result.resultText,
      });
      const review = await buildCodingAgentReview(this.get(taskId));
      this.store.update(taskId, { review });
      this.store.addEvent(taskId, { level: "info", kind: "complete", message: "Coding agent task completed." });
    } catch (error) {
      if (this.store.require(taskId).status === "cancelled") return;
      const message = error instanceof Error ? error.message : String(error);
      this.store.update(taskId, {
        status: "failed",
        completedAt: new Date().toISOString(),
        error: message,
      });
      this.store.addEvent(taskId, { level: "error", kind: "error", message });
    }
  }
}

export const sandboxForMode = (mode: CodingAgentMode): CodingAgentSandbox =>
  mode === "patch" || mode === "test_fix" ? "workspace-write" : "read-only";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
