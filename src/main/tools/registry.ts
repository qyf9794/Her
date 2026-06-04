import { spawn } from "node:child_process";
import { z } from "zod";
import { config } from "../config";
import { AuditLog } from "../audit";
import type { ToolCallRequest, ToolCallResult, ToolGroup, ToolName } from "../../shared/tools";
import { allToolDefinitions, toolGroupByName, toolGroups, toolsRequiringConfirmation } from "../../shared/tools";
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
const TOOL_OUTPUT_INLINE_LIMIT = 3500;
const TOOL_RESULT_CACHE_TTL_MS = 10 * 60 * 1000;
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
  tool_result_read: z.object({
    handle: z.string().min(1),
    offset: z.number().int().min(0).optional().default(0),
    maxChars: z.number().int().min(200).max(6000).optional().default(2000),
  }),
  tool_catalog_list: z.object({ group: z.enum(toolGroups).optional() }),
  tool_group_set: z.object({ group: z.enum(toolGroups), enabled: z.boolean() }),
  task_create: z.object({
    toolName: z.string().min(1),
    arguments: z.record(z.string(), z.unknown()).optional().default({}),
    priority: z.enum(["low", "normal", "high"]).optional().default("normal"),
    runAfterMs: z.number().int().min(0).max(600000).optional().default(0),
  }),
  task_status: z.object({ taskId: z.string().min(1) }),
  task_list: z.object({
    status: z.enum(["queued", "running", "completed", "failed", "cancelled", "needs_confirmation"]).optional(),
    limit: z.number().int().min(1).max(30).optional().default(10),
  }),
  task_cancel: z.object({ taskId: z.string().min(1) }),
  yolo_mode_set: z.object({ enabled: z.boolean() }),
  file_list: z.object({ path: z.string().min(1), includeHidden: z.boolean().optional().default(false) }),
  file_search: z.object({ root: z.string().min(1), query: z.string(), maxDepth: z.number().int().min(1).max(8).optional().default(4), limit: z.number().int().min(1).max(50).optional().default(20) }),
  file_read: z.object({ path: z.string().min(1), maxChars: z.number().int().min(100).max(10000).optional().default(3000) }),
  file_open: z.object({ path: z.string().min(1), appName: z.string().min(1).optional() }),
  file_create_folder: z.object({ parentPath: z.string().min(1), folderName: folderNameSchema }),
  file_rename: z.object({ path: z.string().min(1), newName: z.string().min(1) }),
  file_move: z.object({ from: z.string().min(1), to: z.string().min(1) }),
  file_copy: z.object({ from: z.string().min(1), to: z.string().min(1) }),
  file_trash: z.object({ path: z.string().min(1) }),
  document_extract: z.object({ path: z.string().min(1), maxChars: z.number().int().min(500).max(10000).optional().default(3000) }),
  document_folder_digest: z.object({ root: z.string().min(1), query: z.string().optional(), limit: z.number().int().min(1).max(5).optional().default(3), charsPerFile: z.number().int().min(300).max(2000).optional().default(1000) }),
  document_prepare_edit: z.object({ path: z.string().min(1), newContent: z.string() }),
  email_search: z.object({ query: z.string().min(1), limit: limitSchema }),
  email_read: z.object({ emailId: z.string().min(1) }),
  email_draft: z.object({ to: z.string().min(1), subject: z.string().min(1), body: z.string().min(1) }),
  email_send: z.object({ draftId: z.string().min(1) }),
  calendar_search: z.object({ from: z.string().min(1), to: z.string().min(1), query: z.string().optional(), limit: z.number().int().min(1).max(20).optional().default(10) }),
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
  advanced_shell_command: z.object({ command: z.string().min(1), reason: z.string().min(1), timeoutMs: z.number().int().min(1000).max(20000).optional().default(10000) }),
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

type TaskPriority = "low" | "normal" | "high";
type TaskStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "needs_confirmation";

type QueuedTask = {
  id: string;
  toolName: ToolName;
  arguments: Record<string, unknown>;
  group: ToolGroup;
  priority: TaskPriority;
  status: TaskStatus;
  createdAt: number;
  updatedAt: number;
  runAt: number;
  startedAt?: number;
  completedAt?: number;
  result?: ToolCallResult;
  error?: string;
  confirmationId?: string;
  summary?: string;
};

const toolGroupLookup: Partial<Record<ToolName, ToolGroup>> = toolGroupByName;

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
  private resultCache = new Map<string, { value: string; createdAt: number; name: ToolName }>();
  private tasks = new Map<string, QueuedTask>();
  private taskOrder: string[] = [];
  private enabledToolGroups = new Set<ToolGroup>(toolGroups);
  private runningTaskCount = 0;
  private isProcessingTasks = false;
  private readonly maxConcurrentTasks = 1;
  private readonly maxTasks = 100;

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

    const args = parsed.data as Record<string, unknown>;
    if (this.isTaskControlTool(request.name)) {
      return this.executeTaskControlTool(request.name, args);
    }

    return this.executeValidatedTool(request.name, args);
  }

  private async executeValidatedTool(name: ToolName, args: Record<string, unknown>): Promise<ToolCallResult> {
    const run = () => this.run(name, args);
    let summary = this.summary(name, args);

    if (this.gate) {
      try {
        await this.gate.assertToolAllowed(name, args);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.audit.write({ action: name, summary: message, status: "error" });
        return { ok: false, name, error: message, code: "capability_denied" };
      }
    }

    if (name === "document_prepare_edit") {
      try {
        const preview = await this.documents.prepareEdit(args.path as string, args.newContent as string);
        summary = `Edit document ${preview.path}\nDiff preview:\n${preview.diffPreview}`;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.audit.write({ action: name, summary: message, status: "error" });
        return { ok: false, name, error: message };
      }
    }

    if (name === "advanced_shell_command") {
      try {
        this.shell.validate(args.command as string);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.audit.write({ action: name, summary: message, status: "error" });
        return { ok: false, name, error: message, code: "blocked_shell_command" };
      }
    }

    if (toolsRequiringConfirmation.has(name) && !this.isYoloMode()) {
      const confirmation = this.confirmations.add({ name, summary, run });
      this.audit.write({ action: name, summary, status: "needs_confirmation" });
      return {
        ok: true,
        name,
        requiresConfirmation: true,
        confirmationId: confirmation.id,
        summary,
        expiresAt: new Date(confirmation.expiresAt).toISOString(),
      };
    }

    try {
      const result = await run();
      this.audit.write({ action: name, summary, status: "ok" });
      return { ok: true, name, result: this.compactResult(name, result) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.audit.write({ action: name, summary: message, status: "error" });
      return { ok: false, name, error: message };
    }
  }

  private async executeTaskControlTool(name: ToolName, args: Record<string, unknown>): Promise<ToolCallResult> {
    try {
      const result = await this.runTaskControlTool(name, args);
      this.audit.write({ action: name, summary: this.summary(name, args), status: "ok" });
      return { ok: true, name, result: this.compactResult(name, result) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.audit.write({ action: name, summary: message, status: "error" });
      return { ok: false, name, error: message };
    }
  }

  private runTaskControlTool(name: ToolName, args: Record<string, unknown>) {
    switch (name) {
      case "tool_catalog_list":
        return this.listToolCatalog(args.group as ToolGroup | undefined);
      case "tool_group_set":
        return this.setToolGroup(args.group as ToolGroup, args.enabled as boolean);
      case "task_create":
        return this.createTask(
          args.toolName as string,
          args.arguments as Record<string, unknown>,
          args.priority as TaskPriority,
          args.runAfterMs as number,
        );
      case "task_status":
        return this.getTaskStatus(args.taskId as string);
      case "task_list":
        return this.listTasks(args.status as TaskStatus | undefined, args.limit as number);
      case "task_cancel":
        return this.cancelTask(args.taskId as string);
      default:
        throw new Error(`Not a task control tool: ${name}`);
    }
  }

  async confirm(confirmationId: string, approved: boolean) {
    const result = await this.confirmations.decide(confirmationId, approved);
    this.updateTaskForConfirmation(confirmationId, approved, result);
    const summary = result.rejected ? (result.summary ?? `Rejected ${confirmationId}`) : `Approved ${confirmationId}`;
    this.audit.write({
      action: "confirmation",
      summary,
      status: result.rejected ? "rejected" : "ok",
    });
    if (result.rejected) return result;
    return { ...result, result: this.compactResult("confirmation_decide", result.result) };
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
          toolGroups: this.listToolGroups(),
          taskQueue: this.taskQueueSummary(),
        };
      case "confirmation_list":
        return this.listConfirmations();
      case "confirmation_decide":
        return this.decideConfirmation(args.confirmationId as string | undefined, args.approved as boolean);
      case "tool_result_read":
        return this.readCachedToolResult(args.handle as string, args.offset as number, args.maxChars as number);
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
        return this.store.searchCalendar(args.from as string, args.to as string, args.query as string | undefined, args.limit as number);
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

  private isTaskControlTool(name: ToolName) {
    return name === "tool_catalog_list" || name === "tool_group_set" || name === "task_create" || name === "task_status" || name === "task_list" || name === "task_cancel";
  }

  private isQueueManagedToolName(name: string): name is ToolName {
    return Boolean(toolGroupLookup[name as ToolName]) && name in schemas;
  }

  private listToolCatalog(group?: ToolGroup) {
    if (!group) {
      return {
        groups: this.listToolGroups(),
        nextAction: "Call tool_catalog_list with one group to inspect tool names before task_create.",
      };
    }

    const tools = allToolDefinitions
      .filter((definition) => toolGroupLookup[definition.name] === group)
      .map((definition) => ({
        name: definition.name,
        group,
        description: truncateText(definition.description, 220),
        requiresConfirmation: toolsRequiringConfirmation.has(definition.name),
        arguments: compactJsonSchema(definition.parameters),
      }));

    return {
      group,
      enabled: this.enabledToolGroups.has(group),
      tools,
      nextAction: "Use task_create with one listed tool name and validated arguments.",
    };
  }

  private listToolGroups() {
    return toolGroups.map((group) => ({
      group,
      enabled: this.enabledToolGroups.has(group),
      toolCount: allToolDefinitions.filter((definition) => toolGroupLookup[definition.name] === group).length,
    }));
  }

  private setToolGroup(group: ToolGroup, enabled: boolean) {
    if (enabled) this.enabledToolGroups.add(group);
    else this.enabledToolGroups.delete(group);
    return {
      group,
      enabled: this.enabledToolGroups.has(group),
      enabledGroups: [...this.enabledToolGroups].sort(),
    };
  }

  private createTask(toolName: string, rawArguments: Record<string, unknown>, priority: TaskPriority, runAfterMs: number) {
    if (!this.isQueueManagedToolName(toolName)) {
      throw new Error(`Tool is not queue-managed or does not exist: ${toolName}. Use tool_catalog_list first.`);
    }

    const group = toolGroupLookup[toolName];
    if (!group) {
      throw new Error(`Tool cannot be queued: ${toolName}`);
    }
    if (!this.enabledToolGroups.has(group)) {
      throw new Error(`Tool group is disabled: ${group}`);
    }

    const parsed = schemas[toolName].safeParse(rawArguments ?? {});
    if (!parsed.success) {
      throw new Error(parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "));
    }

    const now = Date.now();
    const task: QueuedTask = {
      id: crypto.randomUUID(),
      toolName,
      arguments: parsed.data as Record<string, unknown>,
      group,
      priority,
      status: "queued",
      createdAt: now,
      updatedAt: now,
      runAt: now + runAfterMs,
      summary: this.summary(toolName, parsed.data as Record<string, unknown>),
    };
    this.tasks.set(task.id, task);
    this.taskOrder.unshift(task.id);
    this.pruneTasks();
    if (runAfterMs > 0) setTimeout(() => void this.processTasks(), runAfterMs);
    void this.processTasks();
    return {
      task: this.toTaskView(task),
      queue: this.taskQueueSummary(),
      nextAction: "Use task_status with taskId, or task_list to monitor recent work.",
    };
  }

  private getTaskStatus(taskId: string) {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    return { task: this.toTaskView(task, true), queue: this.taskQueueSummary() };
  }

  private listTasks(status: TaskStatus | undefined, limit: number) {
    const tasks = this.taskOrder
      .map((id) => this.tasks.get(id))
      .filter((task): task is QueuedTask => Boolean(task))
      .filter((task) => !status || task.status === status)
      .slice(0, limit)
      .map((task) => this.toTaskView(task, false));

    return { tasks, queue: this.taskQueueSummary() };
  }

  private cancelTask(taskId: string) {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    if (task.status !== "queued") {
      return {
        task: this.toTaskView(task, false),
        cancelled: false,
        reason: "Only queued tasks can be cancelled. Running or confirmation-waiting tasks must finish or be rejected.",
      };
    }

    task.status = "cancelled";
    task.updatedAt = Date.now();
    task.completedAt = task.updatedAt;
    return { task: this.toTaskView(task, false), cancelled: true };
  }

  private async processTasks() {
    if (this.isProcessingTasks) return;
    this.isProcessingTasks = true;
    try {
      while (this.runningTaskCount < this.maxConcurrentTasks) {
        const task = this.nextQueuedTask();
        if (!task) return;
        await this.runQueuedTask(task);
      }
    } finally {
      this.isProcessingTasks = false;
      if (this.nextQueuedTask() && this.runningTaskCount < this.maxConcurrentTasks) {
        void this.processTasks();
      }
    }
  }

  private nextQueuedTask() {
    const now = Date.now();
    const priorityRank: Record<TaskPriority, number> = { high: 0, normal: 1, low: 2 };
    return this.taskOrder
      .map((id) => this.tasks.get(id))
      .filter((task): task is QueuedTask => {
        if (!task) return false;
        return task.status === "queued" && task.runAt <= now;
      })
      .sort((a, b) => priorityRank[a.priority] - priorityRank[b.priority] || a.createdAt - b.createdAt)[0];
  }

  private async runQueuedTask(task: QueuedTask) {
    this.runningTaskCount += 1;
    task.status = "running";
    task.startedAt = Date.now();
    task.updatedAt = task.startedAt;
    try {
      const result = await this.executeValidatedTool(task.toolName, task.arguments);
      task.result = result;
      task.updatedAt = Date.now();
      if (result.ok && result.requiresConfirmation) {
        task.status = "needs_confirmation";
        task.confirmationId = result.confirmationId;
        task.summary = result.summary;
        return;
      }
      task.status = result.ok ? "completed" : "failed";
      task.error = result.ok ? undefined : result.error;
      task.completedAt = task.updatedAt;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      task.status = "failed";
      task.error = message;
      task.result = { ok: false, name: task.toolName, error: message };
      task.updatedAt = Date.now();
      task.completedAt = task.updatedAt;
    } finally {
      this.runningTaskCount = Math.max(0, this.runningTaskCount - 1);
    }
  }

  private updateTaskForConfirmation(confirmationId: string, approved: boolean, confirmationResult: Awaited<ReturnType<ConfirmationQueue["decide"]>>) {
    const task = [...this.tasks.values()].find((item) => item.confirmationId === confirmationId);
    if (!task) return;

    task.updatedAt = Date.now();
    task.completedAt = task.updatedAt;
    if (!approved || confirmationResult.rejected) {
      task.status = "cancelled";
      task.error = confirmationResult.summary ?? "Confirmation rejected.";
      task.result = { ok: false, name: task.toolName, error: task.error, code: "confirmation_rejected" };
      return;
    }

    task.status = "completed";
    task.error = undefined;
    task.result = { ok: true, name: task.toolName, result: this.compactResult(task.toolName, confirmationResult.result) };
  }

  private taskQueueSummary() {
    const counts = {
      queued: 0,
      running: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
      needs_confirmation: 0,
    } satisfies Record<TaskStatus, number>;
    for (const task of this.tasks.values()) counts[task.status] += 1;
    return {
      counts,
      maxConcurrentTasks: this.maxConcurrentTasks,
      recentTaskIds: this.taskOrder.slice(0, 5),
    };
  }

  private toTaskView(task: QueuedTask, includeResult = true) {
    return {
      taskId: task.id,
      toolName: task.toolName,
      group: task.group,
      priority: task.priority,
      status: task.status,
      summary: task.summary,
      createdAt: new Date(task.createdAt).toISOString(),
      updatedAt: new Date(task.updatedAt).toISOString(),
      runAt: new Date(task.runAt).toISOString(),
      startedAt: task.startedAt ? new Date(task.startedAt).toISOString() : undefined,
      completedAt: task.completedAt ? new Date(task.completedAt).toISOString() : undefined,
      confirmationId: task.confirmationId,
      error: task.error,
      result: includeResult ? this.toTaskResultView(task.result) : undefined,
    };
  }

  private toTaskResultView(result: ToolCallResult | undefined) {
    if (!result) return undefined;
    if (!result.ok) return { ok: false, name: result.name, error: result.error, code: result.code };
    if (result.requiresConfirmation) {
      return {
        ok: true,
        name: result.name,
        requiresConfirmation: true,
        confirmationId: result.confirmationId,
        summary: result.summary,
        expiresAt: result.expiresAt,
      };
    }

    const payload = result.result;
    if (payload && typeof payload === "object" && "truncated" in payload && "handle" in payload) {
      const truncated = payload as {
        truncated?: unknown;
        handle?: unknown;
        originalChars?: unknown;
        inlineChars?: unknown;
        nextAction?: unknown;
      };
      return {
        ok: true,
        name: result.name,
        result: {
          truncated: Boolean(truncated.truncated),
          handle: typeof truncated.handle === "string" ? truncated.handle : undefined,
          originalChars: typeof truncated.originalChars === "number" ? truncated.originalChars : undefined,
          inlineChars: typeof truncated.inlineChars === "number" ? truncated.inlineChars : undefined,
          nextAction: typeof truncated.nextAction === "string" ? truncated.nextAction : undefined,
        },
      };
    }

    const serialized = stableSerialize(payload);
    if (serialized.length <= 1200) return result;
    return {
      ok: true,
      name: result.name,
      result: {
        truncated: true,
        originalChars: serialized.length,
        preview: serialized.slice(0, 1200),
        nextAction: "Result is large. Re-run with narrower arguments or use the returned handle when available.",
      },
    };
  }

  private pruneTasks() {
    while (this.taskOrder.length > this.maxTasks) {
      const id = this.taskOrder.pop();
      if (id) this.tasks.delete(id);
    }
  }

  private compactResult(name: ToolName, result: unknown) {
    this.pruneResultCache();
    const serialized = stableSerialize(result);
    if (serialized.length <= TOOL_OUTPUT_INLINE_LIMIT) return result;

    const handle = crypto.randomUUID();
    this.resultCache.set(handle, { value: serialized, createdAt: Date.now(), name });
    return {
      truncated: true,
      handle,
      originalChars: serialized.length,
      inlineChars: TOOL_OUTPUT_INLINE_LIMIT,
      preview: serialized.slice(0, TOOL_OUTPUT_INLINE_LIMIT),
      nextAction: "Use tool_result_read with this handle only if more detail is required.",
    };
  }

  private readCachedToolResult(handle: string, offset: number, maxChars: number) {
    this.pruneResultCache();
    const cached = this.resultCache.get(handle);
    if (!cached) {
      throw new Error(`Tool result handle is missing or expired: ${handle}`);
    }

    const safeOffset = Math.min(offset, cached.value.length);
    const end = Math.min(cached.value.length, safeOffset + maxChars);
    return {
      handle,
      sourceTool: cached.name,
      offset: safeOffset,
      chars: end - safeOffset,
      totalChars: cached.value.length,
      hasMore: end < cached.value.length,
      content: cached.value.slice(safeOffset, end),
      nextOffset: end < cached.value.length ? end : undefined,
    };
  }

  private pruneResultCache() {
    const cutoff = Date.now() - TOOL_RESULT_CACHE_TTL_MS;
    for (const [handle, item] of this.resultCache) {
      if (item.createdAt < cutoff) this.resultCache.delete(handle);
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
    this.updateTaskForConfirmation(id, approved, result);
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

const stableSerialize = (value: unknown) => {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

const compactJsonSchema = (schema: unknown) => {
  if (!schema || typeof schema !== "object") return { required: [], optional: [] };
  const value = schema as { properties?: Record<string, unknown>; required?: unknown };
  const keys = Object.keys(value.properties ?? {});
  const required = Array.isArray(value.required) ? value.required.filter((item): item is string => typeof item === "string") : [];
  const requiredSet = new Set(required);
  return {
    required,
    optional: keys.filter((key) => !requiredSet.has(key)),
  };
};

const truncateText = (value: string, maxChars: number) => {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars - 3)}...`;
};

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
