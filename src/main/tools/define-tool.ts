import type { z } from "zod";
import type { CapabilityKey } from "../../shared/app-settings";
import type { ToolGroup, ToolName } from "./metadata";

export type ToolRisk =
  | "read"
  | "local_open"
  | "local_write"
  | "external_send"
  | "browser_submit"
  | "system_change"
  | "shell"
  | "coding_agent";

export type ToolBundle =
  | "core"
  | "filesystem"
  | "documents"
  | "comms"
  | "media"
  | "desktop"
  | "browser"
  | "shell";

export type ToolHandlerContext = {
  source: "realtime" | "local";
};

export type ToolHandler<TArgs = unknown> = (args: TArgs, context: ToolHandlerContext) => Promise<unknown> | unknown;

export type ToolDefinition<TArgs = unknown> = {
  name: ToolName;
  title: string;
  description: string;
  capability?: CapabilityKey;
  group?: ToolGroup;
  bundle: ToolBundle;
  risk: ToolRisk;
  schema?: z.ZodTypeAny;
  realtimeDescription?: string;
  summarize?: (args: TArgs) => string;
  handler?: ToolHandler<TArgs>;
};

export const defineTool = <TArgs>(definition: ToolDefinition<TArgs>) => definition;
