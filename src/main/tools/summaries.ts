import type { ToolName } from "./metadata";

export const summarizeToolCall = (name: ToolName, args: Record<string, unknown>) => {
    switch (name) {
      case "email_send":
        return `Send email draft ${args.draftId}`;
      case "confirmation_list":
        return "List pending confirmations";
      case "confirmation_decide":
        return `${args.approved ? "Approve" : "Reject"} confirmation ${args.confirmationId ?? "if only one is pending"}`;
      case "tool_catalog_list":
        return args.group ? `List dynamic tool catalog for group ${args.group}` : "List dynamic tool groups";
      case "tool_group_set":
        return `${args.enabled ? "Enable" : "Disable"} dynamic tool group ${args.group}`;
      case "task_create":
        return `Queue task for ${args.toolName}`;
      case "task_status":
        return `Read task ${args.taskId}`;
      case "task_list":
        return `List recent tasks${args.status ? ` with status ${args.status}` : ""}`;
      case "task_cancel":
        return `Cancel task ${args.taskId}`;
      case "task_route":
        return `Route user request: ${truncateText(String(args.userRequest ?? ""), 120)}`;
      case "codex_task_run":
        return `Run Codex background task: ${truncateText(String(args.prompt ?? ""), 120)}`;
      case "contacts_search":
        return `Search contacts for ${args.query}`;
      case "phone_call":
        return `Call ${args.contactName ?? args.phoneNumber} via ${args.mode ?? "phone"}`;
      case "yolo_mode_set":
        return `Turn YOLO mode ${args.enabled ? "on" : "off"}`;
      case "email_read":
        return `Read email ${args.emailId}`;
      case "mac_mail_draft_create":
        return `Create visible Mail draft to ${args.to} with subject "${args.subject}"`;
      case "weather_lookup":
        return `Look up weather for ${args.location}${args.date ? ` on ${args.date}` : ""}`;
      case "calendar_create":
        return `Create calendar event "${args.title}" from ${args.start} to ${args.end}`;
      case "mac_calendar_create":
        return `Create macOS Calendar event "${args.title}" from ${args.start} to ${args.end}`;
      case "mac_reminder_create":
        return `Create macOS reminder "${args.title}"${args.dueAt ? ` at ${args.dueAt}` : ""}`;
      case "mac_note_create":
        return `Create macOS note "${args.title}"`;
      case "copy_publish":
        return `Publish copy draft ${args.draftId}`;
      case "desktop_clipboard_write":
        return `Write ${String(args.text ?? "").length} characters to the system clipboard`;
      case "file_rename":
        return `Rename ${args.path} to ${args.newName}`;
      case "file_create_folder":
        return `Create folder ${args.folderName} in ${args.parentPath}`;
      case "file_move":
        return `Move ${args.from} to ${args.to}`;
      case "file_copy":
        return `Copy ${args.from} to ${args.to}`;
      case "file_trash":
        return `Move ${args.path} to Trash`;
      case "file_open":
        return `Open file ${args.path}${args.appName ? ` in ${args.appName}` : ""}`;
      case "document_prepare_edit":
        return `Edit document ${args.path}`;
      case "music_open":
        return "Open Music app";
      case "music_play_song":
        return `Play music for ${args.query}${args.artist ? ` by ${args.artist}` : ""}`;
      case "music_playback_state":
        return "Read Music playback state";
      case "music_spotify_search":
        return `Search Spotify for ${args.query}${args.artist ? ` by ${args.artist}` : ""}`;
      case "music_spotify_play":
        return `Play Spotify music for ${args.query}${args.artist ? ` by ${args.artist}` : ""}`;
      case "music_spotify_playback_state":
        return "Read Spotify playback state";
      case "music_netease_open":
        return args.query ? `Open NetEase Cloud Music search for ${args.query}` : "Open NetEase Cloud Music";
      case "music_qq_open":
        return args.query ? `Open QQ Music search for ${args.query}` : `Open QQ Music ${args.target ?? "web"}`;
      case "media_key_control":
        return `${args.action} media${args.appName ? ` in ${args.appName}` : ""}`;
      case "video_play":
        return `Play ${args.service} video for ${args.query}`;
      case "video_playback_control":
        return `${args.action} active isolated-browser video`;
      case "apple_tv_playback_state":
        return "Read Apple TV playback state";
      case "social_x_search":
        return `Search X posts for ${args.query}`;
      case "social_x_post":
        return `Post ${String(args.text ?? "").length} characters to X`;
      case "social_open":
        return `Open ${args.service} ${args.kind ?? "search"}${args.target ? ` for ${args.target}` : ""}`;
      case "news_search":
        return `Search ${args.provider ?? "gdelt"} news for ${args.query}`;
      case "sec_filing_search":
        return `Search SEC filings for ${args.company}`;
      case "macro_series_lookup":
        return `Read macro series ${args.seriesId}`;
      case "market_quote_lookup":
        return `Read market quote for ${args.symbol}`;
      case "shortcut_list":
        return "List macOS Shortcuts";
      case "shortcut_run":
        return `Run macOS Shortcut ${args.name}`;
      case "app_open":
        return `Open app ${args.appName}`;
      case "app_focus":
        return `Focus app ${args.appName}`;
      case "app_quit":
        return `Quit app ${args.appName}`;
      case "window_close_all":
        return "Close all visible windows for authorized apps";
      case "window_hide_all":
        return args.preserveFrontmost ? "Hide all windows except the frontmost app" : "Hide all visible app windows";
      case "window_minimize_all":
        return "Minimize all visible app windows";
      case "window_auto_arrange":
        return `Auto-arrange visible windows${(args.appNames as string[] | undefined)?.length ? ` for ${(args.appNames as string[]).join(", ")}` : " for authorized apps"}`;
      case "window_minimize_unrelated":
        return `Minimize unrelated windows; keep apps: ${((args.keepAppNames as string[] | undefined) ?? []).join(", ") || "frontmost/current task"}; keep title keywords: ${((args.keepTitleKeywords as string[] | undefined) ?? []).join(", ") || "none"}`;
      case "window_close":
        return `Close front window of ${args.appName}`;
      case "window_minimize":
        return `Minimize front window of ${args.appName}`;
      case "window_maximize":
        return `Maximize front window of ${args.appName}`;
      case "window_move_resize":
        return `Move and resize ${args.appName} window to ${args.x},${args.y} ${args.width}x${args.height}`;
      case "desktop_show":
        return "Show desktop";
      case "desktop_open_app":
        return `Open app ${args.appName}`;
      case "system_close_app":
        return `Quit app ${args.appName}`;
      case "system_sleep":
        return "Put Mac to sleep";
      case "system_lock_screen":
        return "Lock screen / display sleep";
      case "system_set_volume":
        return `Set system volume to ${args.level}`;
      case "system_get_volume":
        return "Read system volume";
      case "system_mute_volume":
        return args.muted ? "Mute system volume" : "Unmute system volume";
      case "system_set_brightness":
        return `Set display brightness to ${args.level}`;
      case "system_set_dark_mode":
        return `Turn dark mode ${args.enabled ? "on" : "off"}`;
      case "desktop_clipboard_read":
        return "Read system clipboard";
      case "system_speak":
        return `Speak ${String(args.text ?? "").length} characters`;
      case "system_notification":
        return `${args.dialog ? "Show dialog" : "Show notification"}: ${args.title}`;
      case "screenshot_capture":
        return `Capture screenshot to ${args.mode}`;
      case "keyboard_shortcut":
        return `Send keyboard shortcut ${args.action}`;
      case "browser_fill_form":
        return `Fill ${(args.fields as unknown[] | undefined)?.length ?? 0} browser form fields`;
      case "browser_click":
        return `Click browser selector ${args.selector} for: ${args.purpose}`;
      case "advanced_shell_command":
        return `Run shell command for ${args.reason}: ${args.command}`;
      case "browser_open_url":
        return `Open URL ${args.url}`;
      case "browser_search_open":
        return `Open ${args.engine ?? "google"} search for ${truncateText(String(args.query ?? ""), 80)}`;
      case "browser_isolated_open_url":
        return `Open isolated browser URL ${args.url}`;
      case "browser_isolated_window_focus":
        return "Focus isolated Chrome window";
      case "browser_isolated_window_move_resize":
        return `Move isolated Chrome window to ${args.x},${args.y} ${args.width}x${args.height}`;
      case "browser_read_page":
        return "Read isolated browser page";
      case "browser_read_video_state":
        return "Read isolated browser video playback state";
      case "app_permission_search":
        return `Search app permissions for ${args.query}`;
      case "app_permission_set":
        return `${args.authorized ? "Authorize" : "Revoke authorization for"} app ${args.appName}`;
      case "capability_set":
        return `Turn ${args.capability} ${args.enabled ? "on" : "off"}`;
      default:
        return `${name} ${JSON.stringify(args)}`;
    }
};


const truncateText = (value: string, maxChars: number) => {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars - 1)}...`;
};
