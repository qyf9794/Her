export type CodingAgentMode = "plan" | "review" | "patch" | "test_fix";

export type CodingAgentSandbox = "read-only" | "workspace-write";

export type CodingAgentStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type CodingAgentEvent = {
  id: string;
  taskId: string;
  at: string;
  level: "info" | "warning" | "error";
  message: string;
  kind?: string;
};

export type CodingAgentChangedFile = {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed" | "copied" | "untracked" | "unknown";
};

export type CodingAgentReview = {
  generatedAt: string;
  summary: string;
  changedFiles: CodingAgentChangedFile[];
  diffPreview: string;
  diffTruncated: boolean;
  tests: string[];
  followUps: string[];
  applyAvailable: boolean;
};

export type CodingAgentTask = {
  id: string;
  prompt: string;
  mode: CodingAgentMode;
  status: CodingAgentStatus;
  repoPath: string;
  worktreePath?: string;
  branch?: string;
  sandbox: CodingAgentSandbox;
  approvalPolicy: "on-request";
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  exitCode?: number | null;
  error?: string;
  resultText?: string;
  review?: CodingAgentReview;
  appliedAt?: string;
  appliedPaths?: string[];
  eventCount: number;
};

export type CodingAgentTaskView = CodingAgentTask & {
  events: CodingAgentEvent[];
};

export type CodingAgentStartInput = {
  prompt: string;
  repoPath?: string;
  mode?: CodingAgentMode;
  timeoutMs?: number;
};

export type CodingAgentContinueInput = {
  taskId: string;
  prompt: string;
  timeoutMs?: number;
};

export type CodingAgentApplyInput = {
  taskId: string;
  paths?: string[];
};

export type CodingAgentApplyResult = {
  task: CodingAgentTaskView;
  appliedPaths: string[];
  deletedPaths: string[];
  review: CodingAgentReview;
};
