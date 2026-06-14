export type ToolName = string;

export type ToolCallRequest = {
  name: ToolName;
  arguments: Record<string, unknown>;
  callId?: string;
  source?: "realtime" | "local";
};

export type ToolCallResult =
  | {
      ok: true;
      name: ToolName;
      result: unknown;
      requiresConfirmation?: false;
    }
  | {
      ok: true;
      name: ToolName;
      requiresConfirmation: true;
      confirmationId: string;
      summary: string;
      expiresAt: string;
    }
  | {
      ok: false;
      name: ToolName;
      error: string;
      code?: string;
    };

export type ConfirmationDecision = {
  confirmationId: string;
  approved: boolean;
};

export type ConfirmationResult = {
  ok: boolean;
  confirmationId: string;
  result?: unknown;
  error?: string;
};

export type ToolGroup =
  | "permissions"
  | "files"
  | "documents"
  | "text"
  | "media"
  | "social"
  | "research"
  | "phone"
  | "apps"
  | "windows"
  | "system"
  | "browser"
  | "shell"
  | "agents";

export const toolGroups = [
  "permissions",
  "files",
  "documents",
  "text",
  "media",
  "social",
  "research",
  "phone",
  "apps",
  "windows",
  "system",
  "browser",
  "shell",
  "agents",
] as const satisfies readonly ToolGroup[];
