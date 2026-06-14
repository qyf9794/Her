import type { ToolName } from "./tools/metadata";
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
  mac_mail_draft_create: "textOperations",
  weather_lookup: "textOperations",
  calendar_search: "textOperations",
  calendar_create: "textOperations",
  mac_calendar_create: "textOperations",
  mac_reminder_create: "textOperations",
  mac_note_create: "textOperations",
  copy_search: "textOperations",
  copy_save_draft: "textOperations",
  copy_publish: "textOperations",
  desktop_clipboard_write: "textOperations",
  desktop_clipboard_read: "textOperations",
  browser_open_url: "browserAutomation",
  browser_search_open: "browserAutomation",
  browser_isolated_open_url: "browserAutomation",
  browser_isolated_window_focus: "browserAutomation",
  browser_isolated_window_move_resize: "browserAutomation",
  browser_read_video_state: "browserAutomation",
  video_playback_control: "browserAutomation",
  browser_fill_form: "browserAutomation",
  browser_click: "browserAutomation",
  video_play: "browserAutomation",
  social_open: "browserAutomation",
  social_x_search: "textOperations",
  social_x_post: "textOperations",
  news_search: "textOperations",
  sec_filing_search: "textOperations",
  macro_series_lookup: "textOperations",
  market_quote_lookup: "textOperations",
  music_qq_open: "browserAutomation",
  media_key_control: "systemOperations",
  contacts_search: "systemOperations",
  phone_call: "systemOperations",
  shortcut_list: "systemOperations",
  shortcut_run: "systemOperations",
  system_close_app: "systemOperations",
  system_sleep: "systemOperations",
  system_lock_screen: "systemOperations",
  system_set_volume: "systemOperations",
  system_get_volume: "systemOperations",
  system_mute_volume: "systemOperations",
  system_set_brightness: "systemOperations",
  system_set_dark_mode: "systemOperations",
  system_open_settings: "systemOperations",
  system_speak: "systemOperations",
  system_notification: "systemOperations",
  screenshot_capture: "systemOperations",
  keyboard_shortcut: "systemOperations",
  advanced_shell_command: "systemOperations",
  codex_task_run: "systemOperations",
  app_quit: "systemOperations",
  window_list: "systemOperations",
  window_close_all: "systemOperations",
  window_hide_all: "systemOperations",
  window_minimize_all: "systemOperations",
  window_auto_arrange: "systemOperations",
  window_minimize_unrelated: "systemOperations",
  window_close: "systemOperations",
  window_minimize: "systemOperations",
  window_maximize: "systemOperations",
  window_move_resize: "systemOperations",
  desktop_show: "systemOperations",
};

const appTools = new Set<ToolName>([
  "desktop_open_app",
  "app_open",
  "app_focus",
  "app_quit",
  "system_close_app",
  "system_sleep",
  "system_lock_screen",
  "music_open",
  "music_play_song",
  "music_qq_open",
  "file_open",
  "video_play",
  "mac_calendar_create",
  "mac_reminder_create",
  "mac_note_create",
  "mac_mail_draft_create",
  "window_close",
  "window_minimize",
  "window_maximize",
  "window_move_resize",
  "window_hide_all",
  "window_minimize_all",
  "desktop_show",
  "system_speak",
  "system_notification",
  "screenshot_capture",
  "keyboard_shortcut",
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
  if (name === "music_qq_open" && args.target === "app") return "QQMusic";
  if (name === "video_play" && args.service === "apple_tv") return "TV";
  if (name === "mac_calendar_create") return "Calendar";
  if (name === "mac_reminder_create") return "Reminders";
  if (name === "mac_note_create") return "Notes";
  if (name === "mac_mail_draft_create") return "Mail";
  if (name === "file_open") return args.appName as string | undefined;
  if (name === "window_close" || name === "window_minimize" || name === "window_maximize" || name === "window_move_resize") {
    return args.appName as string | undefined;
  }
  return (args.appName as string | undefined) ?? (args.name as string | undefined);
};
