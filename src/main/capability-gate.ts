import type { ToolName } from "../shared/tools";
import type { CapabilityKey, InstalledApp } from "../shared/app-settings";
import { SettingsStore } from "./settings-store";

const capabilityByTool: Partial<Record<ToolName, CapabilityKey>> = {
  file_list: "fileManagement",
  file_search: "fileManagement",
  file_read: "fileManagement",
  file_open: "fileManagement",
  file_create_folder: "fileManagement",
  file_rename: "fileManagement",
  file_move: "fileManagement",
  file_copy: "fileManagement",
  file_trash: "fileManagement",
  document_extract: "textOperations",
  document_folder_digest: "textOperations",
  document_prepare_edit: "textOperations",
  email_search: "textOperations",
  email_read: "textOperations",
  email_draft: "textOperations",
  email_send: "textOperations",
  calendar_search: "textOperations",
  calendar_create: "textOperations",
  copy_search: "textOperations",
  copy_save_draft: "textOperations",
  copy_publish: "textOperations",
  desktop_clipboard_write: "textOperations",
  browser_open_url: "browserAutomation",
  browser_isolated_open_url: "browserAutomation",
  browser_fill_form: "browserAutomation",
  browser_click: "browserAutomation",
  video_play: "browserAutomation",
  system_close_app: "systemOperations",
  system_set_volume: "systemOperations",
  system_set_brightness: "systemOperations",
  system_set_dark_mode: "systemOperations",
  system_open_settings: "systemOperations",
  advanced_shell_command: "systemOperations",
  app_quit: "systemOperations",
  window_list: "systemOperations",
  window_close_all: "systemOperations",
  window_auto_arrange: "systemOperations",
  window_minimize_unrelated: "systemOperations",
  window_close: "systemOperations",
  window_minimize: "systemOperations",
  window_maximize: "systemOperations",
  window_move_resize: "systemOperations",
};

const appTools = new Set<ToolName>([
  "desktop_open_app",
  "app_open",
  "app_focus",
  "app_quit",
  "system_close_app",
  "music_open",
  "music_play_song",
  "file_open",
  "video_play",
  "window_close",
  "window_minimize",
  "window_maximize",
  "window_move_resize",
]);

export class CapabilityGate {
  constructor(
    private settings: SettingsStore,
    private appsProvider: () => Promise<InstalledApp[]>,
  ) {}

  async assertToolAllowed(name: ToolName, args: Record<string, unknown>) {
    const settings = this.settings.read();
    if (settings.yoloMode) return;

    const capability = capabilityByTool[name];
    if (capability && !settings.capabilities[capability]) {
      throw new Error(`Capability is disabled: ${capability}`);
    }

    if (!appTools.has(name)) return;
    const appName = appNameForTool(name, args);
    if (!appName) return;

    const apps = await this.appsProvider();
    const app = apps.find((item) => item.name === appName || item.bundleId === appName);
    if (!app) throw new Error(`App is not installed or not discoverable: ${appName}`);
    if (!app.authorized) throw new Error(`App is not authorized: ${app.name}`);
  }

  async authorizedAppNames() {
    const apps = await this.appsProvider();
    if (this.settings.read().yoloMode) return new Set(apps.flatMap((item) => [item.name, item.bundleId]));
    return new Set(apps.filter((item) => item.authorized).flatMap((item) => [item.name, item.bundleId]));
  }
}

const appNameForTool = (name: ToolName, args: Record<string, unknown>) => {
  if (name === "music_open" || name === "music_play_song") return "Music";
  if (name === "video_play" && args.service === "apple_tv") return "TV";
  if (name === "file_open") return args.appName as string | undefined;
  if (name === "window_close" || name === "window_minimize" || name === "window_maximize" || name === "window_move_resize") {
    return args.appName as string | undefined;
  }
  return (args.appName as string | undefined) ?? (args.name as string | undefined);
};
