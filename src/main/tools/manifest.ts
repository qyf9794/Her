import type { CapabilityKey } from "../../shared/app-settings";
import type { ToolBundleName } from "../agent/tool-bundle-router";
import { defineTool, type ToolBundle, type ToolDefinition, type ToolHandler, type ToolRisk } from "./define-tool";
import { toolBundles } from "./bundles";
import { allToolDefinitions, coreRealtimeToolNames, toolGroupByName, toolRiskOverrides, toolSchemas, type ToolGroup, type ToolName } from "./metadata";
import { summarizeToolCall } from "./summaries";

export type ToolManifestEntry = ToolDefinition<Record<string, unknown>> & {
  parameters: Record<string, unknown>;
  realtime: boolean;
  schema: NonNullable<ToolDefinition<Record<string, unknown>>["schema"]>;
  summarize: NonNullable<ToolDefinition<Record<string, unknown>>["summarize"]>;
  handler: NonNullable<ToolDefinition<Record<string, unknown>>["handler"]>;
};

export { toolBundles };

const coreRealtimeNames = new Set<ToolName>(coreRealtimeToolNames);

const highRiskTools = new Set<ToolRisk>([
  "local_write",
  "external_send",
  "browser_submit",
  "system_change",
  "shell",
  "coding_agent",
]);

const runtimeHandlers: Partial<Record<ToolName, ToolHandler<Record<string, unknown>>>> = {};

export const toolManifest = Object.fromEntries(
  allToolDefinitions.map((definition) => {
    const name = definition.name as ToolName;
    const group = (toolGroupByName as Partial<Record<ToolName, ToolGroup>>)[name];
    const entry = defineTool<Record<string, unknown>>({
      name,
      title: titleForTool(name),
      description: definition.description,
      group,
      capability: capabilityForGroup(group),
      bundle: bundleForGroup(group, name),
      risk: riskForTool(name),
      schema: toolSchemas[name],
      realtimeDescription: definition.description,
      summarize: (args) => summarizeToolCall(name, args),
      handler: (args, context) => {
        const handler = runtimeHandlers[name];
        if (!handler) throw new Error(`Tool handler is not bound: ${name}`);
        return handler(args, context);
      },
    }) as ToolManifestEntry;
    entry.parameters = definition.parameters;
    entry.realtime = coreRealtimeNames.has(name);
    return [name, entry];
  }),
) as Record<ToolName, ToolManifestEntry>;

export const manifestToolDefinitions = Object.values(toolManifest).map((entry) => ({
  type: "function" as const,
  name: entry.name,
  description: entry.realtimeDescription ?? entry.description,
  parameters: entry.parameters,
}));

export const manifestRealtimeToolDefinitions = Object.values(toolManifest)
  .filter((entry) => entry.realtime)
  .map((entry) => ({
    type: "function" as const,
    name: entry.name,
    description: entry.realtimeDescription ?? entry.description,
    parameters: entry.parameters,
  }));

export const manifestRealtimeToolDefinitionsForBundles = (bundles: readonly ToolBundleName[]) => {
  const selected = new Set<ToolBundleName>(["core", ...bundles]);
  return Object.values(toolManifest)
    .filter((entry) => entry.realtime || selected.has(realtimeBundleForEntry(entry)))
    .map((entry) => ({
      type: "function" as const,
      name: entry.name,
      description: entry.realtimeDescription ?? entry.description,
      parameters: entry.parameters,
    }));
};

export const manifestQueueManagedToolDefinitions = Object.values(toolManifest)
  .filter((entry) => Boolean(entry.group))
  .map((entry) => ({
    type: "function" as const,
    name: entry.name,
    description: entry.description,
    parameters: entry.parameters,
  }));

export const toolRiskByName = Object.fromEntries(
  Object.values(toolManifest).map((entry) => [entry.name, entry.risk]),
) as Record<ToolName, ToolRisk>;

export const toolRequiresConfirmation = (name: ToolName) => highRiskTools.has(toolManifest[name].risk);

export const attachToolHandlers = (handlers: Partial<Record<ToolName, ToolHandler<Record<string, unknown>>>>) => {
  Object.assign(runtimeHandlers, handlers);
};

function bundleForGroup(group: ToolGroup | undefined, name: ToolName): ToolBundle {
  if (!group) return "core";
  if (group === "files") return "filesystem";
  if (group === "documents") return "documents";
  if (group === "text" || group === "phone" || group === "social" || group === "research") return "comms";
  if (group === "media") return "media";
  if (group === "browser") return "browser";
  if (group === "shell") return "shell";
  if (group === "apps" || group === "windows" || group === "system") return "desktop";
  if (group === "permissions" || group === "agents") return "core";
  return name === "advanced_shell_command" ? "shell" : "core";
}

function realtimeBundleForEntry(entry: ToolManifestEntry): ToolBundleName {
  if (entry.realtime) return "core";
  if (entry.group === "files") return "file";
  if (entry.group === "documents") return "document";
  if (entry.group === "browser") return "browser";
  if (entry.group === "media") return "media";
  if (entry.group === "apps" || entry.group === "windows") return "desktop";
  if (entry.group === "system") return "system";
  if (entry.group === "shell" || entry.group === "agents") return "coding";
  if (entry.group === "text" || entry.group === "phone" || entry.group === "social" || entry.group === "research") return "comms";
  return "core";
}

function capabilityForGroup(group: ToolGroup | undefined): CapabilityKey | undefined {
  if (group === "files" || group === "documents") return "fileManagement";
  if (group === "browser") return "browserAutomation";
  if (group === "text" || group === "phone" || group === "social" || group === "research" || group === "media") return "textOperations";
  if (group === "apps" || group === "windows" || group === "system" || group === "shell") return "systemOperations";
  return undefined;
}

function riskForTool(name: ToolName) {
  return toolRiskOverrides[name] ?? "read";
}

function titleForTool(name: ToolName) {
  return name
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
