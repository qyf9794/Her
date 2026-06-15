import { randomUUID } from "node:crypto";
import type { ToolName } from "../tools/metadata";
import { toolManifest, toolRequiresConfirmation } from "../tools/manifest";
import type { ToolRisk } from "../tools/define-tool";

export type ActionPlan = {
  id: string;
  toolName: ToolName;
  args: Record<string, unknown>;
  risk: ToolRisk;
  riskLabel: string;
  summary: string;
  target?: string;
  preview?: unknown;
  reversible: boolean;
  policyRationale: string[];
  policy: {
    name: string;
    rationale: string[];
  };
  taskId?: string;
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
    yoloExpiresAt?: string;
    now?: Date;
  }): ApprovalDecision {
    const now = input.now ?? new Date();
    const metadata = toolManifest[input.toolName];
    if (!metadata) {
      return { type: "deny", reason: `Unknown tool: ${input.toolName}`, code: "unknown_tool" };
    }

    if (!toolRequiresConfirmation(input.toolName)) {
      return { type: "allow", risk: metadata.risk };
    }

    if (input.yoloMode && yoloIsActive(input.yoloExpiresAt, now) && yoloMayBypass(metadata.risk)) {
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
      }, now),
    };
  }
}

export const createActionPlan = (
  input: Pick<ActionPlan, "toolName" | "args" | "risk" | "summary" | "preview"> & Partial<Pick<ActionPlan, "target" | "policyRationale" | "taskId">>,
  now = new Date(),
): ActionPlan => {
  const expiresAt = new Date(now.getTime() + 5 * 60 * 1000);
  const policy = policyForRisk(input.risk, input.toolName, input.args);
  const policyRationale = input.policyRationale ?? policy.rationale;
  return {
    id: randomUUID(),
    toolName: input.toolName,
    args: input.args,
    risk: input.risk,
    riskLabel: riskLabel(input.risk),
    summary: input.summary,
    target: input.target ?? inferTarget(input.risk, input.args),
    preview: input.preview,
    reversible: isReversible(input.risk),
    policyRationale,
    policy: {
      name: policy.name,
      rationale: policyRationale,
    },
    taskId: input.taskId,
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };
};

const yoloMayBypass = (risk: ToolRisk) => risk === "local_write" || risk === "local_open";

const yoloIsActive = (expiresAt: string | undefined, now: Date) =>
  !expiresAt || Date.parse(expiresAt) > now.getTime();

const isReversible = (risk: ToolRisk) => risk === "local_write" || risk === "local_open" || risk === "system_change";

const riskLabel = (risk: ToolRisk) => {
  if (risk === "read") return "Read";
  if (risk === "local_open") return "Local open";
  if (risk === "local_write") return "Local write";
  if (risk === "external_send") return "External send";
  if (risk === "browser_submit") return "Browser submit";
  if (risk === "system_change") return "System change";
  if (risk === "shell") return "Shell";
  if (risk === "coding_agent") return "Coding agent";
  return risk;
};

const policyForRisk = (risk: ToolRisk, toolName: ToolName, args: Record<string, unknown>) => {
  if (risk === "local_write") {
    return {
      name: "path-policy",
      rationale: [
        "This changes a local file, folder, document, alias, or draft.",
        "The user must approve the exact local target before the write executes.",
      ],
    };
  }
  if (risk === "external_send") {
    return {
      name: "external-send-policy",
      rationale: [
        "This may send information outside the local machine.",
        "The user must approve the recipient, destination, or publishing target.",
      ],
    };
  }
  if (risk === "browser_submit") {
    return {
      name: "browser-submit-policy",
      rationale: [
        "This may click, submit, publish, delete, pay, or otherwise act inside a web page.",
        "The user must approve the page action before Her performs it.",
      ],
    };
  }
  if (risk === "shell") {
    return {
      name: "shell-policy",
      rationale: [
        "This runs a local shell command.",
        "Shell commands require explicit approval even when YOLO mode is enabled.",
      ],
    };
  }
  if (risk === "coding_agent") {
    return {
      name: "coding-agent-policy",
      rationale: [
        "This starts or controls an asynchronous coding agent.",
        "Coding-agent work requires explicit approval and runs under Her task tracking.",
      ],
    };
  }
  if (risk === "system_change") {
    return {
      name: "system-change-policy",
      rationale: [
        "This changes local system, app, window, shortcut, or device state.",
        "System changes require explicit user approval.",
      ],
    };
  }
  return {
    name: `${risk}-policy`,
    rationale: [`${toolName} is classified as ${risk}.`, `Target: ${inferTarget(risk, args) ?? "local runtime"}.`],
  };
};

const inferTarget = (risk: ToolRisk, args: Record<string, unknown>) => {
  for (const key of ["path", "parentPath", "from", "to", "url", "draftId", "repoPath", "appName", "name", "selector", "command"]) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return `${key}: ${value.trim()}`;
  }
  if (risk === "coding_agent") return "coding agent task";
  if (risk === "shell") return "local shell";
  if (risk === "external_send") return "external destination";
  if (risk === "browser_submit") return "browser page";
  if (risk === "system_change") return "local system";
  return undefined;
};
