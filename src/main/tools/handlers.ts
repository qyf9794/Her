import type { ToolName } from "./metadata";
import type { ToolHandler } from "./define-tool";
import { allToolDefinitions } from "./metadata";

export type ToolHandlerRuntime = {
  invokeToolHandler: (name: ToolName, args: Record<string, unknown>, source: "realtime" | "local") => Promise<unknown> | unknown;
};

export const toolHandlerNames = allToolDefinitions.map((definition) => definition.name) as ToolName[];

export const createToolHandlers = (runtime: ToolHandlerRuntime): Record<ToolName, ToolHandler<Record<string, unknown>>> =>
  Object.fromEntries(
    toolHandlerNames.map((name) => [
      name,
      (args: Record<string, unknown>, context) => runtime.invokeToolHandler(name, args, context.source),
    ]),
  ) as Record<ToolName, ToolHandler<Record<string, unknown>>>;
