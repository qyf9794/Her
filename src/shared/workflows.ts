import type { CapabilityKey } from "./app-settings";

export type WorkflowRunStatus = "running" | "awaiting_confirmation" | "completed" | "failed" | "cancelled";
export type WorkflowRunStepStatus = "pending" | "running" | "awaiting_confirmation" | "completed" | "failed" | "skipped" | "cancelled";

export type WorkflowPackParameter = {
  name: string;
  description?: string;
  required?: boolean;
  defaultValue?: string;
};

export type WorkflowPackStep = {
  id: string;
  title: string;
  toolName: string;
  arguments: Record<string, unknown>;
  optional?: boolean;
  rollbackNote?: string;
};

export type WorkflowPack = {
  id: string;
  title: string;
  description: string;
  triggers: string[];
  parameters: WorkflowPackParameter[];
  requiredCapabilities: CapabilityKey[];
  risks: string[];
  steps: WorkflowPackStep[];
  rollbackNotes: string[];
};

export type WorkflowPackStepPreview = WorkflowPackStep & {
  resolvedArguments: Record<string, unknown>;
  summary: string;
  risk: string;
  riskLabel: string;
  capability?: CapabilityKey;
  requiresConfirmation: boolean;
};

export type WorkflowPackPreview = Omit<WorkflowPack, "steps"> & {
  steps: WorkflowPackStepPreview[];
  requiresConfirmation: boolean;
};

export type WorkflowRunEvent = {
  id: string;
  timestamp: string;
  type:
    | "workflow_started"
    | "workflow_step_started"
    | "workflow_step_completed"
    | "workflow_step_awaiting_confirmation"
    | "workflow_step_failed"
    | "workflow_step_skipped"
    | "workflow_cancelled"
    | "workflow_completed";
  message: string;
  stepId?: string;
  toolName?: string;
  confirmationId?: string;
  childTaskId?: string;
  error?: string;
};

export type WorkflowRunStep = {
  id: string;
  title: string;
  toolName: string;
  status: WorkflowRunStepStatus;
  summary: string;
  risk: string;
  capability?: CapabilityKey;
  requiresConfirmation: boolean;
  startedAt?: string;
  completedAt?: string;
  confirmationId?: string;
  childTaskId?: string;
  error?: string;
  result?: unknown;
  rollbackNote?: string;
};

export type WorkflowRun = {
  id: string;
  packId: string;
  title: string;
  status: WorkflowRunStatus;
  parameters: Record<string, string>;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  cancelledAt?: string;
  steps: WorkflowRunStep[];
  events: WorkflowRunEvent[];
  error?: string;
};
