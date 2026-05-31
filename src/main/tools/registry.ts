import { spawn } from "node:child_process";
import { z } from "zod";
import { config } from "../config";
import { AuditLog } from "../audit";
import type { ToolCallRequest, ToolCallResult, ToolName } from "../../shared/tools";
import { toolsRequiringConfirmation } from "../../shared/tools";
import type { CapabilityKey, CapabilitySettings, InstalledApp, UserSettings } from "../../shared/app-settings";
import { ConfirmationQueue } from "./confirmation";
import { LocalStore } from "./local-store";
import { FileManager } from "./file-manager";
import { DocumentAssistant } from "./document-assistant";
import { SystemControl } from "./system-control";
import { BrowserAutomation } from "./browser-automation";
import { AdvancedShell } from "./advanced-shell";
import { MusicControl } from "./music-control";
import { VideoControl } from "./video-control";
import { CapabilityGate } from "../capability-gate";

const limitSchema = z.number().int().min(1).max(10).optional().default(5);
const folderNameSchema = z.string().min(1).refine(
  (value) => {
    const trimmed = value.trim();
    return Boolean(trimmed) && trimmed !== "." && trimmed !== ".." && !trimmed.includes("/") && !trimmed.includes("\\");
  },
  { message: "folderName must be a valid folder name without slashes." },
);

const schemas: Record<ToolName, z.ZodTypeAny> = {
  system_status: z.object({}),
  confirmation_list: z.object({}),
  confirmation_decide: z.object({ confirmationId: z.string().min(1).optional(), approved: z.boolean() }),
  yolo_mode_set: z.object({ enabled: z.boolean() }),
  file_list: z.object({ path: z.string().min(1), includeHidden: z.boolean().optional().default(false) }),
  file_search: z.object({ root: z.string().min(1), query: z.string(), maxDepth: z.number().int().min(1).max(8).optional().default(4), limit: z.number().int().min(1).max(50).optional().default(20) }),
  file_read: z.object({ path: z.string().min(1), maxChars: z.number().int().min(100).max(20000).optional().default(6000) }),
  file_open: z.object({ path: z.string().min(1), appName: z.string().min(1).optional() }),
  file_create_folder: z.object({ parentPath: z.string().min(1), folderName: folderNameSchema }),
  file_rename: z.object({ path: z.string().min(1), newName: z.string().min(1) }),
  file_move: z.object({ from: z.string().min(1), to: z.string().min(1) }),
  file_copy: z.object({ from: z.string().min(1), to: z.string().min(1) }),
  file_trash: z.object({ path: z.string().min(1) }),
  document_extract: z.object({ path: z.string().min(1), maxChars: z.number().int().min(500).max(60000).optional().default(12000) }),
  document_folder_digest: z.object({ root: z.string().min(1), query: z.string().optional(), limit: z.number().int().min(1).max(20).optional().default(8), charsPerFile: z.number().int().min(500).max(10000).optional().default(2500) }),
  document_prepare_edit: z.object({ path: z.string().min(1), newContent: z.string() }),
  email_search: z.object({ query: z.string().min(1), limit: limitSchema }),
  email_read: z.object({ emailId: z.string().min(1) }),
  email_draft: z.object({ to: z.string().min(1), subject: z.string().min(1), body: z.string().min(1) }),
  email_send: z.object({ draftId: z.string().min(1) }),
  calendar_search: z.object({ from: z.string().min(1), to: z.string().min(1), query: z.string().optional() }),
  calendar_create: z.object({
    title: z.string().min(1),
    start: z.string().min(1),
    end: z.string().min(1),
    attendees: z.array(z.string()).optional().default([]),
    location: z.string().optional(),
    notes: z.string().optional(),
  }),
  copy_search: z.object({ query: z.string().min(1), limit: limitSchema }),
  copy_save_draft: z.object({ title: z.string().min(1), body: z.string().min(1), project: z.string().optional() }),
  copy_publish: z.object({ draftId: z.string().min(1) }),
  music_open: z.object({}),
  music_play_song: z.object({ query: z.string().min(1), artist: z.string().optional() }),
  video_play: z.object({ service: z.enum(["youtube", "apple_tv"]), query: z.string().min(1) }),
  app_open: z.object({ appName: z.string().min(1) }),
  app_focus: z.object({ appName: z.string().min(1) }),
  app_quit: z.object({ appName: z.string().min(1) }),
  window_list: z.object({}),
  window_close_all: z.object({}),
  window_auto_arrange: z.object({ appNames: z.array(z.string().min(1)).optional().default([]) }),
  window_minimize_unrelated: z.object({
    keepAppNames: z.array(z.string().min(1)).optional().default([]),
    keepTitleKeywords: z.array(z.string().min(1)).optional().default([]),
    preserveFrontmost: z.boolean().optional().default(true),
  }),
  window_close: z.object({ appName: z.string().min(1) }),
  window_minimize: z.object({ appName: z.string().min(1) }),
  window_maximize: z.object({ appName: z.string().min(1) }),
  window_move_resize: z.object({
    appName: z.string().min(1),
    x: z.number().int(),
    y: z.number().int(),
    width: z.number().int().min(120),
    height: z.number().int().min(120),
  }),
  desktop_open_app: z.object({ appName: z.string().min(1) }),
  system_close_app: z.object({ appName: z.string().min(1) }),
  system_set_volume: z.object({ level: z.number().int().min(0).max(100) }),
  system_set_brightness: z.object({ level: z.number().int().min(0).max(100) }),
  system_set_dark_mode: z.object({ enabled: z.boolean() }),
  system_open_settings: z.object({ pane: z.string().optional() }),
  desktop_clipboard_write: z.object({ text: z.string().min(1) }),
  browser_open_url: z.object({ url: z.string().url() }),
  browser_isolated_open_url: z.object({ url: z.string().url() }),
  browser_fill_form: z.object({ fields: z.array(z.object({ selector: z.string().min(1), value: z.string() })).min(1).max(30) }),
  browser_click: z.object({ selector: z.string().min(1), purpose: z.string().min(1) }),
  advanced_shell_command: z.object({ command: z.string().min(1), reason: z.string().min(1), timeoutMs: z.number().int().min(1000).max(60000).optional().default(15000) }),
  app_permission_search: z.object({ query: z.string(), limit: z.number().int().min(1).max(20).optional().default(8) }),
  app_permission_set: z.object({ appName: z.string().min(1), authorized: z.boolean() }),
  capability_set: z.object({ capability: z.enum(["fileManagement", "browserAutomation", "textOperations", "systemOperations"]), enabled: z.boolean() }),
};

type PermissionManager = {
  listApps: (refresh?: boolean) => Promise<InstalledApp[]>;
  readSettings: () => UserSettings;
  setAppPermissions: (appPermissions: Record<string, boolean>) => UserSettings;
  setCapabilities: (capabilities: Partial<CapabilitySettings>) => UserSettings;
  setYoloMode: (enabled: boolean, appPermissions?: Record<string, boolean>) => UserSettings;
};

const runCommand = (command: string, args: string[]) =>
  new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore" });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${code}`));
    });
  });

const writeClipboard = (text: string) =>
  new Promise<void>((resolve, reject) => {
    const child = spawn("pbcopy", [], { stdio: ["pipe", "ignore", "ignore"] });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`pbcopy exited with code ${code}`));
    });
    child.stdin.end(text);
  });

export class ToolRegistry {
  private store = new LocalStore();
  private files = new FileManager();
  private documents = new DocumentAssistant(this.files);
  private system = new SystemControl();
  private browser = new BrowserAutomation();
  private shell = new AdvancedShell();
  private music = new MusicControl();
  private video = new VideoControl();

  constructor(
    private confirmations: ConfirmationQueue,
    private audit: AuditLog,
    private gate?: CapabilityGate,
    private permissions?: PermissionManager,
  ) {}

  async execute(request: ToolCallRequest): Promise<ToolCallResult> {
    if (!(request.name in schemas)) {
      return { ok: false, name: request.name, error: `Unknown tool: ${request.name}`, code: "unknown_tool" };
    }

    const parsed = schemas[request.name].safeParse(request.arguments);
    if (!parsed.success) {
      return {
        ok: false,
        name: request.name,
        error: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "),
        code: "invalid_arguments",
      };
    }

    const run = () => this.run(request.name, parsed.data);
    let summary = this.summary(request.name, parsed.data);

    if (this.gate) {
      try {
        await this.gate.assertToolAllowed(request.name, parsed.data);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.audit.write({ action: request.name, summary: message, status: "error" });
        return { ok: false, name: request.name, error: message, code: "capability_denied" };
      }
    }

    if (request.name === "document_prepare_edit") {
      try {
        const preview = await this.documents.prepareEdit(parsed.data.path, parsed.data.newContent);
        summary = `Edit document ${preview.path}\nDiff preview:\n${preview.diffPreview}`;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.audit.write({ action: request.name, summary: message, status: "error" });
        return { ok: false, name: request.name, error: message };
      }
    }

    if (request.name === "advanced_shell_command") {
      try {
        this.shell.validate(parsed.data.command);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.audit.write({ action: request.name, summary: message, status: "error" });
        return { ok: false, name: request.name, error: message, code: "blocked_shell_command" };
      }
    }

    if (toolsRequiringConfirmation.has(request.name) && !this.isYoloMode()) {
      const confirmation = this.confirmations.add({ name: request.name, summary, run });
      this.audit.write({ action: request.name, summary, status: "needs_confirmation" });
      return {
        ok: true,
        name: request.name,
        requiresConfirmation: true,
        confirmationId: confirmation.id,
        summary,
        expiresAt: new Date(confirmation.expiresAt).toISOString(),
      };
    }

    try {
      const result = await run();
      this.audit.write({ action: request.name, summary, status: "ok" });
      return { ok: true, name: request.name, result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.audit.write({ action: request.name, summary: message, status: "error" });
      return { ok: false, name: request.name, error: message };
    }
  }

  async confirm(confirmationId: string, approved: boolean) {
    const result = await this.confirmations.decide(confirmationId, approved);
    const summary = result.rejected ? (result.summary ?? `Rejected ${confirmationId}`) : `Approved ${confirmationId}`;
    this.audit.write({
      action: "confirmation",
      summary,
      status: result.rejected ? "rejected" : "ok",
    });
    return result;
  }

  private async run(name: ToolName, args: Record<string, unknown>) {
    switch (name) {
      case "system_status":
        return {
          model: config.realtimeModel,
          voice: config.realtimeVoice,
          safetyMode: this.isYoloMode() ? "YOLO mode: local confirmations bypassed" : "confirm writes and external side effects",
          allowedApps: config.allowedApps,
          allowedDirectories: config.allowedDirectories,
          adapters: {
            email: "local-draft-adapter",
            calendar: "local-calendar-adapter",
            copy: "local-copy-adapter",
            files: "allowlisted-local-file-manager",
            documents: "txt-md-pdf-docx-extractor",
            desktop: "macos-allowlist",
            music: "macos-music-applescript",
            browser: "isolated-chrome-profile",
            shell: "confirm-first-safe-subset",
          },
        };
      case "confirmation_list":
        return this.listConfirmations();
      case "confirmation_decide":
        return this.decideConfirmation(args.confirmationId as string | undefined, args.approved as boolean);
      case "yolo_mode_set":
        return this.setYoloMode(args.enabled as boolean);
      case "app_permission_search":
        return this.searchAppPermissions(args.query as string, args.limit as number);
      case "app_permission_set":
        return this.setAppPermission(args.appName as string, args.authorized as boolean);
      case "capability_set":
        return this.setCapability(args.capability as CapabilityKey, args.enabled as boolean);
      case "file_list":
        return this.files.list(args.path as string, args.includeHidden as boolean);
      case "file_search":
        return this.files.search(args.root as string, args.query as string, args.maxDepth as number, args.limit as number);
      case "file_read":
        return this.files.readText(args.path as string, args.maxChars as number);
      case "file_open":
        return this.files.open(args.path as string, args.appName as string | undefined);
      case "file_create_folder":
        return this.files.createFolder(args.parentPath as string, args.folderName as string);
      case "file_rename":
        return this.files.rename(args.path as string, args.newName as string);
      case "file_move":
        return this.files.move(args.from as string, args.to as string);
      case "file_copy":
        return this.files.copy(args.from as string, args.to as string);
      case "file_trash":
        return this.files.trash(args.path as string);
      case "document_extract":
        return this.documents.extract(args.path as string, args.maxChars as number);
      case "document_folder_digest":
        return this.documents.folderDigest(args.root as string, args.query as string | undefined, args.limit as number, args.charsPerFile as number);
      case "document_prepare_edit":
        return this.files.writeText(args.path as string, args.newContent as string);
      case "email_search":
        return this.store.searchEmails(args.query as string, args.limit as number);
      case "email_read":
        return this.store.readEmail(args.emailId as string);
      case "email_draft":
        return this.store.createEmailDraft(args as { to: string; subject: string; body: string });
      case "email_send":
        return this.store.markEmailSent(args.draftId as string);
      case "calendar_search":
        return this.store.searchCalendar(args.from as string, args.to as string, args.query as string | undefined);
      case "calendar_create":
        this.assertChronological(args.start as string, args.end as string);
        return this.store.createCalendarEvent(args as { title: string; start: string; end: string; attendees: string[]; location?: string; notes?: string });
      case "copy_search":
        return this.store.searchCopy(args.query as string, args.limit as number);
      case "copy_save_draft":
        return this.store.saveCopyDraft(args as { title: string; body: string; project?: string });
      case "copy_publish":
        return this.store.publishCopyDraft(args.draftId as string);
      case "music_open":
        return this.music.open();
      case "music_play_song":
        return this.music.playSong(args.query as string, args.artist as string | undefined);
      case "video_play":
        return this.video.play(args.service as "youtube" | "apple_tv", args.query as string);
      case "app_open":
        return this.system.openApp(args.appName as string);
      case "app_focus":
        return this.system.focusApp(args.appName as string);
      case "app_quit":
        return this.system.quitApp(args.appName as string);
      case "window_list":
        return this.listAuthorizedWindows();
      case "window_close_all":
        return this.closeAllAuthorizedWindows();
      case "window_auto_arrange":
        return this.autoArrangeAuthorizedWindows(args.appNames as string[]);
      case "window_minimize_unrelated":
        return this.minimizeUnrelatedAuthorizedWindows({
          keepAppNames: args.keepAppNames as string[],
          keepTitleKeywords: args.keepTitleKeywords as string[],
          preserveFrontmost: args.preserveFrontmost as boolean,
        });
      case "window_close":
        return this.system.closeWindow(args.appName as string);
      case "window_minimize":
        return this.system.minimizeWindow(args.appName as string);
      case "window_maximize":
        return this.system.maximizeWindow(args.appName as string);
      case "window_move_resize":
        return this.system.moveResizeWindow(
          args.appName as string,
          args.x as number,
          args.y as number,
          args.width as number,
          args.height as number,
        );
      case "desktop_open_app":
        return this.system.openApp(args.appName as string);
      case "system_close_app":
        return this.system.closeApp(args.appName as string);
      case "system_set_volume":
        return this.system.setVolume(args.level as number);
      case "system_set_brightness":
        return this.system.setBrightness(args.level as number);
      case "system_set_dark_mode":
        return this.system.setDarkMode(args.enabled as boolean);
      case "system_open_settings":
        return this.system.openSettings(args.pane as string | undefined);
      case "desktop_clipboard_write":
        await writeClipboard(args.text as string);
        return { written: true };
      case "browser_open_url":
        return this.openUrl(args.url as string);
      case "browser_isolated_open_url":
        return this.browser.openIsolatedUrl(args.url as string);
      case "browser_fill_form":
        return this.browser.fillForm(args.fields as Array<{ selector: string; value: string }>);
      case "browser_click":
        return this.browser.click(args.selector as string, args.purpose as string);
      case "advanced_shell_command":
        return this.shell.run(args.command as string, args.timeoutMs as number);
    }
  }

  private summary(name: ToolName, args: Record<string, unknown>) {
    switch (name) {
      case "email_send":
        return `Send email draft ${args.draftId}`;
      case "confirmation_list":
        return "List pending confirmations";
      case "confirmation_decide":
        return `${args.approved ? "Approve" : "Reject"} confirmation ${args.confirmationId ?? "if only one is pending"}`;
      case "yolo_mode_set":
        return `Turn YOLO mode ${args.enabled ? "on" : "off"}`;
      case "email_read":
        return `Read email ${args.emailId}`;
      case "calendar_create":
        return `Create calendar event "${args.title}" from ${args.start} to ${args.end}`;
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
      case "video_play":
        return `Play ${args.service} video for ${args.query}`;
      case "app_open":
        return `Open app ${args.appName}`;
      case "app_focus":
        return `Focus app ${args.appName}`;
      case "app_quit":
        return `Quit app ${args.appName}`;
      case "window_close_all":
        return "Close all visible windows for authorized apps";
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
      case "desktop_open_app":
        return `Open app ${args.appName}`;
      case "system_close_app":
        return `Quit app ${args.appName}`;
      case "system_set_volume":
        return `Set system volume to ${args.level}`;
      case "system_set_brightness":
        return `Set display brightness to ${args.level}`;
      case "system_set_dark_mode":
        return `Turn dark mode ${args.enabled ? "on" : "off"}`;
      case "browser_fill_form":
        return `Fill ${(args.fields as unknown[] | undefined)?.length ?? 0} browser form fields`;
      case "browser_click":
        return `Click browser selector ${args.selector} for: ${args.purpose}`;
      case "advanced_shell_command":
        return `Run shell command for ${args.reason}: ${args.command}`;
      case "browser_open_url":
        return `Open URL ${args.url}`;
      case "browser_isolated_open_url":
        return `Open isolated browser URL ${args.url}`;
      case "app_permission_search":
        return `Search app permissions for ${args.query}`;
      case "app_permission_set":
        return `${args.authorized ? "Authorize" : "Revoke authorization for"} app ${args.appName}`;
      case "capability_set":
        return `Turn ${args.capability} ${args.enabled ? "on" : "off"}`;
      default:
        return `${name} ${JSON.stringify(args)}`;
    }
  }

  private async openUrl(rawUrl: string) {
    const url = new URL(rawUrl);
    if (!["http:", "https:"].includes(url.protocol)) {
      throw new Error(`URL protocol is not allowed: ${url.protocol}`);
    }
    await runCommand("open", [url.toString()]);
    return { opened: url.toString() };
  }

  private async listAuthorizedWindows() {
    const windows = await this.system.listWindows();
    if (!this.gate) return windows;
    const authorized = await this.gate.authorizedAppNames();
    return windows.filter((window) => authorized.has(window.appName));
  }

  private async closeAllAuthorizedWindows() {
    if (!this.gate) return this.system.closeAllWindows();
    const authorized = await this.gate.authorizedAppNames();
    const windows = await this.system.listWindows();
    const appNames = new Set(windows.map((window) => window.appName).filter((appName) => authorized.has(appName)));
    return this.system.closeAllWindows(appNames);
  }

  private async autoArrangeAuthorizedWindows(requestedAppNames: string[]) {
    if (!this.gate) return this.system.autoArrangeWindows(requestedAppNames);
    const authorized = await this.gate.authorizedAppNames();
    const windows = await this.system.listWindows();
    const requested = new Set(requestedAppNames);
    const appNames = new Set(
      windows
        .map((window) => window.appName)
        .filter((appName) => authorized.has(appName))
        .filter((appName) => requested.size === 0 || requested.has(appName)),
    );
    return this.system.autoArrangeWindows(appNames);
  }

  private async minimizeUnrelatedAuthorizedWindows(options: {
    keepAppNames: string[];
    keepTitleKeywords: string[];
    preserveFrontmost: boolean;
  }) {
    if (!this.gate) return this.system.minimizeUnrelatedWindows(options);
    const authorized = await this.gate.authorizedAppNames();
    const windows = await this.system.listWindows();
    const appNames = new Set(windows.map((window) => window.appName).filter((appName) => authorized.has(appName)));
    return this.system.minimizeUnrelatedWindows({ ...options, appNames });
  }

  private listConfirmations() {
    return this.confirmations.list().map((item) => ({
      confirmationId: item.id,
      name: item.name,
      summary: item.summary,
      expiresAt: new Date(item.expiresAt).toISOString(),
    }));
  }

  private async decideConfirmation(confirmationId: string | undefined, approved: boolean) {
    const pending = this.confirmations.list();
    const id = confirmationId ?? (pending.length === 1 ? pending[0].id : undefined);
    if (!id) {
      throw new Error(`There are ${pending.length} pending confirmations. Use confirmation_list and specify confirmationId.`);
    }

    const result = await this.confirmations.decide(id, approved);
    const summary = result.rejected ? (result.summary ?? `Rejected ${id}`) : `Approved ${id}`;
    this.audit.write({
      action: "confirmation",
      summary,
      status: result.rejected ? "rejected" : "ok",
    });
    return {
      confirmationId: id,
      approved,
      result: result.rejected ? { rejected: true, summary: result.summary } : result.result,
    };
  }

  private async searchAppPermissions(query: string, limit: number) {
    const permissions = this.requirePermissions();
    const apps = await permissions.listApps();
    const normalized = normalizeAppName(query);
    const matches = apps
      .filter((app) => {
        if (!normalized) return app.recommended || app.authorized;
        return normalizeAppName(app.name).includes(normalized) || normalizeAppName(app.bundleId).includes(normalized);
      })
      .slice(0, limit)
      .map(toPermissionResult);

    return { matches };
  }

  private async setAppPermission(appName: string, authorized: boolean) {
    const permissions = this.requirePermissions();
    const apps = await permissions.listApps();
    const app = findInstalledApp(apps, appName);
    if (!app) {
      return {
        updated: false,
        message: `No installed app matched "${appName}". Use app_permission_search first if the name is ambiguous.`,
      };
    }

    const current = permissions.readSettings();
    const next = permissions.setAppPermissions({
      ...current.appPermissions,
      [app.bundleId]: authorized,
    });
    const refreshed = (await permissions.listApps()).find((item) => item.bundleId === app.bundleId) ?? app;

    return {
      updated: true,
      app: toPermissionResult({ ...refreshed, authorized }),
      highRiskWarning: authorized && refreshed.risk === "high" ? "This is a high-risk app. Dangerous actions still require confirmation." : undefined,
      settingsUpdatedAt: next.updatedAt,
    };
  }

  private setCapability(capability: CapabilityKey, enabled: boolean) {
    const permissions = this.requirePermissions();
    const settings = permissions.setCapabilities({ [capability]: enabled });
    return { capability, enabled: settings.capabilities[capability], settingsUpdatedAt: settings.updatedAt };
  }

  private async setYoloMode(enabled: boolean) {
    const permissions = this.requirePermissions();
    const appPermissions = enabled ? Object.fromEntries((await permissions.listApps()).map((app) => [app.bundleId, true])) : {};
    const settings = permissions.setYoloMode(enabled, appPermissions);
    return {
      enabled: settings.yoloMode,
      authorizedApps: enabled ? Object.keys(appPermissions).length : undefined,
      settingsUpdatedAt: settings.updatedAt,
    };
  }

  private isYoloMode() {
    return Boolean(this.permissions?.readSettings().yoloMode);
  }

  private requirePermissions() {
    if (!this.permissions) throw new Error("Permission tools are not configured.");
    return this.permissions;
  }

  private assertChronological(start: string, end: string) {
    const startMs = new Date(start).getTime();
    const endMs = new Date(end).getTime();
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
      throw new Error("Calendar event requires valid ISO start/end times with end after start.");
    }
  }
}

const normalizeAppName = (value: string) => value.trim().toLowerCase();

const findInstalledApp = (apps: InstalledApp[], query: string) => {
  const normalized = normalizeAppName(query);
  return (
    apps.find((app) => normalizeAppName(app.name) === normalized || normalizeAppName(app.bundleId) === normalized) ??
    apps.find((app) => normalizeAppName(app.name).includes(normalized))
  );
};

const toPermissionResult = (app: InstalledApp) => ({
  name: app.name,
  bundleId: app.bundleId,
  authorized: app.authorized,
  recommended: app.recommended,
  risk: app.risk,
  capabilities: app.capabilities,
});
