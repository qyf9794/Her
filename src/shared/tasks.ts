export type HerTaskStatus =
  | "queued"
  | "running"
  | "awaiting_confirmation"
  | "completed"
  | "failed"
  | "cancelled"
  | "blocked";

export type HerTaskKind = "immediate" | "exclusive" | "long_running";

export type HerTaskPriority = "low" | "normal" | "high";

export type HerTaskSource =
  | "realtime_tool_call"
  | "codex"
  | "manual"
  | "internal";

export type HerTask = {
  id: string;
  kind: HerTaskKind;
  status: HerTaskStatus;
  priority: HerTaskPriority;
  title: string;
  summary: string;
  toolName?: string;
  arguments?: Record<string, unknown>;
  source: HerTaskSource;
  resourceLocks: string[];
  confirmationId?: string;
  parentTaskId?: string;
  childTaskIds: string[];
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  progress?: {
    percent?: number;
    message?: string;
  };
  result?: unknown;
  error?: {
    code: string;
    message: string;
    recoverable?: boolean;
  };
};

export type HerTaskEvent =
  | { type: "task_created"; taskId: string; timestamp: string; task: HerTask }
  | { type: "task_status_changed"; taskId: string; timestamp: string; from: HerTaskStatus; to: HerTaskStatus }
  | { type: "task_progress"; taskId: string; timestamp: string; message: string; percent?: number }
  | { type: "task_confirmation_required"; taskId: string; timestamp: string; confirmationId: string; summary: string }
  | { type: "task_completed"; taskId: string; timestamp: string; result?: unknown }
  | { type: "task_failed"; taskId: string; timestamp: string; error: HerTask["error"] }
  | { type: "task_cancelled"; taskId: string; timestamp: string; reason?: string };

export type HerTaskView = HerTask & {
  events: HerTaskEvent[];
};
