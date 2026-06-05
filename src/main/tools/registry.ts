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
import { PhoneControl, type PhoneCallMode } from "./phone-control";
import { ShortcutsControl } from "./shortcuts-control";
import { CapabilityGate } from "../capability-gate";
import { CodexAppServerHarness, type CodexProgressEvent, type CodexTaskInput } from "../codex/app-server-harness";
import { MemoryStore, type MemoryLookupInput, type MemorySaveInput, type MemoryType } from "../memory-store";

const limitSchema = z.number().int().min(1).max(10).optional().default(5);
const TOOL_OUTPUT_INLINE_LIMIT = 3500;
const REALTIME_TOOL_OUTPUT_INLINE_LIMIT = 1000;
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
  task_route: z.object({
    userRequest: z.string().min(1),
    preference: z.enum(["auto", "native", "search", "codex"]).optional().default("auto"),
    cwd: z.string().min(1).optional(),
    activeApp: z.string().min(1).optional(),
    selectedText: z.string().optional(),
  }),
  memory_lookup: z.object({
    query: z.string().min(1),
    types: z.array(z.enum(["path_alias", "preference", "task_template"])).optional(),
    limit: z.number().int().min(1).max(10).optional().default(5),
  }),
  memory_save: z.object({
    type: z.enum(["path_alias", "preference", "task_template"]),
    key: z.string().min(1),
    value: z.string().optional(),
    summary: z.string().optional(),
    content: z.string().optional(),
    aliases: z.array(z.string()).optional(),
    tags: z.array(z.string()).optional(),
  }),
  memory_forget: z.object({ idOrKey: z.string().min(1) }),
  memory_status: z.object({}),
  codex_task_run: z.object({
    prompt: z.string().min(1),
    cwd: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    sandbox: z.enum(["read_only", "workspace_write"]).optional().default("read_only"),
    timeoutMs: z.number().int().min(10000).max(1800000).optional().default(config.codexTurnTimeoutMs),
    memoryIds: z.array(z.string()).optional().default([]),
  }),
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
  music_playback_state: z.object({}),
  video_play: z.object({ service: z.enum(["youtube", "apple_tv"]), query: z.string().min(1) }),
  apple_tv_playback_state: z.object({}),
  shortcut_list: z.object({ limit: z.number().int().min(1).max(50).optional().default(20) }),
  shortcut_run: z.object({
    name: z.string().min(1),
    input: z.string().optional(),
    timeoutMs: z.number().int().min(1000).max(180000).optional().default(60000),
  }),
  contacts_search: z.object({ query: z.string().min(1), limit: z.number().int().min(1).max(10).optional().default(5) }),
  phone_call: z.object({
    phoneNumber: z.string().min(1),
    contactName: z.string().min(1).optional(),
    mode: z.enum(["phone", "facetime_audio", "facetime_video"]).optional().default("phone"),
  }),
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
  browser_search_open: z.object({
    query: z.string().min(1),
    engine: z.enum(["google", "bing", "duckduckgo"]).optional().default("google"),
    isolated: z.boolean().optional().default(true),
  }),
  browser_isolated_open_url: z.object({ url: z.string().url() }),
  browser_isolated_window_focus: z.object({}),
  browser_isolated_window_move_resize: z.object({
    x: z.number().int(),
    y: z.number().int(),
    width: z.number().int().min(120),
    height: z.number().int().min(120),
  }),
  browser_read_video_state: z.object({}),
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
type TaskRoutePreference = "auto" | "native" | "search" | "codex";
type BrowserSearchEngine = "google" | "bing" | "duckduckgo";
type TaskRouteInput = {
  userRequest: string;
  preference?: TaskRoutePreference;
  cwd?: string;
  activeApp?: string;
  selectedText?: string;
};
type RouteProvider = "native" | "phone" | "browser" | "search" | "codex";
type RouteStep = {
  provider: RouteProvider;
  status: "ready" | "not_implemented" | "needs_clarification";
  title: string;
  toolName?: ToolName;
  arguments?: Record<string, unknown>;
  priority?: TaskPriority;
  requiresConfirmation?: boolean;
  reason: string;
};
type TaskProgressEvent = Omit<CodexProgressEvent, "source"> & { source: "her" | "codex" };

type QueuedTask = {
  id: string;
  toolName: ToolName;
  arguments: Record<string, unknown>;
  group: ToolGroup;
  priority: TaskPriority;
  source: "realtime" | "local";
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
  attempts: number;
  nextBackoffMs?: number;
  progress: TaskProgressEvent[];
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
  private video = new VideoControl(this.browser);
  private phone = new PhoneControl();
  private shortcuts = new ShortcutsControl();
  private codex: CodexAppServerHarness;
  private memory: MemoryStore;
  private resultCache = new Map<string, { value: string; createdAt: number; name: ToolName }>();
  private tasks = new Map<string, QueuedTask>();
  private taskOrder: string[] = [];
  private enabledToolGroups = new Set<ToolGroup>(toolGroups);
  private runningTaskCount = 0;
  private isProcessingTasks = false;
  private taskCreateWindow: number[] = [];
  private lastTaskStartedAt = 0;
  private taskCooldownUntil = 0;
  private readonly maxConcurrentTasks = 1;
  private readonly maxTasks = 100;

  constructor(
    private confirmations: ConfirmationQueue,
    private audit: AuditLog,
    private gate?: CapabilityGate,
    private permissions?: PermissionManager,
    memory?: MemoryStore,
  ) {
    this.codex = new CodexAppServerHarness(audit);
    this.memory = memory ?? new MemoryStore();
  }

  async execute(request: ToolCallRequest): Promise<ToolCallResult> {
    const source = request.source === "realtime" ? "realtime" : "local";
    this.audit.write({
      action: `tool.${request.name}`,
      summary: `Received ${request.name} request from ${source}`,
      status: "started",
      details: {
        name: request.name,
        source,
        callId: request.callId,
        arguments: request.arguments,
      },
    });

    if (!(request.name in schemas)) {
      this.audit.write({
        action: `tool.${request.name}`,
        summary: `Unknown tool: ${request.name}`,
        status: "error",
        details: { name: request.name, source },
      });
      return { ok: false, name: request.name, error: `Unknown tool: ${request.name}`, code: "unknown_tool" };
    }

    const parsed = schemas[request.name].safeParse(request.arguments);
    if (!parsed.success) {
      this.audit.write({
        action: `tool.${request.name}`,
        summary: `Invalid arguments for ${request.name}`,
        status: "error",
        details: {
          name: request.name,
          source,
          issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
        },
      });
      return {
        ok: false,
        name: request.name,
        error: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "),
        code: "invalid_arguments",
      };
    }

    const args = parsed.data as Record<string, unknown>;
    if (this.isTaskControlTool(request.name)) {
      return this.executeTaskControlTool(request.name, args, source);
    }

    return this.executeToolWithTimeout(request.name, args, source);
  }

  private async executeToolWithTimeout(
    name: ToolName,
    args: Record<string, unknown>,
    source: "realtime" | "local",
  ): Promise<ToolCallResult> {
    if (name === "codex_task_run") return this.executeValidatedTool(name, args, source);
    try {
      return await withTimeout(
        this.executeValidatedTool(name, args, source),
        config.toolQueueTaskTimeoutMs,
        `${name} timed out after ${config.toolQueueTaskTimeoutMs}ms`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.audit.write({ action: name, summary: message, status: "error" });
      return { ok: false, name, error: message, code: "tool_timeout" };
    }
  }

  private async executeValidatedTool(
    name: ToolName,
    args: Record<string, unknown>,
    source: "realtime" | "local" = "local",
  ): Promise<ToolCallResult> {
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
      return { ok: true, name, result: this.compactResult(name, result, source) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.audit.write({ action: name, summary: message, status: "error" });
      return { ok: false, name, error: message };
    }
  }

  private async executeTaskControlTool(
    name: ToolName,
    args: Record<string, unknown>,
    source: "realtime" | "local",
  ): Promise<ToolCallResult> {
    try {
      const result = await this.runTaskControlTool(name, args, source);
      this.audit.write({ action: name, summary: this.summary(name, args), status: "ok" });
      return { ok: true, name, result: this.compactResult(name, result, source) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.audit.write({ action: name, summary: message, status: "error" });
      return { ok: false, name, error: message };
    }
  }

  private runTaskControlTool(name: ToolName, args: Record<string, unknown>, source: "realtime" | "local") {
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
          source,
        );
      case "task_status":
        return this.getTaskStatus(args.taskId as string, source);
      case "task_list":
        return this.listTasks(args.status as TaskStatus | undefined, args.limit as number, source);
      case "task_cancel":
        return this.cancelTask(args.taskId as string);
      case "task_route":
        return this.routeTask(args as TaskRouteInput);
      case "memory_lookup":
        return this.memory.lookup(args as MemoryLookupInput);
      case "memory_save":
        return this.memory.save(args as MemorySaveInput);
      case "memory_forget":
        return this.memory.forget(args.idOrKey as string);
      case "memory_status":
        return this.memory.status();
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
          mode: config.realtimeMode,
          voice: config.realtimeVoice,
          realtimeBudget: {
            maxOutputTokens: config.realtimeMaxOutputTokens,
            postInstructions: config.realtimePostInstructionsTokens,
            retentionRatio: config.realtimeRetentionRatio,
            transcriptionEnabled: config.realtimeTranscriptionEnabled,
            vadThreshold: config.realtimeVadThreshold,
          },
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
            phone: "macos-contacts-tel-facetime",
            browser: "isolated-chrome-profile",
            shell: "confirm-first-safe-subset",
            codex: config.codexEnabled ? "app-server-json-rpc-stdio" : "disabled",
            router: "deterministic-her-router-v1",
          },
          codex: {
            enabled: config.codexEnabled,
            command: config.codexCommand,
            args: config.codexArgs,
            model: config.codexModel || "app-server-default",
            timeoutMs: config.codexTurnTimeoutMs,
            nativeToolsFallback: config.codexNativeToolsFallback,
          },
          memory: this.memory.status(),
          toolGroups: this.listToolGroups(),
          taskQueue: this.taskQueueSummary(),
        };
      case "confirmation_list":
        return this.listConfirmations();
      case "confirmation_decide":
        return this.decideConfirmation(args.confirmationId as string | undefined, args.approved as boolean);
      case "tool_result_read":
        return this.readCachedToolResult(args.handle as string, args.offset as number, args.maxChars as number);
      case "codex_task_run":
        if (!config.codexEnabled) {
          throw new Error("Codex provider is disabled. HER will not fall back to another provider.");
        }
        return this.codex.runTask(this.enrichCodexTaskWithMemory(args as CodexTaskInput & { memoryIds?: string[] }));
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
      case "music_playback_state":
        return this.music.playbackState();
      case "video_play":
        return this.video.play(args.service as "youtube" | "apple_tv", args.query as string);
      case "apple_tv_playback_state":
        return this.video.appleTvPlaybackState();
      case "shortcut_list":
        return this.shortcuts.list(args.limit as number);
      case "shortcut_run":
        return this.shortcuts.runShortcut(args.name as string, args.input as string | undefined, args.timeoutMs as number);
      case "contacts_search":
        return this.phone.searchContacts(args.query as string, args.limit as number);
      case "phone_call":
        return this.phone.call(args.phoneNumber as string, args.mode as PhoneCallMode, args.contactName as string | undefined);
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
      case "browser_search_open":
        return this.openBrowserSearch(args.query as string, args.engine as BrowserSearchEngine, args.isolated as boolean);
      case "browser_isolated_open_url":
        return this.browser.openIsolatedUrl(args.url as string);
      case "browser_isolated_window_focus":
        return this.browser.focusIsolatedWindow();
      case "browser_isolated_window_move_resize":
        return this.browser.moveResizeIsolatedWindow(args.x as number, args.y as number, args.width as number, args.height as number);
      case "browser_read_video_state":
        return this.browser.readVideoState();
      case "browser_fill_form":
        return this.browser.fillForm(args.fields as Array<{ selector: string; value: string }>);
      case "browser_click":
        return this.browser.click(args.selector as string, args.purpose as string);
      case "advanced_shell_command":
        return this.shell.run(args.command as string, args.timeoutMs as number);
    }
  }

  private isTaskControlTool(name: ToolName) {
    return name === "tool_catalog_list" || name === "tool_group_set" || name === "task_create" || name === "task_status" || name === "task_list" || name === "task_cancel" || name === "task_route" || name === "memory_lookup" || name === "memory_save" || name === "memory_forget" || name === "memory_status";
  }

  private isQueueManagedToolName(name: string): name is ToolName {
    return Boolean(toolGroupLookup[name as ToolName]) && name in schemas;
  }

  private isToolAvailable(name: ToolName) {
    if (name === "codex_task_run") return config.codexEnabled;
    return true;
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
      .filter((definition) => this.isToolAvailable(definition.name))
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
      toolCount: allToolDefinitions
        .filter((definition) => toolGroupLookup[definition.name] === group)
        .filter((definition) => this.isToolAvailable(definition.name)).length,
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

  private routeTask(input: TaskRouteInput) {
    const request = input.userRequest.trim();
    const preference = input.preference ?? "auto";
    const memoryMatches = this.memory.lookup({
      query: request,
      types: ["path_alias", "preference", "task_template"],
      limit: 5,
    }).matches;
    const signals = classifyRouteSignals(request, preference);
    const plan = buildRoutePlan(request, input, signals, memoryMatches);
    const executablePlan = plan.map((step) => {
      if (!step.toolName || step.status !== "ready") return step;
      return {
        ...step,
        requiresConfirmation: toolsRequiringConfirmation.has(step.toolName),
        taskCreate: {
          toolName: step.toolName,
          arguments: step.arguments ?? {},
          priority: step.priority ?? "normal",
        },
      };
    });
    return {
      route: executablePlan.length > 1 ? "mixed" : (executablePlan[0]?.provider ?? "clarify"),
      confidence: signals.confidence,
      reason: signals.reason,
      preference,
      memoryUsed: memoryMatches.map((match) => ({
        id: match.id,
        type: match.type,
        key: match.key,
        summary: match.summary,
        score: match.score,
      })),
      plan: executablePlan,
      nextAction: nextRouteAction(executablePlan),
    };
  }

  private enrichCodexTaskWithMemory(input: CodexTaskInput & { memoryIds?: string[] }): CodexTaskInput {
    const memoryIds = input.memoryIds ?? [];
    const withToolNamespace = this.enrichCodexTaskWithToolNamespace(input);
    if (!memoryIds.length) return withToolNamespace;
    const memories = this.memory.resolveForProvider(memoryIds);
    const pathAlias = memories.find((item) => item.type === "path_alias" && item.value);
    const context = memories
      .filter((item) => item.type !== "path_alias")
      .map((item) => {
        const body = item.content ?? item.value ?? item.summary;
        return `## ${item.type}: ${item.key}\n${body.slice(0, 6000)}`;
      })
      .join("\n\n");
    const pathContext = memories
      .filter((item) => item.type === "path_alias")
      .map((item) => `- ${item.key}: ${item.value ?? item.summary}`)
      .join("\n");
    const memoryContext = [pathContext ? `Known paths:\n${pathContext}` : "", context].filter(Boolean).join("\n\n");
    return {
      ...withToolNamespace,
      cwd: withToolNamespace.cwd ?? pathAlias?.value ?? withToolNamespace.cwd,
      prompt: memoryContext ? `HER memory for this task:\n\n${memoryContext}\n\n${withToolNamespace.prompt}` : withToolNamespace.prompt,
    };
  }

  private enrichCodexTaskWithToolNamespace(input: CodexTaskInput): CodexTaskInput {
    return {
      ...input,
      prompt: `${this.codexToolNamespace(input.prompt)}\n\nUser task:\n${input.prompt}`,
    };
  }

  private codexToolNamespace(prompt: string) {
    const selectedGroups = selectCodexToolGroups(prompt);
    const detailedTools = allToolDefinitions
      .filter((definition) => {
        const group = toolGroupLookup[definition.name];
        if (!group || group === "agents") return false;
        return selectedGroups.has(group) && this.enabledToolGroups.has(group) && this.isToolAvailable(definition.name);
      })
      .slice(0, 24)
      .map((definition) => {
        const group = toolGroupLookup[definition.name];
        const args = compactJsonSchema(definition.parameters);
        return {
          name: definition.name,
          group,
          capability: truncateText(definition.description, 140),
          requiresConfirmation: toolsRequiringConfirmation.has(definition.name),
          args,
        };
      });
    const groups = toolGroups
      .filter((group) => group !== "agents")
      .map((group) => ({
        group,
        enabled: this.enabledToolGroups.has(group),
        detailed: selectedGroups.has(group),
        toolCount: allToolDefinitions
          .filter((definition) => toolGroupLookup[definition.name] === group)
          .filter((definition) => this.isToolAvailable(definition.name)).length,
      }));
    return `HER exposed tool namespace for Codex planning:
- Codex cannot call HER desktop/media/browser/phone tools directly in this turn.
- Use only the detailed tool names below for executable HER plan steps.
- If a needed tool group is not detailed, return status "needs_tool_group" with the group name; do not invent tool names.
- If no HER tool/provider exists, return status "needs_provider".
- Codex native fallback tools/MCP/plugins are ${config.codexNativeToolsFallback ? "allowed" : "disabled"} for missing HER providers. When allowed, use only tools already available inside the Codex runtime and label results as "codex_native_fallback"; if unavailable, report "fallback_unavailable".
- Booking, purchases, sending, deleting, calling, publishing, shell, shortcuts, file writes, and browser submit/click actions require confirmation.
- Return structured plans around HER tools when the task is orchestration; for pure repo/file/code work, complete the Codex task normally.

${JSON.stringify({ groups, detailedTools }, null, 2)}`;
  }

  private createTask(
    toolName: string,
    rawArguments: Record<string, unknown>,
    priority: TaskPriority,
    runAfterMs: number,
    source: "realtime" | "local",
  ) {
    this.assertTaskCreateRateLimit();
    if (!this.isQueueManagedToolName(toolName)) {
      throw new Error(`Tool is not queue-managed or does not exist: ${toolName}. Use tool_catalog_list first.`);
    }
    if (!this.isToolAvailable(toolName)) {
      throw new Error(`Tool is unavailable: ${toolName}. HER will not fall back to another provider.`);
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
      source,
      status: "queued",
      createdAt: now,
      updatedAt: now,
      runAt: now + runAfterMs,
      summary: this.summary(toolName, parsed.data as Record<string, unknown>),
      attempts: 0,
      nextBackoffMs: config.toolQueueBackoffBaseMs,
      progress: [],
    };
    this.tasks.set(task.id, task);
    this.taskOrder.unshift(task.id);
    this.audit.write({
      action: "task.queue",
      summary: `Queued ${toolName} task ${task.id}`,
      status: "queued",
      details: {
        taskId: task.id,
        toolName,
        group,
        priority,
        source,
        runAfterMs,
        summary: task.summary,
      },
    });
    this.pruneTasks();
    if (runAfterMs > 0) setTimeout(() => void this.processTasks(), runAfterMs);
    void this.processTasks();
    return {
      task: this.toTaskView(task, true, source === "realtime"),
      queue: this.taskQueueSummary(),
      nextAction: "Use task_status with taskId, or task_list to monitor recent work.",
    };
  }

  private getTaskStatus(taskId: string, source: "realtime" | "local") {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    return { task: this.toTaskView(task, true, source === "realtime"), queue: this.taskQueueSummary(source === "realtime") };
  }

  private listTasks(status: TaskStatus | undefined, limit: number, source: "realtime" | "local") {
    const tasks = this.taskOrder
      .map((id) => this.tasks.get(id))
      .filter((task): task is QueuedTask => Boolean(task))
      .filter((task) => !status || task.status === status)
      .slice(0, limit)
      .map((task) => this.toTaskView(task, false, source === "realtime"));

    return { tasks, queue: this.taskQueueSummary(source === "realtime") };
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
    this.addTaskProgress(task, "warning", "HER 已取消排队任务");
    this.audit.write({
      action: "task.cancel",
      summary: `Cancelled queued task ${task.id}`,
      status: "cancelled",
      details: { taskId: task.id, toolName: task.toolName, source: task.source },
    });
    return { task: this.toTaskView(task, false), cancelled: true };
  }

  private async processTasks() {
    if (this.isProcessingTasks) return;
    this.isProcessingTasks = true;
    try {
      while (this.runningTaskCount < this.maxConcurrentTasks) {
        const delayMs = this.taskStartDelayMs();
        if (delayMs > 0) {
          setTimeout(() => void this.processTasks(), delayMs);
          return;
        }
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
    task.attempts += 1;
    task.startedAt = Date.now();
    this.lastTaskStartedAt = task.startedAt;
    task.updatedAt = task.startedAt;
    this.addTaskProgress(task, "running", `HER 开始执行 ${task.toolName}`);
    this.audit.write({
      action: "task.run",
      summary: `Running ${task.toolName} task ${task.id}`,
      status: "running",
      details: {
        taskId: task.id,
        toolName: task.toolName,
        source: task.source,
        attempt: task.attempts,
      },
    });
    try {
      const result =
        task.toolName === "codex_task_run"
          ? await this.executeCodexQueuedTask(task)
          : await this.executeToolWithTimeout(task.toolName, task.arguments, task.source);
      task.result = result;
      task.updatedAt = Date.now();
      if (result.ok && result.requiresConfirmation) {
        task.status = "needs_confirmation";
        task.confirmationId = result.confirmationId;
        task.summary = result.summary;
        this.addTaskProgress(task, "warning", "HER 正在等待用户确认");
        this.audit.write({
          action: "task.confirmation",
          summary: `Task ${task.id} is waiting for confirmation ${result.confirmationId}`,
          status: "needs_confirmation",
          details: {
            taskId: task.id,
            toolName: task.toolName,
            confirmationId: result.confirmationId,
            source: task.source,
          },
        });
        return;
      }
      task.status = result.ok ? "completed" : "failed";
      task.error = result.ok ? undefined : result.error;
      if (!result.ok && this.shouldBackoffTask(task, result.error)) {
        this.requeueTaskAfterBackoff(task, result.error);
        return;
      }
      task.completedAt = task.updatedAt;
      this.addTaskProgress(task, result.ok ? "ok" : "error", result.ok ? "HER 已完成任务" : `HER 任务失败：${result.error}`);
      this.audit.write({
        action: "task.complete",
        summary: `${task.toolName} task ${task.id} ${task.status}`,
        status: result.ok ? "ok" : "error",
        details: {
          taskId: task.id,
          toolName: task.toolName,
          source: task.source,
          attempts: task.attempts,
          error: result.ok ? undefined : result.error,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (this.shouldBackoffTask(task, message)) {
        this.requeueTaskAfterBackoff(task, message);
        return;
      }
      task.status = "failed";
      task.error = message;
      task.result = { ok: false, name: task.toolName, error: message };
      task.updatedAt = Date.now();
      task.completedAt = task.updatedAt;
      this.addTaskProgress(task, "error", `HER 任务失败：${message}`);
      this.audit.write({
        action: "task.complete",
        summary: `${task.toolName} task ${task.id} failed: ${message}`,
        status: "error",
        details: {
          taskId: task.id,
          toolName: task.toolName,
          source: task.source,
          attempts: task.attempts,
          error: message,
        },
      });
    } finally {
      this.runningTaskCount = Math.max(0, this.runningTaskCount - 1);
    }
  }

  private addTaskProgress(task: QueuedTask, status: TaskProgressEvent["status"], summary: string, method?: string) {
    const last = task.progress.at(-1);
    if (last?.summary === summary && last.status === status) {
      last.at = new Date().toISOString();
      last.method = method ?? last.method;
      task.updatedAt = Date.now();
      return;
    }
    task.progress.push({
      at: new Date().toISOString(),
      source: method ? "codex" : "her",
      status,
      summary: truncateText(summary, 300),
      method,
    });
    if (task.progress.length > 30) task.progress.splice(0, task.progress.length - 30);
    task.updatedAt = Date.now();
  }

  private async executeCodexQueuedTask(task: QueuedTask): Promise<ToolCallResult> {
    if (!config.codexEnabled) {
      return {
        ok: false,
        name: task.toolName,
        error: "Codex provider is disabled. HER will not fall back to another provider.",
        code: "provider_disabled",
      };
    }
    if (this.gate) {
      try {
        await this.gate.assertToolAllowed(task.toolName, task.arguments);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, name: task.toolName, error: message, code: "capability_denied" };
      }
    }

    if (toolsRequiringConfirmation.has(task.toolName) && !this.isYoloMode()) {
      const summary = this.summary(task.toolName, task.arguments);
      const confirmation = this.confirmations.add({
        name: task.toolName,
        summary,
        run: async () => {
          const result = await this.codex.runTask({
            ...this.enrichCodexTaskWithMemory(task.arguments as CodexTaskInput & { memoryIds?: string[] }),
            onProgress: (event) => this.addTaskProgress(task, event.status, event.summary, event.method),
          });
          return this.compactResult(task.toolName, result, task.source);
        },
      });
      return {
        ok: true,
        name: task.toolName,
        requiresConfirmation: true,
        confirmationId: confirmation.id,
        summary,
        expiresAt: new Date(confirmation.expiresAt).toISOString(),
      };
    }

    try {
      const result = await this.codex.runTask({
        ...this.enrichCodexTaskWithMemory(task.arguments as CodexTaskInput & { memoryIds?: string[] }),
        onProgress: (event) => this.addTaskProgress(task, event.status, event.summary, event.method),
      });
      return { ok: true, name: task.toolName, result: this.compactResult(task.toolName, result, task.source) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, name: task.toolName, error: message };
    }
  }

  private assertTaskCreateRateLimit() {
    const now = Date.now();
    const cutoff = now - 60_000;
    this.taskCreateWindow = this.taskCreateWindow.filter((item) => item >= cutoff);
    if (this.taskCreateWindow.length >= config.toolQueueMaxCreatesPerMinute) {
      throw new Error(`Task create rate limit reached: ${config.toolQueueMaxCreatesPerMinute}/minute. Wait before queueing more work.`);
    }
    this.taskCreateWindow.push(now);
  }

  private taskStartDelayMs() {
    const now = Date.now();
    const cooldownDelay = Math.max(0, this.taskCooldownUntil - now);
    const spacingDelay = Math.max(0, this.lastTaskStartedAt + config.toolQueueMinStartIntervalMs - now);
    return Math.max(cooldownDelay, spacingDelay);
  }

  private shouldBackoffTask(task: QueuedTask, message: string) {
    return task.attempts < 2 && /rate limit|429|too many requests|empty response|timeout/i.test(message);
  }

  private requeueTaskAfterBackoff(task: QueuedTask, message: string) {
    const backoffMs = Math.min(task.nextBackoffMs ?? config.toolQueueBackoffBaseMs, config.toolQueueBackoffMaxMs);
    const jitterMs = Math.floor(Math.random() * Math.min(1000, backoffMs));
    const delayMs = backoffMs + jitterMs;
    const now = Date.now();
    task.status = "queued";
    task.error = message;
    task.updatedAt = now;
    task.runAt = now + delayMs;
    task.nextBackoffMs = Math.min(backoffMs * 2, config.toolQueueBackoffMaxMs);
    this.taskCooldownUntil = Math.max(this.taskCooldownUntil, task.runAt);
    this.addTaskProgress(task, "warning", `HER 因限流、空响应或超时重试：${message}`);
    this.audit.write({
      action: "task.backoff",
      summary: `Requeued ${task.toolName} task ${task.id} after ${delayMs}ms: ${message}`,
      status: "backoff",
      details: {
        taskId: task.id,
        toolName: task.toolName,
        source: task.source,
        attempts: task.attempts,
        delayMs,
        nextRunAt: new Date(task.runAt).toISOString(),
        error: message,
      },
    });
    setTimeout(() => void this.processTasks(), delayMs);
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
      this.addTaskProgress(task, "warning", "HER 任务已因确认被拒绝而取消");
      return;
    }

    task.status = "completed";
    task.error = undefined;
    task.result = { ok: true, name: task.toolName, result: this.compactResult(task.toolName, confirmationResult.result, task.source) };
    this.addTaskProgress(task, "ok", "HER 已完成确认后的任务");
  }

  private taskQueueSummary(compact = false) {
    const counts = {
      queued: 0,
      running: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
      needs_confirmation: 0,
    } satisfies Record<TaskStatus, number>;
    for (const task of this.tasks.values()) counts[task.status] += 1;
    const summary = {
      counts,
      maxConcurrentTasks: this.maxConcurrentTasks,
      cooldownUntil: this.taskCooldownUntil > Date.now() ? new Date(this.taskCooldownUntil).toISOString() : undefined,
      maxCreatesPerMinute: config.toolQueueMaxCreatesPerMinute,
      minStartIntervalMs: config.toolQueueMinStartIntervalMs,
      taskTimeoutMs: config.toolQueueTaskTimeoutMs,
      recentTaskIds: this.taskOrder.slice(0, 5),
    };
    if (!compact) return summary;
    return {
      counts,
      cooldownUntil: summary.cooldownUntil,
    };
  }

  private toTaskView(task: QueuedTask, includeResult = true, compact = false) {
    const view = {
      taskId: task.id,
      toolName: task.toolName,
      group: task.group,
      priority: task.priority,
      source: task.source,
      status: task.status,
      attempts: task.attempts,
      summary: compact ? truncateText(task.summary ?? "", 180) : task.summary,
      confirmationId: task.confirmationId,
      error: task.error,
      progress: task.progress.slice(compact ? -5 : -8).map((item) => ({
        ...item,
        summary: truncateText(item.summary, compact ? 160 : 220),
      })),
      result: includeResult ? this.toTaskResultView(task.result) : undefined,
    };
    if (compact) return view;
    return {
      ...view,
      createdAt: new Date(task.createdAt).toISOString(),
      updatedAt: new Date(task.updatedAt).toISOString(),
      runAt: new Date(task.runAt).toISOString(),
      startedAt: task.startedAt ? new Date(task.startedAt).toISOString() : undefined,
      completedAt: task.completedAt ? new Date(task.completedAt).toISOString() : undefined,
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

  private compactResult(name: ToolName, result: unknown, source: "realtime" | "local" = "local") {
    this.pruneResultCache();
    const serialized = stableSerialize(result);
    const inlineLimit = source === "realtime" ? REALTIME_TOOL_OUTPUT_INLINE_LIMIT : TOOL_OUTPUT_INLINE_LIMIT;
    if (serialized.length <= inlineLimit) return result;

    const handle = crypto.randomUUID();
    this.resultCache.set(handle, { value: serialized, createdAt: Date.now(), name });
    return {
      truncated: true,
      handle,
      originalChars: serialized.length,
      inlineChars: inlineLimit,
      preview: serialized.slice(0, inlineLimit),
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
      case "music_playback_state":
        return "Read Music playback state";
      case "video_play":
        return `Play ${args.service} video for ${args.query}`;
      case "apple_tv_playback_state":
        return "Read Apple TV playback state";
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
      case "browser_search_open":
        return `Open ${args.engine ?? "google"} search for ${truncateText(String(args.query ?? ""), 80)}`;
      case "browser_isolated_open_url":
        return `Open isolated browser URL ${args.url}`;
      case "browser_isolated_window_focus":
        return "Focus isolated Chrome window";
      case "browser_isolated_window_move_resize":
        return `Move isolated Chrome window to ${args.x},${args.y} ${args.width}x${args.height}`;
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
  }

  private async openUrl(rawUrl: string) {
    const url = new URL(rawUrl);
    if (!["http:", "https:"].includes(url.protocol)) {
      throw new Error(`URL protocol is not allowed: ${url.protocol}`);
    }
    await runCommand("open", [url.toString()]);
    return { opened: url.toString() };
  }

  private async openBrowserSearch(query: string, engine: BrowserSearchEngine, isolated: boolean) {
    const url = buildSearchUrl(query, engine);
    if (isolated) {
      await this.browser.openIsolatedUrl(url);
    } else {
      await this.openUrl(url);
    }
    return {
      opened: true,
      engine,
      query,
      url,
      isolated,
      note: "Opened search results page only. HER did not read or return search result content.",
    };
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

const withTimeout = <T>(promise: Promise<T>, timeoutMs: number, message: string) =>
  new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });

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

const buildSearchUrl = (query: string, engine: BrowserSearchEngine) => {
  const encoded = encodeURIComponent(query.trim());
  if (engine === "bing") return `https://www.bing.com/search?q=${encoded}`;
  if (engine === "duckduckgo") return `https://duckduckgo.com/?q=${encoded}`;
  return `https://www.google.com/search?q=${encoded}`;
};

const selectCodexToolGroups = (prompt: string) => {
  const groups = new Set<ToolGroup>();
  const add = (group: ToolGroup) => groups.add(group);
  if (/(文件|文件夹|目录|文档|资料|周报|月报|日报|docx?|pdf|xlsx?|pptx?|folder|file|directory|report)/i.test(prompt)) {
    add("files");
    add("documents");
  }
  if (/(邮件|日历|会议|提醒|文案|email|mail|calendar|meeting|copy|draft)/i.test(prompt)) add("text");
  if (/(音乐|歌曲|视频|电影|电视|快捷指令|播放|music|song|video|youtube|apple tv|shortcut)/i.test(prompt)) add("media");
  if (/(电话|拨打|facetime|call|contact)/i.test(prompt)) add("phone");
  if (/(浏览器|网页|搜索页|打开.*https?:|browser|chrome|url|web)/i.test(prompt)) add("browser");
  if (/(应用|打开|关闭|启动|聚焦|app|launch|focus|quit)/i.test(prompt)) add("apps");
  if (/(窗口|排列|平铺|最小化|最大化|window|layout)/i.test(prompt)) add("windows");
  if (/(音量|亮度|深色|系统设置|剪贴板|volume|brightness|settings|clipboard)/i.test(prompt)) add("system");
  if (/(权限|授权|yolo|permission|capability)/i.test(prompt)) add("permissions");
  if (/(shell|命令|终端|terminal|command)/i.test(prompt)) add("shell");
  if (groups.size === 0) {
    add("files");
    add("text");
    add("browser");
  }
  return groups;
};

const classifyRouteSignals = (request: string, preference: TaskRoutePreference) => {
  const normalized = request.toLowerCase();
  const externalDocumentation = /(官方文档|api\s*文档|docs?|documentation|reference)/i.test(request);
  const localDocument = !externalDocumentation && /(本地|文件夹|文件|目录|周报|月报|日报|文档|资料夹|folder|file|directory|docx?|pdf|xlsx?|pptx?)/i.test(request);
  const browserSearch = /(打开.*(浏览器)?.*(搜索|搜)|浏览器.*(搜索|搜)|搜索页|搜索结果页|用.*(google|谷歌|bing|必应|duckduckgo).*(搜索|搜)|open.*search)/i.test(request);
  const externalSearch = /(搜索.*网页|查.*官方文档|查.*最新|查.*新闻|查.*价格|找.*资料|来源|联网|网页|web|internet|search|look up|browse|verify|docs?|documentation|reference)/i.test(request);
  const phone = /(打电话|拨打|呼叫|电话给|facetime|face time|call\s+)/i.test(request);
  const browser = preference === "native" ? false : browserSearch;
  const search = preference === "search" || (!browser && !localDocument && externalSearch);
  const codex =
    preference === "codex" ||
    localDocument && /(写|生成|整理|总结|汇总|分析|归纳|月报|报告|草稿|提炼|write|summari[sz]e|report|analy[sz]e)/i.test(request) ||
    /(代码|项目|仓库|测试|修复|实现|重构|构建|编译|提交|推送|改.*项目|改.*代码|bug|repo|repository|test|fix|implement|refactor|build|commit|push|review)/i.test(request);
  const native =
    preference === "native" ||
    (!browser && (
      /(打开|启动|关闭|聚焦|切到|播放|暂停|音量|亮度|深色|窗口|最小化|最大化|排列|平铺|复制到剪贴板|\bopen\b|\blaunch\b|\bclose\b|\bfocus\b|\bplay\b|\bvolume\b|\bbrightness\b|\bwindow\b)/i.test(request) ||
      /https?:\/\//i.test(normalized)
    ));

  if (preference !== "auto") {
    return { phone: false, browser: false, search: preference === "search", codex: preference === "codex", native: preference === "native", confidence: 0.95, reason: `Preference forced route to ${preference}.` };
  }
  const hits = [phone, browser, search, codex, native].filter(Boolean).length;
  return {
    phone,
    browser,
    search,
    codex,
    native,
    confidence: hits === 0 ? 0.35 : hits === 1 ? 0.86 : 0.74,
    reason: hits === 0 ? "No strong route signal; ask a short clarification or inspect tool catalog." : "Matched deterministic HER routing rules.",
  };
};

const buildRoutePlan = (
  request: string,
  input: TaskRouteInput,
  signals: ReturnType<typeof classifyRouteSignals>,
  memoryMatches: Array<{ id: string; type: MemoryType; key: string; value?: string; summary: string }>,
): RouteStep[] => {
  const plan: RouteStep[] = [];
  if (signals.phone) plan.push(buildPhoneRouteStep(request));
  if (signals.native) plan.push(buildNativeRouteStep(request, input));
  if (signals.browser) plan.push(buildBrowserSearchRouteStep(request));
  if (signals.search) plan.push(buildSearchRouteStep(request));
  if (signals.codex) plan.push(buildCodexRouteStep(request, input, signals.search, memoryMatches));
  return plan.length ? plan : [{
    provider: "native",
    status: "needs_clarification",
    title: "Clarify HER task route",
    reason: "The request does not clearly map to a native, search, or Codex task.",
  }];
};

const buildBrowserSearchRouteStep = (request: string): RouteStep => {
  const engine = inferSearchEngine(request);
  const query = extractBrowserSearchQuery(request);
  const isolated = shouldUseIsolatedBrowser(request);
  return readyRouteStep(
    "browser",
    isolated ? `Open isolated ${engine} search` : `Open ${engine} search in normal browser`,
    "browser_search_open",
    { query, engine, isolated },
    isolated
      ? "Search and low-risk browsing default to HER's isolated Chrome so HER can take over safely without polluting the user's normal browser."
      : "The request asks for existing login state, cookies, extensions, or the normal browser, so HER should open the search in the default browser.",
  );
};

const buildPhoneRouteStep = (request: string): RouteStep => {
  const phoneNumber = extractPhoneNumber(request);
  const contactName = phoneNumber ? undefined : extractCallContactName(request);
  if (phoneNumber) {
    const mode = inferPhoneCallMode(request);
    return readyRouteStep(
      "phone",
      "Start phone call",
      "phone_call",
      { phoneNumber, ...(contactName ? { contactName } : {}), mode },
      "Calling is a HER phone task and requires confirmation.",
      "high",
    );
  }
  if (contactName) {
    const mode = inferPhoneCallMode(request);
    return readyRouteStep(
      "phone",
      mode === "phone" ? `Search contact ${contactName}` : `Search contact ${contactName} for ${mode}`,
      "contacts_search",
      { query: contactName, limit: 5 },
      "HER must resolve the contact before starting a call.",
      "high",
    );
  }
  return {
    provider: "phone",
    status: "needs_clarification",
    title: "Phone call needs a contact or number",
    reason: "The request asks to call someone, but HER could not infer the contact name or phone number.",
  };
};

const buildNativeRouteStep = (request: string, input: TaskRouteInput): RouteStep => {
  const url = extractUrl(request);
  if (url) {
    if (isAppleTvRequest(request) || isAppleTvUrl(url)) {
      return readyRouteStep(
        "native",
        "Open Apple TV URL",
        "video_play",
        { service: "apple_tv", query: url },
        "Apple TV URLs should be handed directly to the macOS TV app with open -a TV.",
      );
    }
    const isolated = shouldUseIsolatedBrowser(request);
    return isolated
      ? readyRouteStep("browser", "Open URL in isolated Chrome", "browser_isolated_open_url", { url }, "Low-risk browsing defaults to HER's isolated Chrome for cleaner automation and lower risk.")
      : readyRouteStep("browser", "Open URL in normal browser", "browser_open_url", { url }, "The request asks for existing login state, cookies, extensions, or the normal browser.");
  }

  if (isAppleTvRequest(request) && /(搜索|搜|找|播放|看|打开.*(剧|电影|节目|show|movie|episode)|watch|play|search|find)/i.test(request) && !isOnlyOpeningAppleTvApp(request)) {
    const query = extractAppleTvQuery(request);
    return readyRouteStep(
      "native",
      `Open Apple TV for ${query}`,
      "video_play",
      { service: "apple_tv", query },
      "Apple TV content requests should open the search or catalog URL directly in the macOS TV app.",
    );
  }

  if (isOnlyOpeningMusicApp(request)) {
    return readyRouteStep("native", "Open Music", "app_open", { appName: "Music" }, "Opening Music is a direct HER native task.");
  }
  if (isMusicPlaybackRequest(request)) {
    return readyRouteStep(
      "native",
      "Play music",
      "music_play_song",
      { query: extractMusicQuery(request) },
      "Music playback should use HER's Music tool instead of generic app or browser control.",
    );
  }

  const appName = extractKnownAppName(request) ?? input.activeApp;
  if (/(打开|启动|open|launch)/i.test(request) && appName) {
    return readyRouteStep("native", `Open ${appName}`, "app_open", { appName }, "Opening apps is a direct HER native task.");
  }
  if (/(关闭|退出|quit|close)/i.test(request) && appName) {
    return readyRouteStep("native", `Close ${appName}`, "app_quit", { appName }, "Closing apps is a direct HER native task.");
  }
  if (/(聚焦|切到|focus|switch)/i.test(request) && appName) {
    return readyRouteStep("native", `Focus ${appName}`, "app_focus", { appName }, "Focusing apps is a direct HER native task.");
  }

  const volume = extractPercent(request);
  if (/(音量|volume)/i.test(request) && typeof volume === "number") {
    return readyRouteStep("native", `Set volume to ${volume}`, "system_set_volume", { level: volume }, "Volume control is a direct HER system task.");
  }
  if (/(亮度|brightness)/i.test(request) && typeof volume === "number") {
    return readyRouteStep("native", `Set brightness to ${volume}`, "system_set_brightness", { level: volume }, "Brightness control is a direct HER system task.");
  }
  if (/(排列|平铺|整理|布局).*(窗口|windows?)/i.test(request)) {
    return readyRouteStep("native", "Arrange windows", "window_auto_arrange", { appNames: [] }, "Window layout is a direct HER window task.");
  }
  if (/(最小化|隐藏).*(其他|无关|unrelated|other)/i.test(request)) {
    return readyRouteStep("native", "Minimize unrelated windows", "window_minimize_unrelated", { keepAppNames: [], keepTitleKeywords: [], preserveFrontmost: true }, "Window cleanup is a direct HER window task.");
  }

  return {
    provider: "native",
    status: "needs_clarification",
    title: "Native HER task needs a specific tool",
    reason: "The request sounds like desktop control, but v1 router could not infer exact tool arguments.",
  };
};

const extractUrl = (request: string) => {
  const rawUrl = request.match(/https?:\/\/[^\s，。！？、；]+/i)?.[0];
  if (!rawUrl) return undefined;
  return rawUrl.replace(/[，。！？、；;,.!?]+$/u, "");
};

const isAppleTvUrl = (url: string) => {
  try {
    const parsed = new URL(url);
    return parsed.hostname === "tv.apple.com" || parsed.hostname.endsWith(".tv.apple.com");
  } catch {
    return false;
  }
};

const isAppleTvRequest = (request: string) => /(apple\s*tv|苹果\s*tv|苹果电视|\bTV\s*app\b|电视\s*app)/i.test(request);

const isOnlyOpeningAppleTvApp = (request: string) =>
  /^(请|麻烦|帮我|帮忙|please)?\s*(打开|启动|open|launch)\s*(apple\s*tv|苹果\s*tv|苹果电视|tv\s*app|电视\s*app)\s*$/i.test(request.trim());

const extractAppleTvQuery = (request: string) => {
  const stripped = request
    .replace(/^(请|麻烦|帮我|帮忙|please)\s*/i, "")
    .replace(/(在|用|打开)?\s*(apple\s*tv|苹果\s*tv|苹果电视|tv\s*app|电视\s*app)\s*(上|里|中)?/gi, "")
    .replace(/(搜索|搜一下|搜|找|播放|观看|看|打开|watch|play|search|find|open)\s*/gi, "")
    .replace(/(这个|一下|剧集|剧|电影|节目|show|movie|episode)/gi, "")
    .replace(/^(的|上|里|中)\s*/u, "")
    .trim();
  return stripped || request.trim();
};

const isOnlyOpeningMusicApp = (request: string) =>
  /^(请|麻烦|帮我|帮忙|please)?\s*(打开|启动|open|launch)\s*(音乐|music|music\s*app|apple\s*music)\s*$/i.test(request.trim());

const isMusicPlaybackRequest = (request: string) =>
  (/(播放|放一下|放|听|听一下|play)\s*.+/i.test(request) || /(打开|open)\s*.+(音乐|歌曲|歌|曲|playlist|song)/i.test(request)) &&
  !isAppleTvRequest(request) &&
  !/(视频|电影|剧|节目|youtube|apple\s*tv|苹果\s*tv|tv\s*app|watch|movie|show|episode)/i.test(request);

const extractMusicQuery = (request: string) => {
  const stripped = request
    .replace(/^(请|麻烦|帮我|帮忙|please)\s*/i, "")
    .replace(/(用|在)?\s*(apple\s*music|music\s*app|music|音乐)\s*(里|上)?/gi, "")
    .replace(/(播放|放一下|放|听一下|听|打开|open|play)\s*/gi, "")
    .trim();
  return stripped || request.trim();
};

const inferSearchEngine = (request: string): BrowserSearchEngine => {
  if (/(bing|必应)/i.test(request)) return "bing";
  if (/duckduckgo/i.test(request)) return "duckduckgo";
  return "google";
};

const shouldUseIsolatedBrowser = (request: string) => {
  if (/(普通浏览器|默认浏览器|主浏览器|正常浏览器|已有登录|已登录|登录态|cookie|cookies|扩展|插件|extension|extensions|profile|session|normal browser|default browser|main browser|logged in|login state)/i.test(request)) {
    return false;
  }
  return true;
};

const extractBrowserSearchQuery = (request: string) => {
  const stripped = request
    .replace(/^(请|麻烦|帮我|帮忙|please)\s*/i, "")
    .replace(/(打开)?\s*(浏览器|browser)\s*(搜索|搜一下|搜|search)\s*/gi, "")
    .replace(/(用|在)?\s*(google|谷歌|bing|必应|duckduckgo)\s*(搜索|搜一下|搜|search)?\s*/gi, "")
    .replace(/(搜索页|搜索结果页|search results page)/gi, "")
    .replace(/(搜索|搜一下|搜|search)\s*/gi, "")
    .trim();
  return stripped || request.trim();
};

const buildSearchRouteStep = (request: string): RouteStep => ({
  provider: "search",
  status: "not_implemented",
  title: "HER web search",
  reason: "The request needs external information, but HER web_search_provider is not implemented yet.",
  arguments: { query: request },
});

const buildCodexRouteStep = (
  request: string,
  input: TaskRouteInput,
  includeSearchContext: boolean,
  memoryMatches: Array<{ id: string; type: MemoryType; key: string; value?: string; summary: string }>,
): RouteStep => {
  if (!config.codexEnabled) {
    return {
      provider: "codex",
      status: "not_implemented",
      title: "Codex background runtime unavailable",
      reason: "HER Codex provider is disabled. HER will not fall back to another provider or pretend the task ran.",
      arguments: { prompt: request },
    };
  }
  const prompt = includeSearchContext
    ? `Use the HER-provided search summary when available, then complete this task:\n\n${request}`
    : request;
  const pathAlias = memoryMatches.find((item) => item.type === "path_alias" && item.value);
  const memoryIds = memoryMatches.map((item) => item.id);
  return readyRouteStep(
    "codex",
    "Run Codex background task",
    "codex_task_run",
    {
      prompt,
      ...(input.cwd || pathAlias?.value ? { cwd: input.cwd ?? pathAlias?.value } : {}),
      sandbox: /修改|修复|实现|重构|写入|写|生成|创建|保存|输出|草稿|改|fix|implement|refactor|edit|write|create|save|draft/i.test(request) ? "workspace_write" : "read_only",
      ...(memoryIds.length ? { memoryIds } : {}),
    },
    "Complex project, code, test, or multi-step analysis should run through HER's Codex runtime.",
    "high",
  );
};

const readyRouteStep = (
  provider: RouteProvider,
  title: string,
  toolName: ToolName,
  args: Record<string, unknown>,
  reason: string,
  priority: TaskPriority = "normal",
): RouteStep => ({
  provider,
  status: "ready",
  title,
  toolName,
  arguments: args,
  priority,
  reason,
});

const nextRouteAction = (plan: RouteStep[]) => {
  const firstReady = plan.find((step) => step.status === "ready" && step.toolName);
  if (firstReady?.toolName) return `Call task_create with toolName=${firstReady.toolName} and the provided arguments.`;
  const missingSearch = plan.find((step) => step.provider === "search" && step.status === "not_implemented");
  if (missingSearch) {
    return config.codexEnabled
      ? "HER web_search_provider is not implemented yet; answer from existing context or route follow-up project work to codex_task_run."
      : "HER web_search_provider is not implemented and Codex is unavailable; do not fall back silently.";
  }
  const missingCodex = plan.find((step) => step.provider === "codex" && step.status === "not_implemented");
  if (missingCodex) return "HER Codex provider is unavailable; do not fall back silently. Tell the user this task needs Codex or ask for a smaller direct action.";
  return "Ask one short clarification before queueing work.";
};

const extractKnownAppName = (request: string) => {
  const knownApps = ["Google Chrome", "Chrome", "Safari", "Music", "Mail", "Calendar", "Notes", "Finder", "Terminal", "TV"];
  return knownApps.find((name) => new RegExp(`\\b${escapeRegExp(name)}\\b`, "i").test(request));
};

const extractPercent = (request: string) => {
  const match = request.match(/(\d{1,3})\s*%?/);
  if (!match) return undefined;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return undefined;
  return Math.min(100, Math.max(0, value));
};

const extractPhoneNumber = (request: string) => {
  const match = request.match(/(\+?\d[\d\s().-]{5,}\d)/);
  return match?.[1]?.trim();
};

const inferPhoneCallMode = (request: string): PhoneCallMode => {
  if (/(视频\s*facetime|facetime\s*视频|facetime\s*video|video\s*facetime|视频通话)/i.test(request)) return "facetime_video";
  if (/(facetime|face time)/i.test(request)) return "facetime_audio";
  return "phone";
};

const extractCallContactName = (request: string) => {
  const patterns = [
    /给(.+?)(?:打电话|拨电话|电话)/,
    /(?:呼叫|拨打)(.+)/,
    /call\s+(.+)/i,
    /facetime(?:\s+audio)?\s+(.+)/i,
  ];
  for (const pattern of patterns) {
    const match = request.match(pattern);
    const value = match?.[1]?.trim();
    if (value) return value.replace(/[，。,.!?！？].*$/, "").trim();
  }
  return undefined;
};

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

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
