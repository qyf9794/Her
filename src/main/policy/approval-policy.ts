import { randomUUID } from "node:crypto";
import type { ToolName } from "../tools/metadata";
import { toolManifest, toolRequiresConfirmation } from "../tools/manifest";
import type { ToolRisk } from "../tools/define-tool";

export type ActionPlan = {
  id: string;
  toolName: ToolName;
  args: Record<string, unknown>;
  risk: ToolRisk;
  summary: string;
  preview?: unknown;
  reversible: boolean;
  createdAt: string;
  expiresAt: string;
};

export type ApprovalDecision =
  | { type: "allow"; risk: ToolRisk }
  | { type: "require_confirmation"; plan: ActionPlan }
  | { type: "deny"; reason: string; code: string };

export class ApprovalPolicy {
  decide(input: {
    toolName: ToolName;
    args: Record<string, unknown>;
    summary: string;
    preview?: unknown;
    yoloMode: boolean;
    now?: Date;
  }): ApprovalDecision {
    const metadata = toolManifest[input.toolName];
    if (!metadata) {
      return { type: "deny", reason: `Unknown tool: ${input.toolName}`, code: "unknown_tool" };
    }

    if (!toolRequiresConfirmation(input.toolName)) {
      return { type: "allow", risk: metadata.risk };
    }

    if (input.yoloMode && yoloMayBypass(metadata.risk)) {
      return { type: "allow", risk: metadata.risk };
    }

    return {
      type: "require_confirmation",
      plan: createActionPlan({
        toolName: input.toolName,
        args: input.args,
        risk: metadata.risk,
        summary: input.summary,
        preview: input.preview,
      }, input.now),
    };
  }
}

export const createActionPlan = (
  input: Pick<ActionPlan, "toolName" | "args" | "risk" | "summary" | "preview">,
  now = new Date(),
): ActionPlan => {
  const expiresAt = new Date(now.getTime() + 5 * 60 * 1000);
  return {
    id: randomUUID(),
    toolName: input.toolName,
    args: input.args,
    risk: input.risk,
    summary: input.summary,
    preview: input.preview,
    reversible: isReversible(input.risk),
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };
};

const yoloMayBypass = (risk: ToolRisk) => risk === "local_write" || risk === "local_open";

const isReversible = (risk: ToolRisk) => risk === "local_write" || risk === "local_open" || risk === "system_change";
