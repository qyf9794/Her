import path from "node:path";
import type { HerTaskKind } from "../../shared/tasks";
import type { ToolName } from "../tools/metadata";
import { toolManifest } from "../tools/manifest";
import type { ToolRisk } from "../tools/define-tool";

export type TaskExecutionPlan = {
  kind: HerTaskKind;
  resourceLocks: string[];
  managed: boolean;
};

const pilotManagedTools = new Set<ToolName>([
  "file_rename",
  "file_move",
  "file_trash",
  "window_close_all",
  "advanced_shell_command",
  "coding_agent_start",
]);

export const classifyTaskExecution = (toolName: ToolName, args: Record<string, unknown>): TaskExecutionPlan => {
  const risk = toolManifest[toolName]?.risk ?? "read";
  const kind = kindForRisk(risk);
  return {
    kind,
    resourceLocks: resourceLocksForTool(toolName, args),
    managed: pilotManagedTools.has(toolName),
  };
};

const kindForRisk = (risk: ToolRisk): HerTaskKind => {
  if (risk === "coding_agent") return "long_running";
  if (risk === "local_write" || risk === "external_send" || risk === "browser_submit" || risk === "system_change" || risk === "shell") {
    return "exclusive";
  }
  return "immediate";
};

export const resourceLocksForTool = (toolName: ToolName, args: Record<string, unknown>) => {
  switch (toolName) {
    case "file_rename":
    case "file_trash":
      return stringArg(args, "path") ? [`file:${path.resolve(stringArg(args, "path")!)}`] : [];
    case "file_move":
      return [
        stringArg(args, "from") ? `folder:${path.dirname(path.resolve(stringArg(args, "from")!))}` : "",
        stringArg(args, "to") ? `folder:${path.dirname(path.resolve(stringArg(args, "to")!))}` : "",
      ].filter(Boolean);
    case "window_close_all":
      return ["desktop:windows"];
    case "advanced_shell_command":
      return ["shell:local"];
    case "coding_agent_start": {
      const repoPath = stringArg(args, "repoPath") ?? process.cwd();
      return [`repo:${path.resolve(repoPath)}`];
    }
    default:
      return [];
  }
};

const stringArg = (args: Record<string, unknown>, key: string) => {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value : undefined;
};
