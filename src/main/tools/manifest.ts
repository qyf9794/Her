import { allToolDefinitions, coreRealtimeToolNames, toolGroupByName, type ToolGroup, type ToolName } from "../../shared/tools";
import type { CapabilityKey } from "../../shared/app-settings";
import { defineTool, type ToolBundle, type ToolDefinition, type ToolRisk } from "./define-tool";

export type ToolManifestEntry = ToolDefinition<Record<string, unknown>> & {
  parameters: Record<string, unknown>;
  realtime: boolean;
};

export const toolBundles: Record<ToolBundle, { title: string; groups: ToolGroup[] }> = {
  core: { title: "Core runtime", groups: ["permissions", "agents"] },
  filesystem: { title: "Files", groups: ["files"] },
  documents: { title: "Documents", groups: ["documents"] },
  comms: { title: "Communications and productivity", groups: ["text", "phone", "social", "research"] },
  media: { title: "Media", groups: ["media"] },
  desktop: { title: "Desktop, apps, windows, system", groups: ["apps", "windows", "system"] },
  browser: { title: "Browser", groups: ["browser"] },
  shell: { title: "Shell", groups: ["shell"] },
};

const coreRealtimeNames = new Set<ToolName>(coreRealtimeToolNames);

const highRiskTools = new Set<ToolRisk>([
  "local_write",
  "external_send",
  "browser_submit",
  "system_change",
  "shell",
  "coding_agent",
]);

const riskOverrides: Partial<Record<ToolName, ToolRisk>> = {
  codex_task_run: "coding_agent",
  phone_call: "external_send",
  file_open: "local_open",
  file_create_folder: "local_write",
  file_rename: "local_write",
  file_move: "local_write",
  file_copy: "local_write",
  file_trash: "local_write",
  document_prepare_edit: "local_write",
  email_send: "external_send",
  mac_mail_draft_create: "external_send",
  calendar_create: "local_write",
  mac_calendar_create: "local_write",
  mac_reminder_create: "local_write",
  mac_note_create: "local_write",
  copy_save_draft: "local_write",
  copy_publish: "external_send",
  music_open: "local_open",
  music_play_song: "local_open",
  music_spotify_play: "local_open",
  music_netease_open: "local_open",
  music_qq_open: "local_open",
  media_key_control: "local_open",
  video_play: "local_open",
  video_playback_control: "local_open",
  social_x_post: "external_send",
  social_open: "local_open",
  shortcut_run: "system_change",
  app_open: "local_open",
  app_focus: "local_open",
  app_quit: "system_change",
  desktop_open_app: "local_open",
  window_close_all: "system_change",
  window_hide_all: "system_change",
  window_minimize_all: "system_change",
  window_auto_arrange: "system_change",
  window_minimize_unrelated: "system_change",
  window_close: "system_change",
  window_minimize: "system_change",
  window_maximize: "system_change",
  window_move_resize: "system_change",
  desktop_show: "local_open",
  system_close_app: "system_change",
  system_sleep: "system_change",
  system_lock_screen: "system_change",
  system_set_volume: "system_change",
  system_mute_volume: "system_change",
  system_set_brightness: "system_change",
  system_set_dark_mode: "system_change",
  system_open_settings: "local_open",
  desktop_clipboard_write: "local_write",
  system_speak: "local_open",
  system_notification: "system_change",
  screenshot_capture: "system_change",
  keyboard_shortcut: "system_change",
  browser_open_url: "local_open",
  browser_search_open: "local_open",
  browser_isolated_open_url: "local_open",
  browser_isolated_window_focus: "local_open",
  browser_isolated_window_move_resize: "system_change",
  browser_fill_form: "browser_submit",
  browser_click: "browser_submit",
  advanced_shell_command: "shell",
};

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
      realtimeDescription: definition.description,
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

function capabilityForGroup(group: ToolGroup | undefined): CapabilityKey | undefined {
  if (group === "files" || group === "documents") return "fileManagement";
  if (group === "browser") return "browserAutomation";
  if (group === "text" || group === "phone" || group === "social" || group === "research" || group === "media") return "textOperations";
  if (group === "apps" || group === "windows" || group === "system" || group === "shell") return "systemOperations";
  return undefined;
}

function riskForTool(name: ToolName) {
  return riskOverrides[name] ?? "read";
}

function titleForTool(name: ToolName) {
  return name
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
