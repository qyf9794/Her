export type ToolName =
  | "system_status"
  | "confirmation_list"
  | "confirmation_decide"
  | "tool_result_read"
  | "tool_catalog_list"
  | "tool_group_set"
  | "task_create"
  | "task_status"
  | "task_list"
  | "task_cancel"
  | "task_route"
  | "memory_lookup"
  | "memory_save"
  | "memory_forget"
  | "memory_status"
  | "codex_task_run"
  | "yolo_mode_set"
  | "app_permission_search"
  | "app_permission_set"
  | "capability_set"
  | "file_list"
  | "file_search"
  | "file_read"
  | "file_open"
  | "file_create_folder"
  | "file_rename"
  | "file_move"
  | "file_copy"
  | "file_trash"
  | "document_extract"
  | "document_folder_digest"
  | "document_prepare_edit"
  | "email_search"
  | "email_read"
  | "email_draft"
  | "email_send"
  | "calendar_search"
  | "calendar_create"
  | "copy_search"
  | "copy_save_draft"
  | "copy_publish"
  | "music_open"
  | "music_play_song"
  | "video_play"
  | "app_open"
  | "app_focus"
  | "app_quit"
  | "window_list"
  | "window_close_all"
  | "window_auto_arrange"
  | "window_minimize_unrelated"
  | "window_close"
  | "window_minimize"
  | "window_maximize"
  | "window_move_resize"
  | "desktop_open_app"
  | "system_close_app"
  | "system_set_volume"
  | "system_set_brightness"
  | "system_set_dark_mode"
  | "system_open_settings"
  | "desktop_clipboard_write"
  | "browser_open_url"
  | "browser_isolated_open_url"
  | "browser_fill_form"
  | "browser_click"
  | "advanced_shell_command";

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

type JsonSchema = Record<string, unknown>;

export type ToolGroup =
  | "permissions"
  | "files"
  | "documents"
  | "text"
  | "media"
  | "apps"
  | "windows"
  | "system"
  | "browser"
  | "shell"
  | "agents";

const objectSchema = (
  properties: Record<string, JsonSchema>,
  required: string[] = [],
): JsonSchema => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

export const allToolDefinitions = [
  {
    type: "function",
    name: "system_status",
    description: "Check local assistant capabilities, connected adapters, and current safety mode.",
    parameters: objectSchema({}),
  },
  {
    type: "function",
    name: "confirmation_list",
    description: "List pending local confirmation requests that are waiting for the user's explicit approval or rejection.",
    parameters: objectSchema({}),
  },
  {
    type: "function",
    name: "confirmation_decide",
    description: "Approve or reject a pending local confirmation after the user's latest voice/text message explicitly says to confirm, approve, reject, or cancel it. If only one confirmation is pending, confirmationId may be omitted.",
    parameters: objectSchema(
      {
        confirmationId: { type: "string", description: "Pending confirmation id. Optional only when exactly one confirmation is pending." },
        approved: { type: "boolean", description: "true to approve/confirm, false to reject/cancel." },
      },
      ["approved"],
    ),
  },
  {
    type: "function",
    name: "tool_result_read",
    description: "Read a bounded slice of a previous large tool result by handle. Use only after a tool result says it was truncated and provides a handle.",
    parameters: objectSchema(
      {
        handle: { type: "string", description: "Handle returned by a truncated tool result." },
        offset: { type: "integer", minimum: 0, default: 0 },
        maxChars: { type: "integer", minimum: 200, maximum: 6000, default: 2000 },
      },
      ["handle"],
    ),
  },
  {
    type: "function",
    name: "task_route",
    description: "Classify a user request into HER native tools, HER web search, Codex background runtime, or a mixed plan. Use before task_create when the best provider is unclear.",
    parameters: objectSchema(
      {
        userRequest: { type: "string", description: "The user's full request to route." },
        preference: { type: "string", enum: ["auto", "native", "search", "codex"], default: "auto" },
        cwd: { type: "string", description: "Optional working directory for Codex tasks." },
        activeApp: { type: "string", description: "Optional current/frontmost app name." },
        selectedText: { type: "string", description: "Optional selected text or short local context." },
      },
      ["userRequest"],
    ),
  },
  {
    type: "function",
    name: "memory_lookup",
    description: "Look up compact HER memory summaries such as path aliases, preferences, and task templates. Results are short; providers resolve full content internally when needed.",
    parameters: objectSchema(
      {
        query: { type: "string" },
        types: { type: "array", items: { type: "string", enum: ["path_alias", "preference", "task_template"] } },
        limit: { type: "integer", minimum: 1, maximum: 10, default: 5 },
      },
      ["query"],
    ),
  },
  {
    type: "function",
    name: "memory_save",
    description: "Save a user-approved HER memory item. Use only when the user explicitly asks HER to remember a path, preference, or task template.",
    parameters: objectSchema(
      {
        type: { type: "string", enum: ["path_alias", "preference", "task_template"] },
        key: { type: "string" },
        value: { type: "string" },
        summary: { type: "string" },
        content: { type: "string" },
        aliases: { type: "array", items: { type: "string" } },
        tags: { type: "array", items: { type: "string" } },
      },
      ["type", "key"],
    ),
  },
  {
    type: "function",
    name: "memory_forget",
    description: "Forget a HER memory item by id or exact key. Use only when the user explicitly asks to forget it.",
    parameters: objectSchema({ idOrKey: { type: "string" } }, ["idOrKey"]),
  },
  {
    type: "function",
    name: "memory_status",
    description: "Return HER memory counts and storage status without exposing full memory content.",
    parameters: objectSchema({}),
  },
  {
    type: "function",
    name: "codex_task_run",
    description: "Run a complex background engineering, repo, or file-analysis task through HER's Codex app-server runtime. Use this for multi-step code/project work, not for direct desktop, media, browser, or window control.",
    parameters: objectSchema(
      {
        prompt: { type: "string", description: "The complete task for HER's background Codex runtime." },
        cwd: { type: "string", description: "Optional working directory. Defaults to HER's current project directory." },
        model: { type: "string", description: "Optional Codex model override. Leave unset to use Codex app-server defaults." },
        sandbox: {
          type: "string",
          enum: ["read_only", "workspace_write"],
          default: "read_only",
          description: "Filesystem permission for this Codex turn.",
        },
        timeoutMs: { type: "integer", minimum: 10000, maximum: 1800000, default: 300000 },
        memoryIds: { type: "array", items: { type: "string" }, description: "Internal HER memory ids to resolve and inject into the Codex prompt." },
      },
      ["prompt"],
    ),
  },
  {
    type: "function",
    name: "yolo_mode_set",
    description: "Turn YOLO mode on or off. When enabled, HER grants every discovered app permission, enables all global capabilities, and bypasses local confirmation prompts. Only call this when the user explicitly asks for YOLO, no-confirmation, or full-permission mode.",
    parameters: objectSchema(
      {
        enabled: { type: "boolean", description: "true to enable YOLO mode, false to disable it." },
      },
      ["enabled"],
    ),
  },
  {
    type: "function",
    name: "app_permission_search",
    description: "Search locally installed apps and inspect whether they are authorized for HER control. Use before voice authorization when the app name may be ambiguous.",
    parameters: objectSchema(
      {
        query: { type: "string", description: "App name, bundle id, or partial app name. Empty string lists likely apps." },
        limit: { type: "integer", minimum: 1, maximum: 20, default: 8 },
      },
      ["query"],
    ),
  },
  {
    type: "function",
    name: "app_permission_set",
    description: "Authorize or revoke a locally installed app for HER control by voice. Only call this when the user explicitly asks to authorize or revoke that app.",
    parameters: objectSchema(
      {
        appName: { type: "string", description: "Visible app name or bundle id, for example YouTube, Google Chrome, or com.google.Chrome." },
        authorized: { type: "boolean", description: "true to authorize, false to revoke authorization." },
      },
      ["appName", "authorized"],
    ),
  },
  {
    type: "function",
    name: "capability_set",
    description: "Turn one of HER's global capability switches on or off by voice.",
    parameters: objectSchema(
      {
        capability: {
          type: "string",
          enum: ["fileManagement", "browserAutomation", "textOperations", "systemOperations"],
          description: "The global capability switch to update.",
        },
        enabled: { type: "boolean" },
      },
      ["capability", "enabled"],
    ),
  },
  {
    type: "function",
    name: "file_list",
    description: "List files in an allowlisted folder such as Desktop, Documents, or Downloads. Read-only.",
    parameters: objectSchema(
      {
        path: { type: "string", description: "Folder path, ~ path, or one of Desktop/Documents/Downloads." },
        includeHidden: { type: "boolean", default: false },
      },
      ["path"],
    ),
  },
  {
    type: "function",
    name: "file_search",
    description: "Search filenames under an allowlisted folder. Read-only.",
    parameters: objectSchema(
      {
        root: { type: "string" },
        query: { type: "string" },
        maxDepth: { type: "integer", minimum: 1, maximum: 8, default: 4 },
        limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
      },
      ["root", "query"],
    ),
  },
  {
    type: "function",
    name: "file_read",
    description: "Read a small text-like file from an allowlisted folder. Use document_extract for PDF or DOCX.",
    parameters: objectSchema({ path: { type: "string" }, maxChars: { type: "integer", minimum: 100, maximum: 10000, default: 3000 } }, ["path"]),
  },
  {
    type: "function",
    name: "file_open",
    description: "Open a specific allowlisted local file in its default macOS app, or in a named authorized app such as Microsoft Word, Microsoft Excel, Pages, Numbers, Preview, or TextEdit.",
    parameters: objectSchema(
      {
        path: { type: "string", description: "File path, ~ path, or a path under Desktop/Documents/Downloads." },
        appName: { type: "string", description: "Optional app name to force, for example Microsoft Word or Microsoft Excel." },
      },
      ["path"],
    ),
  },
  {
    type: "function",
    name: "file_create_folder",
    description: "Create a new folder inside an allowlisted parent folder such as Desktop, Documents, or Downloads. Requires explicit confirmation.",
    parameters: objectSchema(
      {
        parentPath: { type: "string", description: "Existing allowlisted parent folder, for example Desktop, Documents, Downloads, or ~/Documents/Project." },
        folderName: { type: "string", description: "Name of the new folder only. Do not include slashes." },
      },
      ["parentPath", "folderName"],
    ),
  },
  {
    type: "function",
    name: "file_rename",
    description: "Rename an allowlisted file or folder. Requires explicit confirmation.",
    parameters: objectSchema({ path: { type: "string" }, newName: { type: "string" } }, ["path", "newName"]),
  },
  {
    type: "function",
    name: "file_move",
    description: "Move an allowlisted file or folder to another allowlisted folder. Requires explicit confirmation.",
    parameters: objectSchema({ from: { type: "string" }, to: { type: "string" } }, ["from", "to"]),
  },
  {
    type: "function",
    name: "file_copy",
    description: "Copy an allowlisted file or folder to another allowlisted folder. Requires explicit confirmation.",
    parameters: objectSchema({ from: { type: "string" }, to: { type: "string" } }, ["from", "to"]),
  },
  {
    type: "function",
    name: "file_trash",
    description: "Move an allowlisted file or folder to the user's Trash. Never permanently deletes. Requires explicit confirmation.",
    parameters: objectSchema({ path: { type: "string" } }, ["path"]),
  },
  {
    type: "function",
    name: "document_extract",
    description: "Extract text from .txt, .md, .pdf, or .docx in an allowlisted folder so the assistant can summarize or analyze it.",
    parameters: objectSchema({ path: { type: "string" }, maxChars: { type: "integer", minimum: 500, maximum: 10000, default: 3000 } }, ["path"]),
  },
  {
    type: "function",
    name: "document_folder_digest",
    description: "Extract short text previews from supported documents in a folder, useful for risk review across contracts.",
    parameters: objectSchema(
      {
        root: { type: "string" },
        query: { type: "string", description: "Optional filename filter." },
        limit: { type: "integer", minimum: 1, maximum: 5, default: 3 },
        charsPerFile: { type: "integer", minimum: 300, maximum: 2000, default: 1000 },
      },
      ["root"],
    ),
  },
  {
    type: "function",
    name: "document_prepare_edit",
    description: "Prepare a full replacement edit for a text or markdown file and show a diff preview. Requires confirmation before writing.",
    parameters: objectSchema({ path: { type: "string" }, newContent: { type: "string" } }, ["path", "newContent"]),
  },
  {
    type: "function",
    name: "email_search",
    description: "Search indexed email metadata. This MVP uses the local adapter until Gmail or Microsoft Graph is configured.",
    parameters: objectSchema(
      {
        query: { type: "string", description: "Natural language email search query." },
        limit: { type: "integer", minimum: 1, maximum: 10, default: 5 },
      },
      ["query"],
    ),
  },
  {
    type: "function",
    name: "email_read",
    description: "Read a full local email or draft by id after email_search returns a match. Read-only.",
    parameters: objectSchema(
      {
        emailId: { type: "string", description: "Email or draft id returned by email_search." },
      },
      ["emailId"],
    ),
  },
  {
    type: "function",
    name: "email_draft",
    description: "Create an email draft. This never sends email.",
    parameters: objectSchema(
      {
        to: { type: "string" },
        subject: { type: "string" },
        body: { type: "string" },
      },
      ["to", "subject", "body"],
    ),
  },
  {
    type: "function",
    name: "email_send",
    description: "Send a previously created email draft. This always requires explicit user confirmation.",
    parameters: objectSchema({ draftId: { type: "string" } }, ["draftId"]),
  },
  {
    type: "function",
    name: "calendar_search",
    description: "Search calendar events. This MVP uses the local adapter until Google Calendar or Microsoft Graph is configured.",
    parameters: objectSchema(
      {
        from: { type: "string", description: "ISO date/time lower bound." },
        to: { type: "string", description: "ISO date/time upper bound." },
        query: { type: "string", description: "Optional natural language filter." },
        limit: { type: "integer", minimum: 1, maximum: 20, default: 10 },
      },
      ["from", "to"],
    ),
  },
  {
    type: "function",
    name: "calendar_create",
    description: "Create a calendar event. This always requires explicit user confirmation.",
    parameters: objectSchema(
      {
        title: { type: "string" },
        start: { type: "string", description: "ISO date/time." },
        end: { type: "string", description: "ISO date/time." },
        attendees: { type: "array", items: { type: "string" }, default: [] },
        location: { type: "string" },
        notes: { type: "string" },
      },
      ["title", "start", "end"],
    ),
  },
  {
    type: "function",
    name: "copy_search",
    description: "Search local copywriting drafts and snippets.",
    parameters: objectSchema(
      {
        query: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 10, default: 5 },
      },
      ["query"],
    ),
  },
  {
    type: "function",
    name: "copy_save_draft",
    description: "Save a copywriting draft locally.",
    parameters: objectSchema(
      {
        title: { type: "string" },
        body: { type: "string" },
        project: { type: "string" },
      },
      ["title", "body"],
    ),
  },
  {
    type: "function",
    name: "copy_publish",
    description: "Publish a copywriting draft. This always requires explicit user confirmation.",
    parameters: objectSchema({ draftId: { type: "string" } }, ["draftId"]),
  },
  {
    type: "function",
    name: "music_open",
    description: "Open the macOS Music app.",
    parameters: objectSchema({}),
  },
  {
    type: "function",
    name: "music_play_song",
    description: "Play a requested song in macOS Music. Searches the local Music library first; if not found, resolves an Apple Music catalog track and sends Music a play command.",
    parameters: objectSchema(
      {
        query: { type: "string", description: "Song title, artist, album, or natural language music request." },
        artist: { type: "string", description: "Optional artist name to narrow the search." },
      },
      ["query"],
    ),
  },
  {
    type: "function",
    name: "video_play",
    description: "Play or open a specific video by title or URL. For YouTube, resolves a search query to a concrete watch URL. For Apple TV, resolves a catalog item and sends TV a play command when possible.",
    parameters: objectSchema(
      {
        service: { type: "string", enum: ["youtube", "apple_tv"], description: "Video service to use." },
        query: { type: "string", description: "Video title, movie/show name, episode name, or a direct video URL." },
      },
      ["service", "query"],
    ),
  },
  {
    type: "function",
    name: "app_open",
    description: "Open a user-authorized macOS app by name.",
    parameters: objectSchema({ appName: { type: "string" } }, ["appName"]),
  },
  {
    type: "function",
    name: "app_focus",
    description: "Bring a user-authorized macOS app to the front.",
    parameters: objectSchema({ appName: { type: "string" } }, ["appName"]),
  },
  {
    type: "function",
    name: "app_quit",
    description: "Quit a user-authorized macOS app. Requires explicit confirmation.",
    parameters: objectSchema({ appName: { type: "string" } }, ["appName"]),
  },
  {
    type: "function",
    name: "window_list",
    description: "List visible windows for authorized apps. Requires system operations capability and Accessibility permission.",
    parameters: objectSchema({}),
  },
  {
    type: "function",
    name: "window_close_all",
    description: "Close all visible windows for authorized apps in one action. Skips HER/Electron itself so the assistant remains available. Requires explicit confirmation unless YOLO mode is enabled.",
    parameters: objectSchema({}),
  },
  {
    type: "function",
    name: "window_auto_arrange",
    description: "Automatically arrange visible windows for authorized apps into a grid on the current desktop. Use when the user asks to auto-arrange, tile, organize, or lay out windows.",
    parameters: objectSchema({
      appNames: {
        type: "array",
        items: { type: "string" },
        description: "Optional app names to arrange. Omit to arrange all visible authorized app windows.",
      },
    }),
  },
  {
    type: "function",
    name: "window_minimize_unrelated",
    description: "Keep task-related windows visible and minimize other visible windows for authorized apps. Use when the user asks to keep current task windows and minimize everything else.",
    parameters: objectSchema({
      keepAppNames: {
        type: "array",
        items: { type: "string" },
        description: "Apps that should remain visible because they are related to the current task.",
      },
      keepTitleKeywords: {
        type: "array",
        items: { type: "string" },
        description: "Case-insensitive title keywords for windows that should remain visible.",
      },
      preserveFrontmost: {
        type: "boolean",
        default: true,
        description: "Also keep the current frontmost window visible. Defaults to true.",
      },
    }),
  },
  {
    type: "function",
    name: "window_close",
    description: "Close the front window of a user-authorized app. Requires explicit confirmation.",
    parameters: objectSchema({ appName: { type: "string" } }, ["appName"]),
  },
  {
    type: "function",
    name: "window_minimize",
    description: "Minimize the front window of a user-authorized app.",
    parameters: objectSchema({ appName: { type: "string" } }, ["appName"]),
  },
  {
    type: "function",
    name: "window_maximize",
    description: "Zoom or maximize the front window of a user-authorized app.",
    parameters: objectSchema({ appName: { type: "string" } }, ["appName"]),
  },
  {
    type: "function",
    name: "window_move_resize",
    description: "Move and resize the front window of a user-authorized app.",
    parameters: objectSchema(
      {
        appName: { type: "string" },
        x: { type: "integer" },
        y: { type: "integer" },
        width: { type: "integer", minimum: 120 },
        height: { type: "integer", minimum: 120 },
      },
      ["appName", "x", "y", "width", "height"],
    ),
  },
  {
    type: "function",
    name: "desktop_open_app",
    description: "Open an allowlisted macOS app.",
    parameters: objectSchema({ appName: { type: "string" } }, ["appName"]),
  },
  {
    type: "function",
    name: "system_close_app",
    description: "Quit an allowlisted macOS app. Requires explicit confirmation.",
    parameters: objectSchema({ appName: { type: "string" } }, ["appName"]),
  },
  {
    type: "function",
    name: "system_set_volume",
    description: "Set macOS output volume from 0 to 100. Requires explicit confirmation.",
    parameters: objectSchema({ level: { type: "integer", minimum: 0, maximum: 100 } }, ["level"]),
  },
  {
    type: "function",
    name: "system_set_brightness",
    description: "Set display brightness from 0 to 100 if a local brightness CLI is installed. Requires explicit confirmation.",
    parameters: objectSchema({ level: { type: "integer", minimum: 0, maximum: 100 } }, ["level"]),
  },
  {
    type: "function",
    name: "system_set_dark_mode",
    description: "Turn macOS dark mode on or off. Requires explicit confirmation.",
    parameters: objectSchema({ enabled: { type: "boolean" } }, ["enabled"]),
  },
  {
    type: "function",
    name: "system_open_settings",
    description: "Open a safe System Settings pane. Does not change settings by itself.",
    parameters: objectSchema({ pane: { type: "string", description: "Optional pane name such as displays, sound, bluetooth, keyboard, privacy, accessibility, screenRecording, automation, or fullDiskAccess." } }),
  },
  {
    type: "function",
    name: "desktop_clipboard_write",
    description: "Write text to the system clipboard. This always requires explicit user confirmation.",
    parameters: objectSchema({ text: { type: "string" } }, ["text"]),
  },
  {
    type: "function",
    name: "browser_open_url",
    description: "Open an allowlisted URL in the default browser.",
    parameters: objectSchema({ url: { type: "string" } }, ["url"]),
  },
  {
    type: "function",
    name: "browser_isolated_open_url",
    description: "Open an allowlisted URL in an isolated Chrome profile with remote debugging for controlled browser automation.",
    parameters: objectSchema({ url: { type: "string" } }, ["url"]),
  },
  {
    type: "function",
    name: "browser_fill_form",
    description: "Fill form fields in the isolated browser using CSS selectors. Requires explicit confirmation.",
    parameters: objectSchema(
      {
        fields: {
          type: "array",
          items: objectSchema({ selector: { type: "string" }, value: { type: "string" } }, ["selector", "value"]),
        },
      },
      ["fields"],
    ),
  },
  {
    type: "function",
    name: "browser_click",
    description: "Click a CSS selector in the isolated browser. Submitting, paying, deleting, or publishing must be confirmed.",
    parameters: objectSchema(
      {
        selector: { type: "string" },
        purpose: { type: "string", description: "What this click is expected to do." },
      },
      ["selector", "purpose"],
    ),
  },
  {
    type: "function",
    name: "advanced_shell_command",
    description: "Run an advanced local shell command after safety checks and explicit confirmation. Dangerous commands are blocked.",
    parameters: objectSchema(
      {
        command: { type: "string" },
        reason: { type: "string", description: "Why this command is needed." },
        timeoutMs: { type: "integer", minimum: 1000, maximum: 20000, default: 10000 },
      },
      ["command", "reason"],
    ),
  },
] as const;

export const coreRealtimeToolNames = [
  "system_status",
  "confirmation_list",
  "confirmation_decide",
  "tool_result_read",
  "tool_catalog_list",
  "tool_group_set",
  "task_create",
  "task_status",
  "task_list",
  "task_cancel",
  "task_route",
  "memory_lookup",
  "memory_save",
  "memory_forget",
  "memory_status",
] as const satisfies readonly ToolName[];

export const toolGroupByName = {
  codex_task_run: "agents",
  yolo_mode_set: "permissions",
  app_permission_search: "permissions",
  app_permission_set: "permissions",
  capability_set: "permissions",
  file_list: "files",
  file_search: "files",
  file_read: "files",
  file_open: "files",
  file_create_folder: "files",
  file_rename: "files",
  file_move: "files",
  file_copy: "files",
  file_trash: "files",
  document_extract: "documents",
  document_folder_digest: "documents",
  document_prepare_edit: "documents",
  email_search: "text",
  email_read: "text",
  email_draft: "text",
  email_send: "text",
  calendar_search: "text",
  calendar_create: "text",
  copy_search: "text",
  copy_save_draft: "text",
  copy_publish: "text",
  music_open: "media",
  music_play_song: "media",
  video_play: "media",
  app_open: "apps",
  app_focus: "apps",
  app_quit: "apps",
  desktop_open_app: "apps",
  window_list: "windows",
  window_close_all: "windows",
  window_auto_arrange: "windows",
  window_minimize_unrelated: "windows",
  window_close: "windows",
  window_minimize: "windows",
  window_maximize: "windows",
  window_move_resize: "windows",
  system_close_app: "system",
  system_set_volume: "system",
  system_set_brightness: "system",
  system_set_dark_mode: "system",
  system_open_settings: "system",
  desktop_clipboard_write: "system",
  browser_open_url: "browser",
  browser_isolated_open_url: "browser",
  browser_fill_form: "browser",
  browser_click: "browser",
  advanced_shell_command: "shell",
} as const satisfies Partial<Record<ToolName, ToolGroup>>;

export const toolGroups = [
  "permissions",
  "files",
  "documents",
  "text",
  "media",
  "apps",
  "windows",
  "system",
  "browser",
  "shell",
  "agents",
] as const satisfies readonly ToolGroup[];

export const queueManagedToolDefinitions = allToolDefinitions.filter((definition) => definition.name in toolGroupByName);

export const realtimeToolDefinitions = [
  {
    type: "function",
    name: "system_status",
    description: "Check local assistant capabilities, connected adapters, current safety mode, enabled tool groups, and task queue summary.",
    parameters: objectSchema({}),
  },
  {
    type: "function",
    name: "confirmation_list",
    description: "List pending local confirmation requests that are waiting for the user's explicit approval or rejection.",
    parameters: objectSchema({}),
  },
  {
    type: "function",
    name: "confirmation_decide",
    description: "Approve or reject a pending local confirmation after the user's latest voice/text message explicitly says to confirm, approve, reject, or cancel it. If only one confirmation is pending, confirmationId may be omitted.",
    parameters: objectSchema(
      {
        confirmationId: { type: "string", description: "Pending confirmation id. Optional only when exactly one confirmation is pending." },
        approved: { type: "boolean", description: "true to approve/confirm, false to reject/cancel." },
      },
      ["approved"],
    ),
  },
  {
    type: "function",
    name: "tool_result_read",
    description: "Read a bounded slice of a previous large tool result by handle. Use only after a tool result says it was truncated and provides a handle.",
    parameters: objectSchema(
      {
        handle: { type: "string", description: "Handle returned by a truncated tool result." },
        offset: { type: "integer", minimum: 0, default: 0 },
        maxChars: { type: "integer", minimum: 200, maximum: 6000, default: 2000 },
      },
      ["handle"],
    ),
  },
  {
    type: "function",
    name: "task_route",
    description: "Classify a user request into HER native tools, HER web search, Codex background runtime, or a mixed plan. Call this before task_create when routing is unclear.",
    parameters: objectSchema(
      {
        userRequest: { type: "string", description: "The user's full request to route." },
        preference: { type: "string", enum: ["auto", "native", "search", "codex"], default: "auto" },
        cwd: { type: "string", description: "Optional working directory for Codex tasks." },
        activeApp: { type: "string", description: "Optional current/frontmost app name." },
        selectedText: { type: "string", description: "Optional selected text or short local context." },
      },
      ["userRequest"],
    ),
  },
  {
    type: "function",
    name: "memory_lookup",
    description: "Look up compact HER memory summaries. Prefer task_route first for normal task routing because it performs memory preflight internally.",
    parameters: objectSchema(
      {
        query: { type: "string" },
        types: { type: "array", items: { type: "string", enum: ["path_alias", "preference", "task_template"] } },
        limit: { type: "integer", minimum: 1, maximum: 10, default: 5 },
      },
      ["query"],
    ),
  },
  {
    type: "function",
    name: "memory_save",
    description: "Save a user-approved HER memory item. Use only when the user explicitly asks HER to remember a path, preference, or task template.",
    parameters: objectSchema(
      {
        type: { type: "string", enum: ["path_alias", "preference", "task_template"] },
        key: { type: "string" },
        value: { type: "string" },
        summary: { type: "string" },
        content: { type: "string" },
        aliases: { type: "array", items: { type: "string" } },
        tags: { type: "array", items: { type: "string" } },
      },
      ["type", "key"],
    ),
  },
  {
    type: "function",
    name: "memory_forget",
    description: "Forget a HER memory item by id or exact key. Use only when the user explicitly asks to forget it.",
    parameters: objectSchema({ idOrKey: { type: "string" } }, ["idOrKey"]),
  },
  {
    type: "function",
    name: "memory_status",
    description: "Return HER memory counts and storage status without exposing full memory content.",
    parameters: objectSchema({}),
  },
  {
    type: "function",
    name: "tool_catalog_list",
    description: "List available dynamic tool groups, or list the bounded tool catalog for one group. Call without group first; call again with a group only when you need tool names in that group.",
    parameters: objectSchema({
      group: { type: "string", enum: toolGroups, description: "Optional dynamic tool group to inspect." },
    }),
  },
  {
    type: "function",
    name: "tool_group_set",
    description: "Enable or disable a dynamic tool group for future queued tasks. Disabling a group prevents task_create from enqueueing tools in that group.",
    parameters: objectSchema(
      {
        group: { type: "string", enum: toolGroups },
        enabled: { type: "boolean" },
      },
      ["group", "enabled"],
    ),
  },
  {
    type: "function",
    name: "task_create",
    description: "Create a local task queue item for any non-core tool. Realtime should use this instead of directly carrying large or side-effecting tool calls in session context.",
    parameters: objectSchema(
      {
        toolName: { type: "string", description: "Name from tool_catalog_list for the selected group." },
        arguments: { type: "object", description: "Arguments for the selected tool.", additionalProperties: true },
        priority: { type: "string", enum: ["low", "normal", "high"], default: "normal" },
        runAfterMs: { type: "integer", minimum: 0, maximum: 600000, default: 0 },
      },
      ["toolName", "arguments"],
    ),
  },
  {
    type: "function",
    name: "task_status",
    description: "Read one task queue item by id, including status, confirmation id when waiting for approval, and compact result when complete.",
    parameters: objectSchema({ taskId: { type: "string" } }, ["taskId"]),
  },
  {
    type: "function",
    name: "task_list",
    description: "List recent task queue items with compact status. Use this to monitor queued or running work without loading large outputs.",
    parameters: objectSchema({
      status: { type: "string", enum: ["queued", "running", "completed", "failed", "cancelled", "needs_confirmation"] },
      limit: { type: "integer", minimum: 1, maximum: 30, default: 10 },
    }),
  },
  {
    type: "function",
    name: "task_cancel",
    description: "Cancel a queued task. Running tasks cannot be force-killed, but queued work is skipped.",
    parameters: objectSchema({ taskId: { type: "string" } }, ["taskId"]),
  },
] as const;

export const toolsRequiringConfirmation = new Set<ToolName>([
  "codex_task_run",
  "file_rename",
  "file_create_folder",
  "file_move",
  "file_copy",
  "file_trash",
  "document_prepare_edit",
  "email_send",
  "calendar_create",
  "copy_publish",
  "app_quit",
  "window_close_all",
  "window_close",
  "system_close_app",
  "system_set_volume",
  "system_set_brightness",
  "system_set_dark_mode",
  "desktop_clipboard_write",
  "browser_fill_form",
  "browser_click",
  "advanced_shell_command",
]);
