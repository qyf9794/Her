import type { ToolCallResult } from "../../shared/tools";
import type { CapabilityGate } from "../capability-gate";
import { ApprovalPolicy, type ActionPlan } from "../policy/approval-policy";
import type { AuditLog } from "../audit";
import { ConfirmationQueue } from "./confirmation";
import { toolManifest, toolRequiresConfirmation } from "./manifest";
import type { ToolName } from "./metadata";

export type ToolSource = "realtime" | "local";

export type ToolRuntimePreflightResult =
  | { ok: true; summary?: string; preview?: unknown }
  | { ok: false; error: string; code?: string };

export type ToolRuntimeOptions = {
  audit: AuditLog;
  confirmations: ConfirmationQueue;
  gate?: CapabilityGate;
  timeoutMs: number;
  isYoloMode: () => boolean;
  yoloExpiresAt?: () => string | undefined;
  summarize: (name: ToolName, args: Record<string, unknown>) => string;
  compactResult: (name: ToolName, result: unknown, source?: ToolSource) => unknown;
  executeManifestHandler: (name: ToolName, args: Record<string, unknown>, source: ToolSource) => Promise<unknown> | unknown;
  preflight?: (name: ToolName, args: Record<string, unknown>, summary: string) => Promise<ToolRuntimePreflightResult> | ToolRuntimePreflightResult;
};

export class ToolRuntime {
  private approvalPolicy = new ApprovalPolicy();

  constructor(private options: ToolRuntimeOptions) {}

  async executeWithTimeout(
    name: ToolName,
    args: Record<string, unknown>,
    source: ToolSource,
    options: { skipTimeout?: boolean } = {},
  ): Promise<ToolCallResult> {
    if (options.skipTimeout) return this.executeValidated(name, args, source);
    try {
      return await withTimeout(
        this.executeValidated(name, args, source),
        this.options.timeoutMs,
        `${name} timed out after ${this.options.timeoutMs}ms`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.options.audit.write({ action: name, summary: message, status: "error" });
      return { ok: false, name, error: message, code: "tool_timeout" };
    }
  }

  async executeValidated(name: ToolName, args: Record<string, unknown>, source: ToolSource = "local"): Promise<ToolCallResult> {
    const planned = await this.planAction(name, args);
    if (!planned.ok) return planned.result;

    try {
      const result = await this.options.executeManifestHandler(name, args, source);
      this.options.audit.write({ action: name, summary: planned.summary, status: "ok" });
      return { ok: true, name, result: this.options.compactResult(name, result, source) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.options.audit.write({ action: name, summary: message, status: "error" });
      return { ok: false, name, error: message };
    }
  }

  async executeControl(
    name: ToolName,
    args: Record<string, unknown>,
    source: ToolSource,
    run: () => Promise<unknown> | unknown,
    options: { skipCapabilityGate?: boolean; skipPreflight?: boolean } = {},
  ): Promise<ToolCallResult> {
    if (toolRequiresConfirmation(name)) {
      const planned = await this.planAction(name, args, {
        skipCapabilityGate: options.skipCapabilityGate,
        skipPreflight: options.skipPreflight,
      });
      if (!planned.ok) return planned.result;
    }

    const summary = this.options.summarize(name, args);
    try {
      const result = await run();
      this.options.audit.write({ action: name, summary, status: "ok" });
      return { ok: true, name, result: this.options.compactResult(name, result, source) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.options.audit.write({ action: name, summary: message, status: "error" });
      return { ok: false, name, error: message };
    }
  }

  async executeActionPlan(plan: ActionPlan): Promise<unknown> {
    const result = await this.options.executeManifestHandler(plan.toolName, plan.args, "local");
    return this.options.compactResult(plan.toolName, result);
  }

  private async planAction(
    name: ToolName,
    args: Record<string, unknown>,
    options: { skipCapabilityGate?: boolean; skipPreflight?: boolean } = {},
  ): Promise<{ ok: true; summary: string } | { ok: false; result: ToolCallResult }> {
    let summary = this.options.summarize(name, args);
    let preview: unknown;

    if (!options.skipCapabilityGate && this.options.gate) {
      try {
        await this.options.gate.assertToolAllowed(name, args);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.options.audit.write({ action: name, summary: message, status: "error" });
        return { ok: false, result: { ok: false, name, error: message, code: "capability_denied" } };
      }
    }

    if (!options.skipPreflight && this.options.preflight) {
      const preflight = await this.options.preflight(name, args, summary);
      if (!preflight.ok) {
        this.options.audit.write({ action: name, summary: preflight.error, status: "error" });
        return { ok: false, result: { ok: false, name, error: preflight.error, code: preflight.code } };
      }
      summary = preflight.summary ?? summary;
      preview = preflight.preview;
    }

    const approval = this.approvalPolicy.decide({
      toolName: name,
      args,
      summary,
      preview,
      yoloMode: this.options.isYoloMode(),
      yoloExpiresAt: this.options.yoloExpiresAt?.(),
    });
    if (approval.type === "deny") {
      this.options.audit.write({ action: name, summary: approval.reason, status: "error" });
      return { ok: false, result: { ok: false, name, error: approval.reason, code: approval.code } };
    }
    if (approval.type === "require_confirmation") {
      const confirmation = this.options.confirmations.add(approval.plan);
      this.options.audit.write({ action: name, summary, status: "needs_confirmation" });
      return {
        ok: false,
        result: {
          ok: true,
          name,
          requiresConfirmation: true,
          confirmationId: confirmation.id,
          summary,
          expiresAt: new Date(confirmation.expiresAt).toISOString(),
          risk: confirmation.plan.risk,
          riskLabel: confirmation.plan.riskLabel,
          target: confirmation.plan.target,
          preview: confirmation.plan.preview,
          reversible: confirmation.plan.reversible,
          policyRationale: confirmation.plan.policyRationale,
          taskId: confirmation.plan.taskId,
        },
      };
    }

    return { ok: true, summary };
  }
}

export const isManifestToolName = (name: string): name is ToolName =>
  Object.prototype.hasOwnProperty.call(toolManifest, name);

const withTimeout = <T>(promise: Promise<T>, timeoutMs: number, message: string) =>
  new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
