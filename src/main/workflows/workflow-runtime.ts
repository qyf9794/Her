import crypto from "node:crypto";
import { assertNoSecretLikeArguments } from "../memory/alias-validation";
import { toolManifest, toolRequiresConfirmation } from "../tools/manifest";
import type { ToolName } from "../tools/metadata";
import type { ToolCallResult } from "../../shared/tools";
import type { HerTaskView } from "../../shared/tasks";
import type {
  WorkflowPack,
  WorkflowPackPreview,
  WorkflowPackStep,
  WorkflowRun,
  WorkflowRunEvent,
  WorkflowRunStep,
} from "../../shared/workflows";
import { builtInWorkflowPacks, workflowPackById } from "./workflow-packs";

type WorkflowRuntimeOptions = {
  executeTool: (toolName: ToolName, args: Record<string, unknown>) => Promise<ToolCallResult>;
  readTask: (taskId: string) => HerTaskView | undefined;
  cancelTask: (taskId: string) => unknown;
  rejectConfirmation: (confirmationId: string) => Promise<unknown>;
};

export class WorkflowRuntime {
  private readonly runs = new Map<string, WorkflowRun>();

  constructor(private readonly options: WorkflowRuntimeOptions) {}

  listPacks(query?: string) {
    const normalized = query?.trim().toLowerCase();
    const packs = normalized
      ? builtInWorkflowPacks.filter((pack) => `${pack.title} ${pack.description} ${pack.triggers.join(" ")}`.toLowerCase().includes(normalized))
      : builtInWorkflowPacks;
    return { packs: packs.map((pack) => this.packSummary(pack)) };
  }

  inspectPack(packId: string) {
    return { pack: this.requirePack(packId) };
  }

  previewPack(packId: string, parameters: Record<string, string> = {}): { preview: WorkflowPackPreview } {
    const pack = this.requirePack(packId);
    const resolvedParameters = resolveParameters(pack, parameters);
    assertNoSecretLikeArguments(resolvedParameters);
    const steps = pack.steps.map((step) => this.previewStep(step, resolvedParameters));
    return {
      preview: {
        ...pack,
        steps,
        requiredCapabilities: unique([...pack.requiredCapabilities, ...steps.map((step) => step.capability).filter(Boolean)] as never[]),
        risks: unique([...pack.risks, ...steps.map((step) => step.risk)]),
        requiresConfirmation: steps.some((step) => step.requiresConfirmation),
      },
    };
  }

  async runPack(packId: string, parameters: Record<string, string> = {}) {
    const { preview } = this.previewPack(packId, parameters);
    const run = this.createRun(preview, resolveParameters(this.requirePack(packId), parameters));
    this.runs.set(run.id, run);
    this.addEvent(run, "workflow_started", `Started ${preview.title}.`);

    for (const [index, stepPreview] of preview.steps.entries()) {
      const step = run.steps[index];
      if (run.status === "cancelled") {
        this.skipRemaining(run, index, "Workflow was cancelled.");
        break;
      }

      step.status = "running";
      step.startedAt = now();
      this.touch(run);
      this.addEvent(run, "workflow_step_started", `Started ${step.title}.`, step);

      const result = await this.options.executeTool(step.toolName as ToolName, stepPreview.resolvedArguments);
      step.result = compactStepResult(result);

      const childTaskId = childTaskIdFromResult(result);
      if (childTaskId) {
        step.childTaskId = childTaskId;
        const childTask = await this.waitForChildTask(childTaskId);
        if (childTask?.status === "awaiting_confirmation") {
          step.status = "awaiting_confirmation";
          step.confirmationId = childTask.confirmationId;
          run.status = "awaiting_confirmation";
          this.touch(run);
          this.addEvent(run, "workflow_step_awaiting_confirmation", `${step.title} is waiting for confirmation.`, step);
          return { run };
        }
        if (childTask?.status === "failed") {
          step.status = "failed";
          step.error = childTask.error?.message ?? "Child task failed.";
          this.failOrContinue(run, step, index, step.error);
          if (run.status === "failed") return { run };
          continue;
        }
        if (childTask?.status === "cancelled") {
          step.status = "cancelled";
          step.completedAt = now();
          run.status = "cancelled";
          run.cancelledAt = step.completedAt;
          this.skipRemaining(run, index + 1, "Workflow child task was cancelled.");
          this.addEvent(run, "workflow_cancelled", `${step.title} was cancelled.`, step);
          return { run };
        }
      }

      if (result.ok && "requiresConfirmation" in result && result.requiresConfirmation) {
        step.status = "awaiting_confirmation";
        step.confirmationId = result.confirmationId;
        run.status = "awaiting_confirmation";
        this.touch(run);
        this.addEvent(run, "workflow_step_awaiting_confirmation", `${step.title} is waiting for confirmation.`, step);
        return { run };
      }

      if (!result.ok) {
        step.status = "failed";
        step.error = result.error;
        this.failOrContinue(run, step, index, result.error);
        if (run.status === "failed") return { run };
        continue;
      }

      step.status = "completed";
      step.completedAt = now();
      this.touch(run);
      this.addEvent(run, "workflow_step_completed", `Completed ${step.title}.`, step);
    }

    if (run.status !== "cancelled" && run.status !== "failed" && run.status !== "awaiting_confirmation") {
      run.status = "completed";
      run.completedAt = now();
      this.touch(run);
      this.addEvent(run, "workflow_completed", `Completed ${run.title}.`);
    }
    return { run };
  }

  async cancelRun(runId: string) {
    const run = this.requireRun(runId);
    if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") {
      return { run, cancelled: false, reason: `Workflow is already ${run.status}.` };
    }

    run.status = "cancelled";
    run.cancelledAt = now();
    run.completedAt = run.cancelledAt;
    for (const step of run.steps) {
      if (step.status === "pending" || step.status === "running" || step.status === "awaiting_confirmation") {
        if (step.confirmationId) await this.safeRejectConfirmation(step.confirmationId);
        if (step.childTaskId) this.safeCancelTask(step.childTaskId);
        step.status = step.status === "awaiting_confirmation" ? "cancelled" : "skipped";
        step.completedAt = run.cancelledAt;
      }
    }
    this.touch(run);
    this.addEvent(run, "workflow_cancelled", `Cancelled ${run.title}.`);
    return { run, cancelled: true };
  }

  status(runId: string) {
    return { run: this.requireRun(runId) };
  }

  listRuns(limit = 10) {
    return {
      runs: [...this.runs.values()]
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, limit),
    };
  }

  private requirePack(packId: string) {
    const pack = workflowPackById.get(packId);
    if (!pack) throw new WorkflowValidationError(`Workflow pack not found: ${packId}`, "workflow_pack_not_found");
    return pack;
  }

  private requireRun(runId: string) {
    const run = this.runs.get(runId);
    if (!run) throw new WorkflowValidationError(`Workflow run not found: ${runId}`, "workflow_run_not_found");
    return run;
  }

  private packSummary(pack: WorkflowPack) {
    return {
      id: pack.id,
      title: pack.title,
      description: pack.description,
      triggers: pack.triggers,
      requiredCapabilities: pack.requiredCapabilities,
      risks: pack.risks,
      stepCount: pack.steps.length,
    };
  }

  private previewStep(step: WorkflowPackStep, parameters: Record<string, string>) {
    const toolName = step.toolName as ToolName;
    const entry = toolManifest[toolName];
    if (!entry) throw new WorkflowValidationError(`Unknown workflow step tool: ${step.toolName}`, "workflow_step_unknown_tool");
    const resolvedArguments = substituteArguments(step.arguments, parameters);
    return {
      ...step,
      resolvedArguments,
      summary: entry.summarize(resolvedArguments),
      risk: entry.risk,
      riskLabel: riskLabel(entry.risk),
      capability: entry.capability,
      requiresConfirmation: toolRequiresConfirmation(toolName),
    };
  }

  private createRun(preview: WorkflowPackPreview, parameters: Record<string, string>): WorkflowRun {
    const createdAt = now();
    return {
      id: crypto.randomUUID(),
      packId: preview.id,
      title: preview.title,
      status: "running",
      parameters,
      createdAt,
      updatedAt: createdAt,
      steps: preview.steps.map((step): WorkflowRunStep => ({
        id: step.id,
        title: step.title,
        toolName: step.toolName,
        status: "pending",
        summary: step.summary,
        risk: step.risk,
        capability: step.capability,
        requiresConfirmation: step.requiresConfirmation,
        rollbackNote: step.rollbackNote,
      })),
      events: [],
    };
  }

  private failOrContinue(run: WorkflowRun, step: WorkflowRunStep, index: number, error: string) {
    step.completedAt = now();
    this.addEvent(run, "workflow_step_failed", `${step.title} failed: ${error}`, step, error);
    const pack = this.requirePack(run.packId);
    if (pack.steps[index]?.optional) {
      this.touch(run);
      return;
    }
    run.status = "failed";
    run.error = error;
    run.completedAt = now();
    this.skipRemaining(run, index + 1, "Workflow stopped after a required step failed.");
    this.touch(run);
  }

  private skipRemaining(run: WorkflowRun, startIndex: number, reason: string) {
    for (const step of run.steps.slice(startIndex)) {
      if (step.status !== "pending" && step.status !== "running") continue;
      step.status = "skipped";
      step.completedAt = now();
      this.addEvent(run, "workflow_step_skipped", `${step.title} skipped. ${reason}`, step);
    }
  }

  private async waitForChildTask(taskId: string) {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const task = this.options.readTask(taskId);
      if (!task || !["queued", "running", "blocked"].includes(task.status)) return task;
      await delay(50);
    }
    return this.options.readTask(taskId);
  }

  private safeCancelTask(taskId: string) {
    try {
      this.options.cancelTask(taskId);
    } catch {
      // Cancellation is best-effort; the workflow run still records local cancellation.
    }
  }

  private async safeRejectConfirmation(confirmationId: string) {
    try {
      await this.options.rejectConfirmation(confirmationId);
    } catch {
      // The confirmation may already have been decided or expired.
    }
  }

  private addEvent(run: WorkflowRun, type: WorkflowRunEvent["type"], message: string, step?: WorkflowRunStep, error?: string) {
    run.events.push({
      id: crypto.randomUUID(),
      timestamp: now(),
      type,
      message,
      stepId: step?.id,
      toolName: step?.toolName,
      confirmationId: step?.confirmationId,
      childTaskId: step?.childTaskId,
      error,
    });
    if (run.events.length > 200) run.events.splice(0, run.events.length - 200);
    this.touch(run);
  }

  private touch(run: WorkflowRun) {
    run.updatedAt = now();
  }
}

export class WorkflowValidationError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
  }
}

export const toWorkflowValidationCode = (error: unknown) =>
  error instanceof WorkflowValidationError ? error.code : "workflow_invalid";

const resolveParameters = (pack: WorkflowPack, provided: Record<string, string>) => {
  const resolved: Record<string, string> = {};
  for (const parameter of pack.parameters) {
    const value = provided[parameter.name] ?? parameter.defaultValue;
    if (parameter.required && !value) {
      throw new WorkflowValidationError(`Missing workflow parameter: ${parameter.name}`, "workflow_parameter_missing");
    }
    if (value !== undefined) resolved[parameter.name] = value;
  }
  for (const [key, value] of Object.entries(provided)) resolved[key] = value;
  return resolved;
};

const substituteArguments = (args: Record<string, unknown>, parameters: Record<string, string>) => {
  const substituted = substituteValue(args, parameters);
  if (!substituted || typeof substituted !== "object" || Array.isArray(substituted)) return {};
  assertNoSecretLikeArguments(substituted);
  return substituted as Record<string, unknown>;
};

const substituteValue = (value: unknown, parameters: Record<string, string>): unknown => {
  if (typeof value === "string") {
    return value.replace(/\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g, (_match, key: string) => parameters[key] ?? "");
  }
  if (Array.isArray(value)) return value.map((item) => substituteValue(item, parameters));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, nested]) => [key, substituteValue(nested, parameters)]));
  }
  return value;
};

const childTaskIdFromResult = (result: ToolCallResult) => {
  if (!result.ok) return undefined;
  if ("requiresConfirmation" in result && result.requiresConfirmation) return undefined;
  const payload = result.result;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const task = (payload as { task?: { id?: unknown; taskId?: unknown } }).task;
  const id = task?.id ?? task?.taskId;
  return typeof id === "string" ? id : undefined;
};

const compactStepResult = (result: ToolCallResult) => {
  if (!result.ok) return { ok: false, error: result.error, code: result.code };
  if ("requiresConfirmation" in result && result.requiresConfirmation) {
    return {
      ok: true,
      requiresConfirmation: true,
      confirmationId: result.confirmationId,
      summary: result.summary,
      risk: result.risk,
      target: result.target,
    };
  }
  return compactPayload(result.result);
};

const compactPayload = (value: unknown) => {
  const serialized = stableStringify(value);
  if (serialized.length <= 800) return value;
  return {
    truncated: true,
    preview: serialized.slice(0, 800),
    originalChars: serialized.length,
  };
};

const stableStringify = (value: unknown) => {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const now = () => new Date().toISOString();
const unique = <T>(values: T[]) => [...new Set(values)];
const riskLabel = (risk: string) =>
  risk
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
