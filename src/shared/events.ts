import type { ConfirmationResult, ToolCallResult } from "./tools";

export type AppEvent =
  | { type: "tool_result"; payload: ToolCallResult }
  | { type: "confirmation_result"; payload: ConfirmationResult }
  | { type: "audit"; payload: AuditEvent };

export type AuditEvent = {
  id: string;
  timestamp: string;
  action: string;
  summary: string;
  status: "ok" | "needs_confirmation" | "rejected" | "error";
};
