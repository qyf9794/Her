import { spawn } from "node:child_process";
import { config } from "../config";
import { AuditLog } from "../audit";
import type { ToolCallRequest, ToolCallResult } from "../../shared/tools";
import { toolGroups, type ToolGroup, type ToolName } from "./metadata";
import type { CapabilityKey, CapabilitySettings, InstalledApp, UserSettings } from "../../shared/app-settings";
import { ConfirmationQueue } from "./confirmation";
import { ApprovalPolicy, type ActionPlan } from "../policy/approval-policy";
import { attachToolHandlers, toolManifest, toolRequiresConfirmation } from "./manifest";
import { createToolHandlers } from "./handlers";
import { summarizeToolCall } from "./summaries";
import { LocalStore } from "./local-store";
import { FileManager } from "./file-manager";
import { DocumentAssistant } from "./document-assistant";
import { SystemControl } from "./system-control";
import { BrowserAutomation } from "./browser-automation";
import { AdvancedShell } from "./advanced-shell";
import { MusicControl } from "./music-control";
import { VideoControl } from "./video-control";
import { SocialControl } from "./social-control";
import { NewsFinanceControl } from "./news-finance";
import { PhoneControl, type PhoneCallMode } from "./phone-control";
import { ShortcutsControl } from "./shortcuts-control";
import { WeatherLookup } from "./weather";
import { MacProductivity, type MacCalendarCreateInput, type MacNoteCreateInput, type MacReminderCreateInput } from "./mac-productivity";
import { MacMail } from "./mac-mail";
import { CapabilityGate } from "../capability-gate";
import { CodexAppServerHarness, type CodexProgressEvent, type CodexTaskInput } from "../codex/app-server-harness";
import { CodingAgentRuntime } from "../agents/coding-agent/runtime";
import { getUpdateStatus } from "../updates";
import { MemoryStore, type MemoryLookupInput, type MemorySaveInput, type MemoryType } from "../memory-store";
import { selectToolBundles } from "../agent/tool-bundle-router";
import { classifyTaskExecution } from "../tasks/task-classifier";
import { TaskQueue } from "../tasks/task-queue";
import { TaskStore } from "../tasks/task-store";
import type { HerTaskStatus, HerTaskView } from "../../shared/tasks";

const TOOL_OUTPUT_INLINE_LIMIT = 3500;
const REALTIME_TOOL_OUTPUT_INLINE_LIMIT = 1000;
const TOOL_RESULT_CACHE_TTL_MS = 10 * 60 * 1000;

const isManifestToolName = (name: string): name is ToolName =>
  Object.prototype.hasOwnProperty.call(toolManifest, name);

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
type IntentComplexity = "simple" | "complex" | "ambiguous";
type IntentDomain =
  | "desktop"
  | "apps"
  | "windows"
  | "system"
  | "media"
  | "social"
  | "calendar"
  | "reminder"
  | "notes"
  | "weather"
  | "travel"
  | "browser"
  | "files"
  | "documents"
  | "email"
  | "coding"
  | "research"
  | "phone"
  | "memory"
  | "unknown";
type IntentRoutePreference = "auto" | "direct" | "codex" | "clarify";
type TaskRouteInput = {
  userRequest: string;
  preference?: TaskRoutePreference;
  cwd?: string;
  activeApp?: string;
  selectedText?: string;
};
type StandardIntent = {
  originalText: string;
  intent: string;
  complexity: IntentComplexity;
  domain: IntentDomain;
  action?: string;
  entities?: Record<string, unknown>;
  toolName?: string;
  toolArguments?: Record<string, unknown>;
  candidateTools?: string[];
  missingInfo?: string[];
  confidence: number;
  routePreference?: IntentRoutePreference;
};
type IntentRouteInput = {
  intent: StandardIntent;
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

const toolGroupLookup = Object.fromEntries(
  Object.values(toolManifest)
    .filter((entry) => Boolean(entry.group))
    .map((entry) => [entry.name, entry.group]),
) as Partial<Record<ToolName, ToolGroup>>;
const approvalPolicy = new ApprovalPolicy();

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
  private social = new SocialControl(this.browser);
  private newsFinance = new NewsFinanceControl();
  private phone = new PhoneControl();
  private shortcuts = new ShortcutsControl();
  private weather = new WeatherLookup();
  private macProductivity = new MacProductivity();
  private macMail = new MacMail();
  private codex: CodexAppServerHarness;
  private codingAgent: CodingAgentRuntime;
  private herTasks: TaskStore;
  private herTaskQueue: TaskQueue;
  private memory: MemoryStore;
  private confirmationTaskIds = new Map<string, string>();
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
    codingAgent?: CodingAgentRuntime,
    taskStore?: TaskStore,
    taskQueue?: TaskQueue,
  ) {
    this.codex = new CodexAppServerHarness(audit);
    this.codingAgent = codingAgent ?? new CodingAgentRuntime();
    this.herTasks = taskStore ?? new TaskStore();
    this.herTaskQueue = taskQueue ?? new TaskQueue(this.herTasks);
    this.memory = memory ?? new MemoryStore();
    this.bindManifestRuntime();
  }

  async execute(request: ToolCallRequest): Promise<ToolCallResult> {
    const name = request.name;
    const source = request.source === "realtime" ? "realtime" : "local";
    this.audit.write({
      action: `tool.${name}`,
      summary: `Received ${name} request from ${source}`,
      status: "started",
      details: {
        name,
        source,
        callId: request.callId,
        arguments: request.arguments,
      },
    });

    if (!isManifestToolName(name)) {
      this.audit.write({
        action: `tool.${name}`,
        summary: `Unknown tool: ${name}`,
        status: "error",
        details: { name, source },
      });
      return { ok: false, name, error: `Unknown tool: ${name}`, code: "unknown_tool" };
    }

    const schema = toolManifest[name].schema;
    const parsed = schema.safeParse(request.arguments);
    if (!parsed.success) {
      this.audit.write({
        action: `tool.${name}`,
        summary: `Invalid arguments for ${name}`,
        status: "error",
        details: {
          name,
          source,
          issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
        },
      });
      return {
        ok: false,
        name,
        error: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "),
        code: "invalid_arguments",
      };
    }

    const args = parsed.data as Record<string, unknown>;
    if (this.isTaskControlTool(name)) {
      return this.executeTaskControlTool(name, args, source);
    }
    const taskExecution = classifyTaskExecution(name, args);
    if (taskExecution.managed) {
      return this.enqueueManagedToolTask(name, args, source, taskExecution.resourceLocks);
    }

    return this.executeToolWithTimeout(name, args, source);
  }

  private enqueueManagedToolTask(
    name: ToolName,
    args: Record<string, unknown>,
    source: "realtime" | "local",
    resourceLocks: string[],
  ): ToolCallResult {
    const summary = this.summarize(name, args);
    const task = this.herTaskQueue.enqueue({
      title: titleForTask(name),
      summary,
      toolName: name,
      arguments: args,
      priority: toolRequiresConfirmation(name) ? "high" : "normal",
      resourceLocks,
      execute: async (taskId) => {
        const result = await this.executeToolWithTimeout(name, args, source);
        if (result.ok && result.requiresConfirmation) {
          this.confirmationTaskIds.set(result.confirmationId, taskId);
          return {
            awaitingConfirmation: true,
            confirmationId: result.confirmationId,
            summary: result.summary,
          };
        }
        if (!result.ok) throw new Error(result.error);
        return result.result;
      },
    });
    return {
      ok: true,
      name,
      result: {
        task,
        mode: "task_runtime",
        locks: resourceLocks,
        nextAction: "Use task_status, task_list, or the Task Panel to monitor this task.",
      },
    };
  }

  private async executeToolWithTimeout(
    name: ToolName,
    args: Record<string, unknown>,
    source: "realtime" | "local",
  ): Promise<ToolCallResult> {
    if (name === "codex_task_run" || name === "confirmation_decide") {
      return this.executeValidatedTool(name, args, source);
    }
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
    const run = () => this.executeManifestHandler(name, args, source);
    let summary = this.summarize(name, args);
    let preview: unknown;

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
        const editPreview = await this.documents.prepareEdit(args.path as string, args.newContent as string);
        summary = `Edit document ${editPreview.path}\nDiff preview:\n${editPreview.diffPreview}`;
        preview = { path: editPreview.path, diffPreview: editPreview.diffPreview };
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

    const approval = approvalPolicy.decide({
      toolName: name,
      args,
      summary,
      preview,
      yoloMode: this.isYoloMode(),
    });
    if (approval.type === "deny") {
      this.audit.write({ action: name, summary: approval.reason, status: "error" });
      return { ok: false, name, error: approval.reason, code: approval.code };
    }
    if (approval.type === "require_confirmation") {
      const confirmation = this.confirmations.add(approval.plan);
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
      this.audit.write({ action: name, summary: this.summarize(name, args), status: "ok" });
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
      case "her_select_bundle":
        return selectToolBundles(String(args.transcript ?? ""));
      case "task_create":
        return this.createTask(
          args.toolName as string,
          args.arguments as Record<string, unknown>,
          args.priority as TaskPriority,
          args.runAfterMs as number,
          source,
        );
      case "task_status":
        return this.getUnifiedTaskStatus(args.taskId as string, source);
      case "task_list":
        return this.listUnifiedTasks(args.status as TaskStatus | HerTaskStatus | undefined, args.limit as number, source);
      case "task_cancel":
        return this.cancelUnifiedTask(args.taskId as string);
      case "task_route":
        return this.routeTask(args as TaskRouteInput);
      case "intent_route":
        return source === "realtime" ? this.routeIntentForRealtime(args as IntentRouteInput) : this.routeIntent(args as IntentRouteInput);
      case "coding_agent_status":
        return this.codingAgent.status(args.taskId as string);
      case "coding_agent_cancel":
        return this.codingAgent.cancel(args.taskId as string);
      case "coding_agent_get_result":
        return this.codingAgent.result(args.taskId as string);
      case "task_events":
        return { taskId: args.taskId, events: this.herTasks.listEvents(args.taskId as string, args.limit as number) };
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
    const decision = await this.confirmations.decide(confirmationId, approved);
    const herTaskId = this.confirmationTaskIds.get(confirmationId);
    let execution: unknown;
    if (!decision.rejected) {
      try {
        execution = await this.executeActionPlan(decision.plan);
        if (herTaskId) {
          const codingTaskId = decision.plan.toolName === "coding_agent_start" ? extractCodingAgentTaskId(execution) : undefined;
          if (codingTaskId) {
            void this.completeHerTaskAfterCodingAgent(herTaskId, codingTaskId);
          } else {
            this.herTaskQueue.completeAwaitingConfirmation(herTaskId, execution);
          }
        }
      } catch (error) {
        if (herTaskId) this.herTaskQueue.failAwaitingConfirmation(herTaskId, error instanceof Error ? error : String(error));
        throw error;
      }
    } else if (herTaskId) {
      this.herTaskQueue.cancel(herTaskId, "Confirmation rejected.");
    }
    this.confirmationTaskIds.delete(confirmationId);
    const result = decision.rejected ? decision : { ...decision, result: execution };
    this.updateTaskForConfirmation(confirmationId, approved, result);
    const summary = decision.rejected ? (decision.summary ?? `Rejected ${confirmationId}`) : `Approved ${confirmationId}`;
    this.audit.write({
      action: "confirmation",
      summary,
      status: decision.rejected ? "rejected" : "ok",
    });
    if (decision.rejected) return decision;
    return { ...decision, result: this.compactResult("confirmation_decide", execution) };
  }

  private async executeActionPlan(plan: ActionPlan): Promise<unknown> {
    const result: unknown = await this.executeManifestHandler(plan.toolName, plan.args, "local");
    return this.compactResult(plan.toolName, result);
  }

  private async completeHerTaskAfterCodingAgent(herTaskId: string, codingTaskId: string) {
    try {
      const task = await this.codingAgent.waitForTerminal(codingTaskId);
      if (task.status === "completed") {
        this.herTaskQueue.completeAwaitingConfirmation(herTaskId, { task });
      } else if (task.status === "cancelled") {
        this.herTaskQueue.cancel(herTaskId, "Coding agent task was cancelled.");
      } else {
        this.herTaskQueue.failAwaitingConfirmation(herTaskId, task.error || "Coding agent task failed.");
      }
    } catch (error) {
      this.herTaskQueue.failAwaitingConfirmation(herTaskId, error instanceof Error ? error : String(error));
    }
  }

  private bindManifestRuntime() {
    attachToolHandlers(createToolHandlers({
      invokeToolHandler: (name, args, source) => this.invokeLegacyToolImplementation(name, args, source),
    }));
  }

  private executeManifestHandler(name: ToolName, args: Record<string, unknown>, source: "realtime" | "local") {
    const handler = toolManifest[name].handler;
    if (!handler) throw new Error(`Tool handler is missing: ${name}`);
    return handler(args, { source });
  }

  private summarize(name: ToolName, args: Record<string, unknown>) {
    return toolManifest[name].summarize?.(args) ?? summarizeToolCall(name, args);
  }

  private invokeLegacyToolImplementation(name: ToolName, args: Record<string, unknown>, source: "realtime" | "local") {
    if (this.isTaskControlTool(name)) return this.runTaskControlTool(name, args, source);
    return this.run(name, args, source);
  }

  private async run(name: ToolName, args: Record<string, unknown>, source: "realtime" | "local" = "local"): Promise<unknown> {
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
            macMail: "macos-mail-applescript",
            calendar: "local-calendar-adapter",
            weather: "open-meteo",
            macCalendar: "macos-calendar-applescript",
            macReminders: "macos-reminders-applescript",
            macNotes: "macos-notes-applescript",
            copy: "local-copy-adapter",
            files: "allowlisted-local-file-manager",
            documents: "txt-md-pdf-docx-extractor",
            desktop: "macos-allowlist",
            music: "macos-music-applescript",
            phone: "macos-contacts-tel-facetime",
            browser: "isolated-chrome-profile",
            shell: "confirm-first-safe-subset",
            codex: config.codexEnabled ? "app-server-json-rpc-stdio" : "disabled",
            router: "standard-intent-router-v2",
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
          updates: getUpdateStatus(),
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
        return this.runCodexTaskThroughGateway(this.enrichCodexTaskWithMemory(args as CodexTaskInput & { memoryIds?: string[] }), source);
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
      case "mac_mail_draft_create":
        return this.macMail.createDraft(args as { to: string; subject: string; body: string });
      case "weather_lookup":
        return this.weather.lookup(args.location as string, args.date as string | undefined);
      case "calendar_search":
        return this.store.searchCalendar(args.from as string, args.to as string, args.query as string | undefined, args.limit as number);
      case "calendar_create":
        this.assertChronological(args.start as string, args.end as string);
        return this.store.createCalendarEvent(args as { title: string; start: string; end: string; attendees: string[]; location?: string; notes?: string });
      case "mac_calendar_create":
        this.assertChronological(args.start as string, args.end as string);
        return this.macProductivity.createCalendarEvent(args as MacCalendarCreateInput);
      case "mac_reminder_create":
        return this.macProductivity.createReminder(args as MacReminderCreateInput);
      case "mac_note_create":
        return this.macProductivity.createNote(args as MacNoteCreateInput);
      case "copy_search":
        return this.store.searchCopy(args.query as string, args.limit as number);
      case "copy_save_draft":
        return this.store.saveCopyDraft(args as { title: string; body: string; project?: string });
      case "copy_publish":
        return this.store.publishCopyDraft(args.draftId as string);
      case "music_open":
        return this.music.open();
      case "music_play_song":
        return this.music.playSong(args.query as string, args.artist as string | undefined, args.mode as "play" | "search" | undefined);
      case "music_playback_state":
        return this.music.playbackState();
      case "music_spotify_search":
        return this.music.searchSpotify(args.query as string, args.artist as string | undefined, args.limit as number);
      case "music_spotify_play":
        return this.music.playSpotifyTrack(args.query as string, args.artist as string | undefined, args.deviceId as string | undefined);
      case "music_spotify_playback_state":
        return this.music.spotifyPlaybackState();
      case "music_netease_open":
        return this.music.openNetease(args.query as string | undefined, args.url as string | undefined);
      case "music_qq_open":
        return this.music.openQqMusic(args.query as string | undefined, args.target as "app" | "web");
      case "media_key_control":
        return this.system.mediaKeyControl(args.action as "play_pause" | "next" | "previous" | "volume_up" | "volume_down", args.appName as string | undefined);
      case "video_play":
        return this.video.play(args.service as "youtube" | "apple_tv" | "bilibili", args.query as string, args.mode as "play" | "search" | undefined);
      case "video_playback_control":
        return this.video.controlActiveVideo(args.action as "play" | "pause" | "toggle" | "state");
      case "apple_tv_playback_state":
        return this.video.appleTvPlaybackState();
      case "social_x_search":
        return this.social.searchX(args.query as string, args.limit as number);
      case "social_x_post":
        return this.social.postX(args.text as string, args.replyToTweetId as string | undefined);
      case "social_open":
        return this.social.open(
          args.service as "x" | "xiaohongshu",
          args.kind as "home" | "search" | "profile" | "note" | "share",
          args.target as string | undefined,
          args.isolated as boolean,
        );
      case "news_search":
        return this.newsFinance.searchNews(args.query as string, args.limit as number, args.provider as "gdelt" | "newsapi");
      case "sec_filing_search":
        return this.newsFinance.searchSecFilings(args.company as string, args.forms as string[], args.limit as number);
      case "macro_series_lookup":
        return this.newsFinance.lookupMacroSeries(args.seriesId as string, args.startYear as string | undefined, args.endYear as string | undefined);
      case "market_quote_lookup":
        return this.newsFinance.lookupMarketQuote(args.symbol as string);
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
      case "window_hide_all":
        return this.system.hideAllWindows({
          preserveFrontmost: args.preserveFrontmost as boolean,
          preserveFinder: args.preserveFinder as boolean,
        });
      case "window_minimize_all":
        return this.system.minimizeAllWindows();
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
      case "desktop_show":
        return this.system.showDesktop();
      case "desktop_open_app":
        return this.system.openApp(args.appName as string);
      case "system_close_app":
        return this.system.closeApp(args.appName as string);
      case "system_sleep":
        return this.system.sleepMac();
      case "system_lock_screen":
        return this.system.lockScreen();
      case "system_set_volume":
        return this.system.setVolume(args.level as number);
      case "system_get_volume":
        return this.system.getVolume();
      case "system_mute_volume":
        return this.system.muteVolume(args.muted as boolean);
      case "system_set_brightness":
        return this.system.setBrightness(args.level as number);
      case "system_set_dark_mode":
        return this.system.setDarkMode(args.enabled as boolean);
      case "system_open_settings":
        return this.system.openSettings(args.pane as string | undefined);
      case "desktop_clipboard_write":
        await writeClipboard(args.text as string);
        return { written: true };
      case "desktop_clipboard_read":
        return this.system.readClipboard();
      case "system_speak":
        return this.system.speakText(args.text as string, args.voice as string | undefined);
      case "system_notification":
        return this.system.showNotification(args.title as string, args.message as string, args.dialog as boolean);
      case "screenshot_capture":
        return this.system.captureScreenshot(args.mode as "clipboard" | "desktop" | "selection");
      case "keyboard_shortcut":
        return this.system.keyboardShortcut(args.action as Parameters<SystemControl["keyboardShortcut"]>[0]);
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
      case "browser_read_page":
        return this.browser.readPage(args.maxChars as number);
      case "browser_read_video_state":
        return this.browser.readVideoState();
      case "browser_fill_form":
        return this.browser.fillForm(args.fields as Array<{ selector: string; value: string }>);
      case "browser_click":
        return this.browser.click(args.selector as string, args.purpose as string);
      case "advanced_shell_command":
        return this.shell.run(args.command as string, args.timeoutMs as number);
      case "coding_agent_start":
        return this.codingAgent.start(args as never);
      case "coding_agent_continue":
        return this.codingAgent.continue(args as never);
      default:
        throw new Error(`Tool handler is not implemented: ${name}`);
    }
  }

  private isTaskControlTool(name: ToolName) {
    return name === "tool_catalog_list" || name === "tool_group_set" || name === "her_select_bundle" || name === "task_create" || name === "task_status" || name === "task_list" || name === "task_cancel" || name === "task_events" || name === "task_route" || name === "intent_route" || name === "coding_agent_status" || name === "coding_agent_cancel" || name === "coding_agent_get_result" || name === "memory_lookup" || name === "memory_save" || name === "memory_forget" || name === "memory_status";
  }

  private isQueueManagedToolName(name: string): name is ToolName {
    return Boolean(toolGroupLookup[name as ToolName]) && Boolean(toolManifest[name as ToolName]?.schema);
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

    const tools = Object.values(toolManifest)
      .filter((entry) => entry.group === group)
      .filter((entry) => this.isToolAvailable(entry.name))
      .map((entry) => ({
        name: entry.name,
        group,
        description: truncateText(entry.description, 220),
        requiresConfirmation: toolRequiresConfirmation(entry.name),
        arguments: compactJsonSchema(entry.parameters),
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
      toolCount: Object.values(toolManifest)
        .filter((entry) => entry.group === group)
        .filter((entry) => this.isToolAvailable(entry.name)).length,
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
    return this.routeResponse(plan, signals.confidence, signals.reason, preference, memoryMatches);
  }

  private routeIntent(input: IntentRouteInput) {
    const intent = input.intent;
    const request = intent.originalText.trim();
    const memoryMatches = this.memory.lookup({
      query: request,
      types: ["path_alias", "preference", "task_template"],
      limit: 5,
    }).matches;
    const plan = this.buildIntentRoutePlan(intent, input, memoryMatches);
    const reason = `Routed from Realtime StandardIntent: ${intent.intent} (${intent.domain}/${intent.complexity}).`;
    return this.routeResponse(plan, intent.confidence, reason, intent.routePreference ?? "auto", memoryMatches, intent);
  }

  private routeIntentForRealtime(input: IntentRouteInput) {
    const route = this.routeIntent(input);
    const readySteps = route.plan.filter((step) => step.status === "ready" && step.toolName);
    const queuedTasks = [];
    const queueErrors = [];

    for (const step of readySteps) {
      try {
        const queued = this.createTask(step.toolName as ToolName, step.arguments ?? {}, step.priority ?? "normal", 0, "realtime");
        queuedTasks.push({
          taskId: queued.task.taskId,
          toolName: step.toolName,
          status: queued.task.status,
          summary: queued.task.summary,
          requiresConfirmation: toolRequiresConfirmation(step.toolName as ToolName),
        });
      } catch (error) {
        queueErrors.push({
          toolName: step.toolName,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (queuedTasks.length || queueErrors.length) {
      return {
        mode: "queued",
        route: route.route,
        confidence: route.confidence,
        reason: route.reason,
        queuedTasks,
        queueErrors,
        queue: this.taskQueueSummary(true),
        nextAction: queuedTasks.some((task) => task.requiresConfirmation)
          ? "Tell the user HER is waiting for confirmation."
          : "Tell the user HER queued the task.",
      };
    }

    return {
      mode: route.plan.some((step) => step.status === "needs_clarification") ? "needs_clarification" : "not_queued",
      route: route.route,
      confidence: route.confidence,
      reason: route.reason,
      plan: route.plan.map((step) => ({
        provider: step.provider,
        status: step.status,
        title: step.title,
        reason: step.reason,
      })),
      nextAction: route.nextAction,
    };
  }

  private routeResponse(
    plan: RouteStep[],
    confidence: number,
    reason: string,
    preference: string,
    memoryMatches: Array<{ id: string; type: MemoryType; key: string; value?: string; summary: string; score?: number }>,
    intent?: StandardIntent,
  ) {
    const executablePlan = plan.map((step) => {
      if (!step.toolName || step.status !== "ready") return step;
      return {
        ...step,
        requiresConfirmation: toolRequiresConfirmation(step.toolName),
        taskCreate: {
          toolName: step.toolName,
          arguments: step.arguments ?? {},
          priority: step.priority ?? "normal",
        },
      };
    });
    return {
      route: executablePlan.length > 1 ? "mixed" : (executablePlan[0]?.provider ?? "clarify"),
      confidence,
      reason,
      preference,
      intent,
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

  private buildIntentRoutePlan(
    intent: StandardIntent,
    input: IntentRouteInput,
    memoryMatches: Array<{ id: string; type: MemoryType; key: string; value?: string; summary: string }>,
  ): RouteStep[] {
    const request = intent.originalText.trim();
    const missingInfo = intent.missingInfo ?? [];
    if (intent.routePreference === "clarify" || intent.complexity === "ambiguous" || intent.confidence < 0.45) {
      return [clarifyStep("Realtime intent needs clarification", missingInfo.length ? `Missing: ${missingInfo.join(", ")}` : "Realtime marked this request ambiguous.")];
    }

    const direct = this.intentDirectRouteStep(intent, input);
    if (direct) return [direct];

    if (intent.domain === "windows") return [buildNativeRouteStep(request, { userRequest: request, activeApp: input.activeApp, selectedText: input.selectedText })];

    if (intent.routePreference === "codex" || intent.complexity === "complex") {
      return [buildCodexIntentRouteStep(intent, input, memoryMatches)];
    }

    if (intent.domain === "phone") return [buildPhoneRouteStep(request)];
    if (intent.domain === "browser" || intent.domain === "research") return [buildBrowserSearchRouteStep(request)];
    if (intent.domain === "media" || intent.domain === "desktop") return [buildNativeRouteStep(request, { userRequest: request, activeApp: input.activeApp, selectedText: input.selectedText })];

    return [clarifyStep("Intent has no direct HER route", `HER does not yet have a direct provider for ${intent.domain}/${intent.action ?? "unknown action"}.`)];
  }

  private intentDirectRouteStep(intent: StandardIntent, input: IntentRouteInput): RouteStep | undefined {
    const request = intent.originalText.trim();
    if (intent.toolName && this.isQueueManagedToolName(intent.toolName) && toolGroupLookup[intent.toolName] !== "agents") {
      if (intent.toolName === "video_play") {
        const normalized = normalizeIntentVideoPlayArguments(intent);
        if (normalized) {
          return readyRouteStep(
            providerForTool(intent.toolName),
            `Open ${normalized.service === "youtube" ? "YouTube" : normalized.service} video`,
            intent.toolName,
            normalized,
            "Realtime provided a video_play intent. HER normalized video service arguments before queueing.",
          );
        }
      }
      return readyRouteStep(
        providerForTool(intent.toolName),
        `Run ${intent.toolName}`,
        intent.toolName,
        intent.toolArguments ?? {},
        "Realtime provided a simple StandardIntent with a concrete HER tool and arguments.",
      );
    }

    if (intent.domain === "weather") {
      const location = readStringEntity(intent, "location") ?? readStringEntity(intent, "place") ?? readStringEntity(intent, "city");
      if (!location) return clarifyStep("Weather intent needs a location", "Weather lookup requires a city, address, or place name.");
      return readyRouteStep(
        "native",
        "Look up weather",
        "weather_lookup",
        {
          location,
          ...(readStringEntity(intent, "date") ? { date: readStringEntity(intent, "date") } : {}),
        },
        "Realtime parsed a simple weather intent. HER will use the local weather adapter.",
      );
    }

    if (intent.domain === "browser") {
      const url = readStringEntity(intent, "url");
      if (url) {
        const browserMode = (readStringEntity(intent, "browser") ?? readStringEntity(intent, "mode") ?? "").toLowerCase();
        const isolated = readBooleanEntity(intent, "isolated");
        const useNormalBrowser =
          isolated === false ||
          /(main|normal|default|主浏览器|普通|默认)/i.test(browserMode) ||
          /(主浏览器|普通浏览器|默认浏览器|不要用隔离|not isolated|default browser|main browser)/i.test(request);
        return useNormalBrowser
          ? readyRouteStep(
            "browser",
            "Open URL in normal browser",
            "browser_open_url",
            { url },
            "Realtime parsed a browser URL intent and the user asked for the normal/default browser.",
          )
          : readyRouteStep(
            "browser",
            "Open URL in isolated Chrome",
            "browser_isolated_open_url",
            { url },
            "Realtime parsed a browser URL intent. Low-risk browsing defaults to HER's isolated browser.",
          );
      }

      const youtubeRoute = buildYouTubeIntentRouteStep(intent);
      if (youtubeRoute) return youtubeRoute;

      const query = readStringEntity(intent, "query") ?? readStringEntity(intent, "searchQuery");
      if (query && /(search|搜索|搜|search page|搜索页)/i.test(intent.action ?? request)) {
        return readyRouteStep(
          "browser",
          "Open browser search page",
          "browser_search_open",
          {
            query,
            engine: inferSearchEngine(`${request} ${readStringEntity(intent, "engine") ?? ""}`),
            isolated: !/(主浏览器|普通浏览器|默认浏览器|已有登录|登录态|normal browser|default browser|main browser|logged in)/i.test(request),
          },
          "Realtime parsed a browser search intent. HER opens the search page without reading result content.",
        );
      }
    }

    if (intent.domain === "calendar") {
      const title = readStringEntity(intent, "title") ?? readStringEntity(intent, "summary") ?? request;
      const start = readStringEntity(intent, "start") ?? readStringEntity(intent, "startAt");
      const end = readStringEntity(intent, "end") ?? readStringEntity(intent, "endAt") ?? defaultCalendarEnd(start);
      if (start && end) {
        return readyRouteStep(
          "native",
          "Create calendar event",
          "mac_calendar_create",
          {
            title,
            start,
            end,
            attendees: readStringArrayEntity(intent, "attendees"),
            ...(readStringEntity(intent, "calendarName") ? { calendarName: readStringEntity(intent, "calendarName") } : {}),
            location: readStringEntity(intent, "location") ?? "",
            notes: readStringEntity(intent, "notes") ?? "",
          },
          end === readStringEntity(intent, "end") || end === readStringEntity(intent, "endAt")
            ? "Realtime parsed a simple calendar intent. HER will create it through macOS Calendar."
            : "Realtime parsed a calendar start time. HER will default the duration to one hour.",
          "high",
        );
      }
      return clarifyStep("Calendar intent needs time details", "Calendar creation requires at least a title and start time. End time, location, notes, and attendees can default.");
    }

    if (intent.domain === "reminder") {
      const title = readStringEntity(intent, "title") ?? readStringEntity(intent, "summary") ?? request;
      const dueAt = readStringEntity(intent, "dueAt") ?? readStringEntity(intent, "date");
      return readyRouteStep(
        "native",
        "Create reminder",
        "mac_reminder_create",
        {
          title,
          ...(dueAt ? { dueAt } : {}),
          ...(readStringEntity(intent, "listName") ? { listName: readStringEntity(intent, "listName") } : {}),
          ...(readStringEntity(intent, "notes") ? { notes: readStringEntity(intent, "notes") } : {}),
        },
        "Realtime parsed a simple reminder intent. HER will create it through macOS Reminders.",
        "high",
      );
    }

    if (intent.domain === "notes") {
      const title = readStringEntity(intent, "title") ?? readStringEntity(intent, "summary") ?? "HER Note";
      const body =
        readStringEntity(intent, "body") ??
        readStringEntity(intent, "content") ??
        readStringEntity(intent, "notes") ??
        input.selectedText ??
        request;
      return readyRouteStep(
        "native",
        "Create note",
        "mac_note_create",
        {
          title,
          body,
          ...(readStringEntity(intent, "folderName") ? { folderName: readStringEntity(intent, "folderName") } : {}),
        },
        "Realtime parsed a simple notes intent. HER will create it through macOS Notes.",
        "high",
      );
    }

    if (intent.domain === "email") {
      const draftId = readStringEntity(intent, "draftId") ?? readStringEntity(intent, "emailId");
      const to = readStringEntity(intent, "to") ?? readStringEntity(intent, "recipient") ?? readStringEntity(intent, "email");
      const subject = readStringEntity(intent, "subject") ?? readStringEntity(intent, "title");
      const body = readStringEntity(intent, "body") ?? readStringEntity(intent, "content") ?? readStringEntity(intent, "message");
      const query = readStringEntity(intent, "query") ?? readStringEntity(intent, "search") ?? readStringEntity(intent, "keyword");
      const action = intent.action ?? request;

      if (/send|发送|寄出/i.test(action) && draftId) {
        return readyRouteStep(
          "native",
          "Send local email draft",
          "email_send",
          { draftId },
          "Realtime parsed a simple email send intent with a concrete draft id. HER will still require confirmation.",
          "high",
        );
      }

      if (/read|读取|查看|打开/i.test(action) && draftId) {
        return readyRouteStep(
          "native",
          "Read local email",
          "email_read",
          { emailId: draftId },
          "Realtime parsed a simple local email read intent.",
        );
      }

      if (/search|查|找|有没有/i.test(action) && (query || request)) {
        return readyRouteStep(
          "native",
          "Search local email",
          "email_search",
          { query: query ?? request, limit: 5 },
          "Realtime parsed a simple local email search intent.",
        );
      }

      if (/draft|草稿|写.*邮件|email/i.test(action) && to && subject && body && /@/.test(to)) {
        return readyRouteStep(
          "native",
          "Create visible Mail draft",
          "mac_mail_draft_create",
          { to, subject, body },
          "Realtime parsed a simple email draft intent with a concrete recipient address. HER will create a visible macOS Mail draft.",
          "high",
        );
      }

      return clarifyStep("Email intent needs details", "Email draft/send/read needs a concrete recipient address, draft id, subject/body, or search query.");
    }

    if (intent.domain === "system") {
      const level = readNumberEntity(intent, "level") ?? readNumberEntity(intent, "volume") ?? readNumberEntity(intent, "percent");
      const action = intent.action ?? request;
      if (/(音量|声音|小声|太吵|volume|loud|quiet)/i.test(action) && typeof level === "number") {
        return readyRouteStep(
          "native",
          `Set volume to ${Math.round(level)}`,
          "system_set_volume",
          { level: Math.round(level) },
          "Realtime parsed a simple system volume intent.",
        );
      }
      const brightness = readNumberEntity(intent, "brightness") ?? level;
      if (/(亮度|brightness|screen brightness)/i.test(action) && typeof brightness === "number") {
        return readyRouteStep(
          "native",
          `Set brightness to ${Math.round(brightness)}`,
          "system_set_brightness",
          { level: Math.round(brightness) },
          "Realtime parsed a simple display brightness intent.",
        );
      }
      const appearance = (readStringEntity(intent, "appearance") ?? readStringEntity(intent, "mode") ?? "").toLowerCase();
      if (/(深色|暗色|dark)/i.test(`${action} ${appearance} ${request}`)) {
        return readyRouteStep(
          "native",
          "Turn dark mode on",
          "system_set_dark_mode",
          { enabled: true },
          "Realtime parsed a simple appearance intent. HER maps dark appearance to macOS dark mode.",
        );
      }
      if (/(浅色|亮色|light)/i.test(`${action} ${appearance}`)) {
        return readyRouteStep(
          "native",
          "Turn dark mode off",
          "system_set_dark_mode",
          { enabled: false },
          "Realtime parsed a simple appearance intent. HER maps light appearance to macOS dark mode off.",
        );
      }
    }

    if ((intent.candidateTools ?? []).includes("shortcut_list") || (intent.domain === "media" && /快捷指令|shortcut/i.test(intent.action ?? request) && /列|看|有没有|list|show|find/i.test(intent.action ?? request))) {
      return readyRouteStep(
        "native",
        "List Shortcuts",
        "shortcut_list",
        { limit: 20 },
        "Realtime parsed a shortcut discovery intent. Listing shortcuts is read-only and must not run a shortcut.",
      );
    }

    if (intent.domain === "phone" && ((intent.candidateTools ?? []).includes("contacts_search") || /contact|通讯录|联系人|候选|search/i.test(intent.action ?? request))) {
      const query =
        readStringEntity(intent, "query") ??
        readStringEntity(intent, "name") ??
        readStringEntity(intent, "contactName") ??
        readStringEntity(intent, "person") ??
        request;
      return readyRouteStep(
        "phone",
        `Search contacts for ${query}`,
        "contacts_search",
        { query, limit: 5 },
        "Realtime parsed a simple contact search intent. HER will search macOS Contacts without placing a call.",
      );
    }

    return undefined;
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

  private async runCodexTaskThroughGateway(input: CodexTaskInput, source: "realtime" | "local") {
    const result = await this.codex.runTask(input);
    const gatewayRequests = extractHerGatewayRequests(result.finalText);
    if (!gatewayRequests.length) return result;

    const gatewayResults = gatewayRequests.map((request) => {
      try {
        if (!this.isQueueManagedToolName(request.toolName)) {
          throw new Error(`Unknown or non-queue HER tool: ${request.toolName}`);
        }
        if (request.toolName === "codex_task_run") {
          throw new Error("Codex cannot recursively request codex_task_run through HER Tool Gateway.");
        }
        const queued = this.createTask(
          request.toolName,
          request.arguments ?? {},
          request.priority ?? "normal",
          request.runAfterMs ?? 0,
          source,
        );
        return {
          ok: true,
          toolName: request.toolName,
          reason: request.reason,
          taskId: queued.task.taskId,
          summary: queued.task.summary,
        };
      } catch (error) {
        return {
          ok: false,
          toolName: request.toolName,
          reason: request.reason,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    });

    this.audit.write({
      action: "codex.gateway",
      summary: `Processed ${gatewayRequests.length} HER Tool Gateway request(s)`,
      status: gatewayResults.some((item) => !item.ok) ? "error" : "ok",
      details: { gatewayResults },
    });

    return {
      ...result,
      herToolGateway: {
        requests: gatewayRequests,
        results: gatewayResults,
        note: "HER validated and queued accepted tool requests through the local Tool Gateway.",
      },
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
    const detailedTools = Object.values(toolManifest)
      .filter((entry) => {
        const group = entry.group;
        if (!group || group === "agents") return false;
        return selectedGroups.has(group) && this.enabledToolGroups.has(group) && this.isToolAvailable(entry.name);
      })
      .slice(0, 80)
      .map((entry) => {
        const group = entry.group;
        const args = compactJsonSchema(entry.parameters);
        return {
          name: entry.name,
          group,
          capability: truncateText(entry.description, 140),
          requiresConfirmation: toolRequiresConfirmation(entry.name),
          args,
        };
      });
    const groups = toolGroups
      .filter((group) => group !== "agents")
      .map((group) => ({
        group,
        enabled: this.enabledToolGroups.has(group),
        detailed: selectedGroups.has(group),
        toolCount: Object.values(toolManifest)
          .filter((entry) => entry.group === group)
          .filter((entry) => this.isToolAvailable(entry.name)).length,
      }));
    return `HER exposed tool namespace for Codex planning:
- Codex cannot execute HER desktop/media/browser/phone tools directly. It may only request HER Tool Gateway calls.
- Use only the detailed tool names below for HER Tool Gateway requests.
- If a needed tool group is not detailed, return status "needs_tool_group" with the group name; do not invent tool names.
- If no HER tool/provider exists, return status "needs_provider".
- Codex native fallback tools/MCP/plugins are ${config.codexNativeToolsFallback ? "allowed" : "disabled"} for missing HER providers. When allowed, use only tools already available inside the Codex runtime and label results as "codex_native_fallback"; if unavailable, report "fallback_unavailable".
- Booking, purchases, sending, deleting, calling, publishing, shell, shortcuts, file writes, and browser submit/click actions require confirmation.
- To request HER local execution, include exactly one final block:
  <her_tool_gateway>{"requests":[{"toolName":"mac_calendar_create","arguments":{"title":"...","start":"...","end":"...","attendees":[]},"priority":"normal","reason":"..."}]}</her_tool_gateway>
- HER will validate, queue, and confirm these requests after Codex completes. Do not claim the HER tools have already run.
- For pure repo/file/code work, complete the Codex task normally without a gateway block.

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

    const schema = toolManifest[toolName].schema;
    if (!schema) throw new Error(`Unknown tool: ${toolName}`);
    const parsed = schema.safeParse(rawArguments ?? {});
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
      summary: this.summarize(toolName, parsed.data as Record<string, unknown>),
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

  private getUnifiedTaskStatus(taskId: string, source: "realtime" | "local") {
    const herTask = this.herTasks.get(taskId);
    if (herTask) return { task: this.toHerTaskToolView(herTask, source), runtime: "her_task_runtime" };
    return this.getTaskStatus(taskId, source);
  }

  private listUnifiedTasks(status: TaskStatus | HerTaskStatus | undefined, limit: number, source: "realtime" | "local") {
    const herStatus = isHerTaskStatus(status) ? status : undefined;
    const legacyStatus = isLegacyTaskStatus(status) ? status : undefined;
    return {
      tasks: this.herTasks.list({ status: herStatus, limit }).map((task) => this.toHerTaskToolView(task, source)),
      legacyQueue: this.listTasks(legacyStatus, limit, source),
      runtime: "her_task_runtime",
    };
  }

  private toHerTaskToolView(task: HerTaskView, source: "realtime" | "local") {
    const eventLimit = source === "realtime" ? 3 : 6;
    return {
      ...task,
      events: task.events.slice(-eventLimit).map((event) => {
        if (event.type === "task_created") {
          return {
            type: event.type,
            taskId: event.taskId,
            timestamp: event.timestamp,
            title: event.task.title,
            status: event.task.status,
          };
        }
        if (event.type === "task_completed" && source === "realtime") {
          return {
            type: event.type,
            taskId: event.taskId,
            timestamp: event.timestamp,
          };
        }
        return event;
      }),
    };
  }

  private cancelUnifiedTask(taskId: string) {
    if (this.herTasks.get(taskId)) return this.herTaskQueue.cancel(taskId);
    return this.cancelTask(taskId);
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

    const summary = this.summarize(task.toolName, task.arguments);
    const approval = approvalPolicy.decide({
      toolName: task.toolName,
      args: task.arguments,
      summary,
      yoloMode: this.isYoloMode(),
    });
    if (approval.type === "deny") {
      return { ok: false, name: task.toolName, error: approval.reason, code: approval.code };
    }
    if (approval.type === "require_confirmation") {
      const confirmation = this.confirmations.add(approval.plan);
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
      const result = await this.runCodexTaskThroughGateway({
        ...this.enrichCodexTaskWithMemory(task.arguments as CodexTaskInput & { memoryIds?: string[] }),
        onProgress: (event) => this.addTaskProgress(task, event.status, event.summary, event.method),
      }, task.source);
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

  private updateTaskForConfirmation(
    confirmationId: string,
    approved: boolean,
    confirmationResult: Awaited<ReturnType<ConfirmationQueue["decide"]>> & { result?: unknown },
  ) {
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
    const result = "result" in confirmationResult ? confirmationResult.result : undefined;
    task.result = { ok: true, name: task.toolName, result: this.compactResult(task.toolName, result, task.source) };
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
    if (name === "tool_result_read") return result;
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
    if (authorized.size === 0) return { windowsClosed: 0, appsAffected: 0, scope: "authorized_apps" };
    const windows = await this.system.listWindows();
    const appNames = new Set(windows.map((window) => window.appName).filter((appName) => authorized.has(appName)));
    if (appNames.size === 0) return { windowsClosed: 0, appsAffected: 0, scope: "authorized_apps" };
    return this.system.closeAllWindows(appNames);
  }

  private async autoArrangeAuthorizedWindows(requestedAppNames: string[]) {
    if (!this.gate) return this.system.autoArrangeWindows(requestedAppNames);
    const authorized = await this.gate.authorizedAppNames();
    const requested = new Set(requestedAppNames);
    const appNames = new Set(
      [...authorized]
        .filter((appName) => requested.size === 0 || requested.has(appName)),
    );
    if (appNames.size === 0) return { windowsArranged: 0, appsAffected: 0, layout: "0x0", scope: "authorized_apps" };
    return this.system.autoArrangeWindows(appNames);
  }

  private async minimizeUnrelatedAuthorizedWindows(options: {
    keepAppNames: string[];
    keepTitleKeywords: string[];
    preserveFrontmost: boolean;
  }) {
    if (!this.gate) return this.system.minimizeUnrelatedWindows(options);
    const authorized = await this.gate.authorizedAppNames();
    if (authorized.size === 0) {
      return { windowsMinimized: 0, windowsPreserved: 0, appsAffected: 0, frontmostApp: "", frontmostWindow: "", scope: "authorized_apps" };
    }
    const keepApps = new Set(options.keepAppNames);
    const appNames = new Set([...authorized]);
    const hasUnrelatedAuthorizedApp = [...appNames].some((appName) => !keepApps.has(appName));
    if (!hasUnrelatedAuthorizedApp) {
      return {
        windowsMinimized: 0,
        windowsPreserved: 0,
        appsAffected: 0,
        frontmostApp: "",
        frontmostWindow: "",
        scope: "authorized_apps",
      };
    }
    return this.system.minimizeUnrelatedWindows({ ...options, appNames });
  }

  private listConfirmations() {
    return this.confirmations.list().map((item) => ({
      confirmationId: item.id,
      name: item.name,
      summary: item.summary,
      risk: item.plan.risk,
      reversible: item.plan.reversible,
      preview: item.plan.preview,
      expiresAt: new Date(item.expiresAt).toISOString(),
    }));
  }

  private async decideConfirmation(confirmationId: string | undefined, approved: boolean): Promise<unknown> {
    const pending = this.confirmations.list();
    const id = confirmationId ?? (pending.length === 1 ? pending[0].id : undefined);
    if (!id) {
      throw new Error(`There are ${pending.length} pending confirmations. Use confirmation_list and specify confirmationId.`);
    }

    const decision = await this.confirmations.decide(id, approved);
    const execution: unknown = decision.rejected ? undefined : await this.executeActionPlan(decision.plan);
    const result = decision.rejected ? decision : { ...decision, result: execution };
    this.updateTaskForConfirmation(id, approved, result);
    const summary = decision.rejected ? (decision.summary ?? `Rejected ${id}`) : `Approved ${id}`;
    this.audit.write({
      action: "confirmation",
      summary,
      status: decision.rejected ? "rejected" : "ok",
    });
    return {
      confirmationId: id,
      approved,
      result: result.rejected ? { rejected: true, summary: result.summary } : ("result" in result ? result.result : undefined),
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

type HerGatewayRequest = {
  toolName: string;
  arguments?: Record<string, unknown>;
  priority?: TaskPriority;
  runAfterMs?: number;
  reason?: string;
};

const extractHerGatewayRequests = (text: string): HerGatewayRequest[] => {
  const match = /<her_tool_gateway>\s*([\s\S]*?)\s*<\/her_tool_gateway>/i.exec(text);
  if (!match?.[1]) return [];
  try {
    const parsed = JSON.parse(match[1]) as unknown;
    if (!parsed || typeof parsed !== "object") return [];
    const requests = Array.isArray((parsed as { requests?: unknown }).requests)
      ? (parsed as { requests: unknown[] }).requests
      : [];
    return requests
      .map((item): HerGatewayRequest | undefined => {
        if (!item || typeof item !== "object") return undefined;
        const value = item as Record<string, unknown>;
        if (typeof value.toolName !== "string" || !value.toolName.trim()) return undefined;
        const args = value.arguments && typeof value.arguments === "object" && !Array.isArray(value.arguments)
          ? (value.arguments as Record<string, unknown>)
          : {};
        const priority = value.priority === "low" || value.priority === "normal" || value.priority === "high"
          ? value.priority
          : "normal";
        const runAfterMs = typeof value.runAfterMs === "number" && Number.isFinite(value.runAfterMs)
          ? Math.max(0, Math.min(600000, Math.floor(value.runAfterMs)))
          : 0;
        return {
          toolName: value.toolName.trim(),
          arguments: args,
          priority,
          runAfterMs,
          reason: typeof value.reason === "string" ? truncateText(value.reason, 300) : undefined,
        };
      })
      .filter((item): item is HerGatewayRequest => Boolean(item))
      .slice(0, 8);
  } catch {
    return [];
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
    fields: Object.fromEntries(
      keys.map((key) => {
        const property = (value.properties ?? {})[key] as Record<string, unknown> | undefined;
        if (!property || typeof property !== "object") return [key, {}];
        return [
          key,
          Object.fromEntries(
            ["type", "enum", "minimum", "maximum", "default", "description"].flatMap((field) =>
              field in property ? [[field, property[field]]] : [],
            ),
          ),
        ];
      }),
    ),
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
  if (/(文件|文件夹|目录|文档|资料|周报|月报|日报|表格|word|excel|csv|docx?|pdf|xlsx?|pptx?|folder|file|directory|report|spreadsheet)/i.test(prompt)) {
    add("files");
    add("documents");
  }
  if (/(邮件|日历|会议|提醒|笔记|天气|文案|旅行|出差|行程|安排|洛杉矶|航班|酒店|交通|生日|妈妈|女儿|回国|接机|机场|跟进|email|mail|calendar|meeting|reminder|note|weather|travel|trip|itinerary|flight|hotel|transport|copy|draft|birthday|pickup|airport|follow.?up)/i.test(prompt)) {
    add("text");
  }
  if (/(音乐|歌曲|视频|电影|电视|快捷指令|播放|暂停|上一首|下一首|网易云|qq音乐|spotify|youtube|bilibili|哔哩|b站|music|song|video|apple tv|shortcut|play|pause|next|previous)/i.test(prompt)) add("media");
  if (/(小红书|xhs|twitter|tweet|推特|发帖|帖子|社交|social|xiaohongshu|\bx\b)/i.test(prompt)) add("social");
  if (/(新闻|资讯|财经|股价|行情|报价|财报|公告|sec|edgar|bls|cpi|通胀|失业率|非农|news|finance|market|quote|filing|macro|inflation|unemployment|payroll)/i.test(prompt)) add("research");
  if (/(电话|拨打|facetime|call|contact)/i.test(prompt)) add("phone");
  if (/(浏览器|网页|页面|搜索页|打开.*https?:|browser|chrome|url|web|page)/i.test(prompt)) add("browser");
  if (/(旅行|出差|行程|航班|酒店|交通|travel|trip|itinerary|flight|hotel|transport)/i.test(prompt)) add("browser");
  if (/(应用|打开|关闭|启动|聚焦|app|launch|focus|quit)/i.test(prompt)) add("apps");
  if (/(窗口|排列|平铺|最小化|最大化|window|layout)/i.test(prompt)) add("windows");
  if (/(音量|声音|太吵|小声|安静|亮度|深色|系统设置|剪贴板|静音|取消静音|锁屏|睡眠|朗读|通知|弹窗|截图|快捷键|复制|粘贴|全选|撤销|刷新|新建标签|新建窗口|volume|loud|quiet|brightness|settings|clipboard|mute|unmute|lock|sleep|speak|notification|screenshot|shortcut|copy|paste|refresh)/i.test(prompt)) add("system");
  if (/(权限|授权|yolo|permission|capability)/i.test(prompt)) add("permissions");
  if (/(shell|命令|终端|命令行|cli|terminal|command)/i.test(prompt)) add("shell");
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
  const explicitMusicService = /(qq\s*音乐|qqmusic|qq music|QQ音乐|网易云|网易云音乐|net\s*ease|netease|spotify)/i.test(request);
  const phone = /(打电话|拨打|呼叫|电话给|facetime|face time|call\s+)/i.test(request);
  const browser = preference === "native" || explicitMusicService ? false : browserSearch;
  const search = preference === "search" || (!explicitMusicService && !browser && !localDocument && externalSearch);
  const codex =
    preference === "codex" ||
    localDocument && /(写|生成|整理|总结|汇总|分析|归纳|月报|报告|草稿|提炼|write|summari[sz]e|report|analy[sz]e)/i.test(request) ||
    /(代码|项目|仓库|测试|修复|实现|重构|构建|编译|提交|推送|改.*项目|改.*代码|bug|repo|repository|test|fix|implement|refactor|build|commit|push|review)/i.test(request);
  const native =
    preference === "native" ||
    explicitMusicService ||
    (!browser && (
      /(打开|启动|关闭|聚焦|切到|播放|暂停|继续|上一首|下一首|音量|亮度|深色|窗口|最小化|最大化|隐藏|收起|显示桌面|清空视野|只保留当前|排列|平铺|复制到剪贴板|读取剪贴板|静音|取消静音|锁屏|睡眠|朗读|通知|弹窗|截图|快捷键|复制|粘贴|全选|撤销|刷新|新建标签|新建窗口|qq音乐|QQ音乐|\bopen\b|\blaunch\b|\bclose\b|\bfocus\b|\bplay\b|\bpause\b|\bnext\b|\bprevious\b|\bvolume\b|\bbrightness\b|\bwindow\b|\bhide\b|\bminimize\b|\bdesktop\b|\bmute\b|\bunmute\b|\block\b|\bsleep\b|\bspeak\b|\bnotification\b|\bscreenshot\b|\bcopy\b|\bpaste\b|\brefresh\b)/i.test(request) ||
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
    if (isYouTubeUrl(url)) {
      return readyRouteStep(
        "native",
        "Open YouTube URL",
        "video_play",
        { service: "youtube", query: url, mode: videoRequestMode(request) },
        "YouTube URLs should open in HER's isolated Chrome video workflow.",
      );
    }
    if (isBilibiliUrl(url)) {
      return readyRouteStep(
        "native",
        "Open Bilibili URL",
        "video_play",
        { service: "bilibili", query: url, mode: videoRequestMode(request) },
        "Bilibili URLs should open in HER's isolated Chrome video workflow.",
      );
    }
    if (isNeteaseUrl(url)) {
      return readyRouteStep(
        "native",
        "Open NetEase Cloud Music URL",
        "music_netease_open",
        { url },
        "NetEase Cloud Music is opened conservatively without claiming direct playback.",
      );
    }
    if (isXiaohongshuUrl(url)) {
      return readyRouteStep(
        "native",
        "Open Xiaohongshu URL",
        "social_open",
        { service: "xiaohongshu", kind: "note", target: url, isolated: shouldUseIsolatedBrowser(request) },
        "Xiaohongshu is limited to opening pages; HER avoids sensitive automation there.",
      );
    }
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

  if (isXPostRequest(request)) {
    return readyRouteStep(
      "native",
      "Post to X",
      "social_x_post",
      { text: extractXPostText(request) },
      "X write actions use the official X API and require explicit confirmation.",
    );
  }
  if (isXSearchRequest(request)) {
    return readyRouteStep(
      "native",
      "Search X",
      "social_x_search",
      { query: extractSocialQuery(request, "x"), limit: 10 },
      "X read/search uses the official X API when configured.",
    );
  }
  if (isXiaohongshuRequest(request)) {
    return readyRouteStep(
      "native",
      "Open Xiaohongshu",
      "social_open",
      { service: "xiaohongshu", kind: "search", target: extractSocialQuery(request, "xiaohongshu"), isolated: shouldUseIsolatedBrowser(request) },
      "Xiaohongshu is limited to opening search, note, or share pages.",
    );
  }
  if (isSpotifyRequest(request)) {
    return readyRouteStep(
      "native",
      "Use Spotify",
      spotifyRequestMode(request) === "search" ? "music_spotify_search" : "music_spotify_play",
      { query: extractMusicServiceQuery(request, "spotify") },
      "Spotify content uses the official Spotify Web API instead of browser scraping.",
    );
  }
  if (isMarketQuoteRequest(request)) {
    return readyRouteStep(
      "native",
      "Read market quote",
      "market_quote_lookup",
      { symbol: extractTickerSymbol(request) },
      "Market quotes use configured finance data providers and display details in HER.",
    );
  }
  if (isSecFilingRequest(request)) {
    return readyRouteStep(
      "native",
      "Search SEC filings",
      "sec_filing_search",
      { company: extractSecCompany(request), forms: extractSecForms(request), limit: 10 },
      "SEC filing requests should use official EDGAR data instead of a generic browser search.",
    );
  }
  if (isMacroSeriesRequest(request)) {
    return readyRouteStep(
      "native",
      "Read macro series",
      "macro_series_lookup",
      { seriesId: extractMacroSeriesId(request), startYear: extractYear(request, "start"), endYear: extractYear(request, "end") },
      "Macro series requests use official BLS public data when a BLS series id is provided.",
    );
  }
  if (isNewsRequest(request)) {
    return readyRouteStep(
      "native",
      "Search news",
      "news_search",
      { query: extractNewsQuery(request), provider: "gdelt", limit: 8 },
      "News requests should return structured article results and display them in HER.",
    );
  }
  if (isNeteaseRequest(request)) {
    const query = extractMusicServiceQuery(request, "netease");
    return readyRouteStep(
      "native",
      "Open NetEase Cloud Music",
      "music_netease_open",
      query ? { query } : {},
      "NetEase Cloud Music is opened conservatively without claiming direct playback.",
    );
  }
  const mediaAction = inferMediaKeyAction(request);
  if (mediaAction) {
    return readyRouteStep(
      "native",
      "Control media playback",
      "media_key_control",
      { action: mediaAction, ...(isQqMusicRequest(request) ? { appName: "QQMusic" } : {}) },
      "Basic media playback controls should use HER's local media control tool.",
    );
  }
  if (isQqMusicRequest(request)) {
    const query = extractMusicServiceQuery(request, "qq");
    return readyRouteStep(
      "native",
      "Open QQ Music",
      "music_qq_open",
      { ...(query ? { query } : {}), target: qqMusicTarget(request) },
      "QQ Music is opened conservatively through the client or official web search. Direct playback is not claimed.",
    );
  }
  if (isBilibiliRequest(request)) {
    return readyRouteStep(
      "native",
      "Open Bilibili",
      "video_play",
      { service: "bilibili", query: extractVideoServiceQuery(request, "bilibili"), mode: videoRequestMode(request) },
      "Bilibili is handled through isolated Chrome pages and browser-level playback control.",
    );
  }
  if (isYouTubeRequest(request)) {
    return readyRouteStep(
      "native",
      "Open YouTube video",
      "video_play",
      { service: "youtube", query: extractVideoServiceQuery(request, "youtube"), mode: youtubeRequestMode(request) },
      "YouTube video requests should use HER's isolated Chrome video workflow instead of a generic browser search.",
    );
  }

  if (isAppleTvRequest(request) && /(搜索|搜|找|播放|看|打开.*(剧|电影|节目|show|movie|episode)|watch|play|search|find)/i.test(request) && !isOnlyOpeningAppleTvApp(request)) {
    const query = extractAppleTvQuery(request);
    return readyRouteStep(
      "native",
      `Open Apple TV for ${query}`,
      "video_play",
      { service: "apple_tv", query, mode: appleTvRequestMode(request) },
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
      { query: extractMusicQuery(request), mode: musicRequestMode(request) },
      "Music playback should use HER's Music tool instead of generic app or browser control.",
    );
  }

  const appName = extractKnownAppName(request) ?? input.activeApp;
  if (/(睡眠|休眠|sleep(?!.*display))/i.test(request)) {
    return readyRouteStep("native", "Sleep Mac", "system_sleep", {}, "Mac sleep is an allowlisted HER system command.", "high");
  }
  if (/(锁屏|锁定屏幕|display\s*sleep|lock\s*screen)/i.test(request)) {
    return readyRouteStep("native", "Lock screen", "system_lock_screen", {}, "Screen lock/display sleep is an allowlisted HER system command.", "high");
  }
  const settingsPane = inferSettingsPane(request);
  if (settingsPane) {
    return readyRouteStep("native", `Open ${settingsPane} settings`, "system_open_settings", { pane: settingsPane }, "Opening System Settings panes is an allowlisted HER system task.");
  }
  if (/(当前音量|音量.*多少|读取音量|get.*volume|volume.*state)/i.test(request)) {
    return readyRouteStep("native", "Read volume", "system_get_volume", {}, "Reading system volume is a direct HER system task.");
  }
  if (/(取消静音|解除静音|unmute)/i.test(request)) {
    return readyRouteStep("native", "Unmute volume", "system_mute_volume", { muted: false }, "Unmuting system volume is a direct HER system task.");
  }
  if (/(静音|mute)/i.test(request) && !/(取消静音|解除静音|unmute)/i.test(request)) {
    return readyRouteStep("native", "Mute volume", "system_mute_volume", { muted: true }, "Muting system volume is a direct HER system task.");
  }
  if (/(读取|读|查看).*(剪贴板|clipboard)|pbpaste/i.test(request)) {
    return readyRouteStep("native", "Read clipboard", "desktop_clipboard_read", {}, "Reading clipboard text is a direct HER system task.");
  }
  const notification = extractNotificationRequest(request);
  if (notification) {
    return readyRouteStep(
      "native",
      notification.dialog ? "Show dialog" : "Show notification",
      "system_notification",
      notification,
      "macOS notifications and dialogs are allowlisted HER system commands.",
      "normal",
    );
  }
  const speak = extractSpeakRequest(request);
  if (speak) {
    return readyRouteStep("native", "Speak text", "system_speak", speak, "macOS speech uses the allowlisted say command.");
  }
  const screenshotMode = inferScreenshotMode(request);
  if (screenshotMode) {
    return readyRouteStep("native", "Capture screenshot", "screenshot_capture", { mode: screenshotMode }, "macOS screenshots use the allowlisted screencapture command.");
  }
  const keyboardAction = inferKeyboardShortcutAction(request);
  if (keyboardAction) {
    return readyRouteStep("native", "Send keyboard shortcut", "keyboard_shortcut", { action: keyboardAction }, "Keyboard shortcuts are allowlisted HER native commands.");
  }
  if (/(关闭|关掉|close).*(所有|全部|all).*(窗口|windows?)|(所有|全部|all).*(窗口|windows?).*(关闭|关掉|close)/i.test(request)) {
    return readyRouteStep("native", "Close all windows", "window_close_all", {}, "Closing all windows is a direct HER window task.");
  }
  if (/(显示桌面|桌面显示|show\s*desktop)/i.test(request)) {
    return readyRouteStep("native", "Show desktop", "desktop_show", {}, "Showing the desktop is a direct HER window task.");
  }
  if (/(隐藏|收起|hide).*(所有|全部|all).*(窗口|应用|app|windows?)|(所有|全部|all).*(窗口|应用|app|windows?).*(隐藏|收起|hide)|只保留当前|保留当前.*其余.*(隐藏|收起)|清空视野|一键清空视野|keep.*frontmost.*hide/i.test(request)) {
    return readyRouteStep(
      "native",
      "Hide app windows",
      "window_hide_all",
      {
        preserveFrontmost: /(只保留当前|保留当前|当前.*保留|清空视野|一键清空视野|keep.*frontmost|except.*frontmost)/i.test(request),
        preserveFinder: true,
      },
      "Hiding app windows is a direct HER window task.",
    );
  }
  if (/(最小化|minimize).*(所有|全部|all).*(窗口|应用|app|windows?)|(所有|全部|all).*(窗口|应用|app|windows?).*(最小化|minimize)/i.test(request)) {
    return readyRouteStep("native", "Minimize all windows", "window_minimize_all", {}, "Minimizing all windows is a direct HER window task.");
  }
  if (/(关闭|关掉|close).*(窗口|windows?)|(窗口|windows?).*(关闭|关掉|close)/i.test(request) && appName) {
    return readyRouteStep("native", `Close ${appName} window`, "window_close", { appName }, "Closing a window should use HER's window tool instead of quitting the app.");
  }
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
  if (/(排列|平铺|整理|布局).*(窗口|windows?)|(窗口|windows?).*(排列|平铺|整理|布局)/i.test(request)) {
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

const hostMatches = (rawUrl: string, matcher: (host: string) => boolean) => {
  try {
    const parsed = new URL(rawUrl);
    return matcher(parsed.hostname.replace(/^www\./, "").toLowerCase());
  } catch {
    return false;
  }
};

const isYouTubeUrl = (url: string) => hostMatches(url, (host) => host === "youtu.be" || host === "youtube.com" || host.endsWith(".youtube.com"));
const isBilibiliUrl = (url: string) => hostMatches(url, (host) => host === "b23.tv" || host === "bilibili.com" || host.endsWith(".bilibili.com"));
const isNeteaseUrl = (url: string) => hostMatches(url, (host) => host === "music.163.com" || host.endsWith(".music.163.com"));
const isXiaohongshuUrl = (url: string) => hostMatches(url, (host) => host === "xiaohongshu.com" || host.endsWith(".xiaohongshu.com") || host === "xhslink.com" || host.endsWith(".xhslink.com"));

const isAppleTvRequest = (request: string) => /(apple\s*tv|苹果\s*tv|苹果电视|\bTV\s*app\b|电视\s*app)/i.test(request);
const isSpotifyRequest = (request: string) => /spotify/i.test(request);
const isNeteaseRequest = (request: string) => /(网易云|网易云音乐|net\s*ease|netease)/i.test(request);
const isQqMusicRequest = (request: string) => /(qq\s*音乐|qqmusic|qq music|QQ音乐)/i.test(request);
const isOnlyOpeningYouTubeSite = (request: string) =>
  /^(请|麻烦|帮我|帮忙|please)?\s*(打开|启动|open|launch)\s*(youtube|you\s*tube|油管)\s*[。.!！]?\s*$/i.test(request.trim());
const isYouTubeRequest = (request: string) =>
  !isOnlyOpeningYouTubeSite(request) &&
  /(youtube|you\s*tube|油管|\byt\b)/i.test(request) &&
  /(视频|影片|播放|观看|看|打开|搜索|搜|找|video|watch|play|open|search|find)/i.test(request);
const isBilibiliRequest = (request: string) => /(bilibili|哔哩哔哩|哔哩|b站|B站)/i.test(request);
const isXiaohongshuRequest = (request: string) => /(小红书|xiaohongshu|xhs)/i.test(request);
const isXSearchRequest = (request: string) => /(\bX\b|twitter|tweet|推特)/i.test(request) && /(搜索|搜|查|找|search|find|read|看)/i.test(request) && !isXPostRequest(request);
const isXPostRequest = (request: string) => /(\bX\b|twitter|tweet|推特)/i.test(request) && /(发|发布|发帖|post|tweet|publish)/i.test(request);
const isNewsRequest = (request: string) => /(新闻|资讯|头条|报道|news|headline)/i.test(request);
const isMarketQuoteRequest = (request: string) => /(股价|行情|报价|股票|ticker|quote|price|market)/i.test(request) && !isNewsRequest(request);
const isSecFilingRequest = (request: string) => /(sec|edgar|10-k|10-q|8-k|form\s*4|公告|财报|filing|年报|季报)/i.test(request);
const isMacroSeriesRequest = (request: string) => /(bls|cpi|通胀|失业率|非农|宏观|macro|inflation|unemployment|payroll|series)/i.test(request);

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

const musicRequestMode = (request: string): "play" | "search" =>
  /(搜索|搜|找|打开|show|search|find|open)/i.test(request) && !/(播放|放一下|放|听|听一下|play)/i.test(request) ? "search" : "play";

const spotifyRequestMode = (request: string): "play" | "search" =>
  /(搜索|搜|找|打开|show|search|find|open)/i.test(request) && !/(播放|放一下|放|听|听一下|play)/i.test(request) ? "search" : "play";

const videoRequestMode = (request: string): "play" | "search" =>
  /(搜索|搜|找|打开|show|search|find|open)/i.test(request) && !/(播放|放一下|放|看|观看|play|watch)/i.test(request) ? "search" : "play";

const youtubeRequestMode = (request: string): "play" | "search" =>
  /(搜索|搜|找|search|find|show)/i.test(request) ? "search" : "play";

const extractMusicQuery = (request: string) => {
  const stripped = request
    .replace(/^(请|麻烦|帮我|帮忙|please)\s*/i, "")
    .replace(/(用|在)?\s*(apple\s*music|music\s*app|music|音乐)\s*(里|上)?/gi, "")
    .replace(/(播放|放一下|放|听一下|听|打开|open|play)\s*/gi, "")
    .trim();
  return stripped || request.trim();
};

const extractMusicServiceQuery = (request: string, service: "spotify" | "netease" | "qq") => {
  const servicePattern =
    service === "spotify"
      ? /(spotify)/gi
      : service === "netease"
        ? /(网易云音乐|网易云|net\s*ease|netease)/gi
        : /(qq\s*音乐|qqmusic|qq music|QQ音乐)/gi;
  const stripped = request
    .replace(/^(请|麻烦|帮我|帮忙|please)\s*/i, "")
    .replace(/(用|在|打开)\s*/gi, "")
    .replace(servicePattern, "")
    .replace(/(客户端|应用|app)\s*/gi, "")
    .replace(/(里|上|中)?\s*(搜索|搜一下|搜|找|播放|放一下|放|听一下|听|打开|启动|open|launch|play|search|find)\s*/gi, "")
    .trim();
  return stripped || (service === "spotify" ? request.trim() : "");
};

const qqMusicTarget = (request: string): "app" | "web" =>
  /(网页|浏览器|web|website|browser)/i.test(request) ? "web" : "app";

const inferMediaKeyAction = (request: string): "play_pause" | "next" | "previous" | "volume_up" | "volume_down" | undefined => {
  if (/(下一首|下首|next)/i.test(request)) return "next";
  if (/(上一首|上首|previous|prev)/i.test(request)) return "previous";
  if (/(暂停|继续|播放.?暂停|暂停.?播放|play.?pause|pause|resume)/i.test(request)) return "play_pause";
  if (/(音量).*(大|提高|增加|up)|volume.?up/i.test(request)) return "volume_up";
  if (/(音量).*(小|降低|减少|down)|volume.?down/i.test(request)) return "volume_down";
  return undefined;
};

const inferScreenshotMode = (request: string): "clipboard" | "desktop" | "selection" | undefined => {
  if (!/(截图|截屏|screenshot|screencapture)/i.test(request)) return undefined;
  if (/(剪贴板|clipboard)/i.test(request)) return "clipboard";
  if (/(选择|区域|selection|interactive)/i.test(request)) return "selection";
  return "desktop";
};

const inferSettingsPane = (request: string): string | undefined => {
  if (!/(系统设置|设置|settings)/i.test(request)) return undefined;
  if (/(蓝牙|bluetooth)/i.test(request)) return "bluetooth";
  if (/(wi-?fi|无线|网络)/i.test(request)) return "wifi";
  if (/(声音|音频|sound|audio)/i.test(request)) return "sound";
  if (/(显示器|显示|屏幕|display)/i.test(request)) return "displays";
  if (/(键盘|keyboard)/i.test(request)) return "keyboard";
  if (/(辅助功能|accessibility)/i.test(request)) return "accessibility";
  if (/(麦克风|microphone)/i.test(request)) return "microphone";
  if (/(隐私|privacy)/i.test(request)) return "privacy";
  return "system";
};

type KeyboardShortcutAction =
  | "copy"
  | "paste"
  | "select_all"
  | "undo"
  | "enter"
  | "escape"
  | "tab"
  | "new_window"
  | "new_tab"
  | "refresh"
  | "browser_back"
  | "browser_forward"
  | "toggle_fullscreen";

const inferKeyboardShortcutAction = (request: string): KeyboardShortcutAction | undefined => {
  if (/(新建窗口|new\s*window)/i.test(request)) return "new_window";
  if (/(新建标签|新标签|new\s*tab)/i.test(request)) return "new_tab";
  if (/(切换全屏|toggle\s*fullscreen)/i.test(request)) return "toggle_fullscreen";
  if (/(浏览器)?.*(后退|back)/i.test(request)) return "browser_back";
  if (/(浏览器)?.*(前进|forward)/i.test(request)) return "browser_forward";
  if (/(刷新|refresh|reload)/i.test(request)) return "refresh";
  if (/(全选|select\s*all)/i.test(request)) return "select_all";
  if (/(撤销|undo)/i.test(request)) return "undo";
  if (/(复制|copy)/i.test(request) && !/(复制到剪贴板|剪贴板.*写入)/i.test(request)) return "copy";
  if (/(粘贴|paste)/i.test(request)) return "paste";
  if (/(回车|enter)/i.test(request)) return "enter";
  if (/(escape|esc|退出键)/i.test(request)) return "escape";
  if (/(tab|制表)/i.test(request)) return "tab";
  return undefined;
};

const extractSpeakRequest = (request: string) => {
  if (!/(朗读|念一下|读出来|speak|say\b)/i.test(request)) return undefined;
  const text = request
    .replace(/^(请|麻烦|帮我|帮忙|please)\s*/i, "")
    .replace(/(用中文声音|用中文|中文声音|Tingting|婷婷)/gi, "")
    .replace(/(朗读|念一下|读出来|speak|say)\s*/gi, "")
    .trim();
  if (!text) return undefined;
  return { text, ...(/(中文声音|Tingting|婷婷)/i.test(request) ? { voice: "Tingting" } : {}) };
};

const extractNotificationRequest = (request: string) => {
  if (!/(通知|提醒我一下|弹窗|dialog|notification)/i.test(request)) return undefined;
  const dialog = /(弹窗|dialog|确认框)/i.test(request);
  const message = request
    .replace(/^(请|麻烦|帮我|帮忙|please)\s*/i, "")
    .replace(/(显示|发一个|发送|弹出|展示)?\s*(系统)?\s*(通知|弹窗|dialog|notification)\s*/gi, "")
    .trim();
  if (!message) return undefined;
  return { title: "HER", message, dialog };
};

const extractVideoServiceQuery = (request: string, service: "bilibili" | "youtube") => {
  const servicePattern = service === "bilibili" ? /(bilibili|哔哩哔哩|哔哩|b站|B站)/gi : /(youtube|you\s*tube|油管|\byt\b)/gi;
  const stripped = request
    .replace(/^(请|麻烦|帮我|帮忙|please)\s*/i, "")
    .replace(/(用|在|打开)\s*/gi, "")
    .replace(servicePattern, "")
    .replace(/(里|上|中)?\s*(搜索|搜一下|搜|找|播放|放一下|放|看|观看|打开|open|play|watch|search|find)\s*/gi, "")
    .trim();
  return stripped || request.trim();
};

const extractSocialQuery = (request: string, service: "x" | "xiaohongshu") => {
  const servicePattern = service === "x" ? /(\bX\b|twitter|tweet|推特)/gi : /(小红书|xiaohongshu|xhs)/gi;
  const stripped = request
    .replace(/^(请|麻烦|帮我|帮忙|please)\s*/i, "")
    .replace(servicePattern, "")
    .replace(/(上|里|中)?\s*(搜索|搜一下|搜|查|找|打开|看|open|search|find|read)\s*/gi, "")
    .trim();
  return stripped || request.trim();
};

const extractXPostText = (request: string) => {
  const stripped = request
    .replace(/^(请|麻烦|帮我|帮忙|please)\s*/i, "")
    .replace(/(在|到|发到|发布到)?\s*(\bX\b|twitter|推特)\s*(上|里)?/gi, "")
    .replace(/(发帖|发布|发一条|发|post|tweet|publish)\s*/gi, "")
    .trim();
  return stripped || request.trim();
};

const extractNewsQuery = (request: string) => {
  const stripped = request
    .replace(/^(请|麻烦|帮我|帮忙|please)\s*/i, "")
    .replace(/(搜索|搜一下|搜|查|找|看|最新|相关新闻|新闻|资讯|头条|报道|search|find|latest|news|headlines?)\s*/gi, "")
    .trim();
  return stripped || request.trim();
};

const extractTickerSymbol = (request: string) => {
  const explicit = /\b[A-Z]{1,5}(?:\.[A-Z])?\b/.exec(request)?.[0];
  if (explicit && !["SEC", "BLS", "CPI"].includes(explicit)) return explicit;
  const chineseKnown: Array<[RegExp, string]> = [
    [/苹果|apple/i, "AAPL"],
    [/微软|microsoft/i, "MSFT"],
    [/英伟达|nvidia/i, "NVDA"],
    [/特斯拉|tesla/i, "TSLA"],
    [/谷歌|alphabet|google/i, "GOOGL"],
    [/亚马逊|amazon/i, "AMZN"],
    [/meta|facebook/i, "META"],
    [/ibm/i, "IBM"],
  ];
  return chineseKnown.find(([pattern]) => pattern.test(request))?.[1] ?? request.trim();
};

const extractSecCompany = (request: string) => {
  const explicit = /\b[A-Z]{1,5}(?:\.[A-Z])?\b/.exec(request)?.[0];
  if (explicit && !["SEC", "EDGAR"].includes(explicit)) return explicit;
  return extractTickerSymbol(request);
};

const extractSecForms = (request: string) => {
  const forms = new Set<string>();
  for (const match of request.matchAll(/\b(?:10-K|10-Q|8-K|S-1|DEF\s*14A|FORM\s*4|4)\b/gi)) {
    const form = match[0].toUpperCase().replace(/\s+/g, " ");
    forms.add(form === "FORM 4" ? "4" : form);
  }
  if (/年报/i.test(request)) forms.add("10-K");
  if (/季报/i.test(request)) forms.add("10-Q");
  return [...forms];
};

const extractMacroSeriesId = (request: string) => {
  const explicit = /\b[A-Z]{2,}[A-Z0-9]{3,}\b/.exec(request)?.[0];
  if (explicit && !["CPI", "BLS", "SEC"].includes(explicit)) return explicit;
  if (/失业率|unemployment/i.test(request)) return "LNS14000000";
  if (/非农|payroll/i.test(request)) return "CES0000000001";
  if (/cpi|通胀|inflation/i.test(request)) return "CUSR0000SA0";
  return "CUSR0000SA0";
};

const extractYear = (request: string, position: "start" | "end") => {
  const years = [...request.matchAll(/\b(20\d{2}|19\d{2})\b/g)].map((match) => match[1]);
  if (position === "start") return years[0];
  return years[1] ?? years[0];
};

const appleTvRequestMode = (request: string): "play" | "search" =>
  /(搜索|搜|找|打开|show|search|find|open)/i.test(request) && !/(播放|看|play|watch)/i.test(request) ? "search" : "play";

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
  return readyRouteStep(
    "codex",
    "Run Codex background task",
    "coding_agent_start",
    {
      prompt,
      ...(input.cwd || pathAlias?.value ? { repoPath: input.cwd ?? pathAlias?.value } : {}),
      mode: "patch",
    },
    "Complex project, code, test, or multi-step analysis should run through HER's Codex runtime.",
    "high",
  );
};

const buildCodexIntentRouteStep = (
  intent: StandardIntent,
  input: IntentRouteInput,
  memoryMatches: Array<{ id: string; type: MemoryType; key: string; value?: string; summary: string }>,
): RouteStep => {
  if (!config.codexEnabled) {
    return {
      provider: "codex",
      status: "not_implemented",
      title: "Codex background runtime unavailable",
      reason: "HER Codex provider is disabled. HER will not fall back to another provider or pretend the task ran.",
      arguments: { intent },
    };
  }
  const request = intent.originalText.trim();
  const pathAlias = memoryMatches.find((item) => item.type === "path_alias" && item.value);
  const now = new Date();
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const prompt = `HER Realtime parsed this user request into StandardIntent JSON.

Use this structured intent as the source of truth. If HER tools should be executed, request them only through the HER Tool Gateway JSON block described in your instructions.
Current HER runtime time: ${now.toISOString()}
Current HER runtime timezone: ${timezone}
For relative dates such as "tomorrow", prefer the parsed date/time in StandardIntent.entities. If a needed time is missing for a write action, ask for clarification instead of inventing a precise appointment time.
If HER exposes a tool that can materially advance this complex intent, your final answer must include a HER Tool Gateway request instead of only a prose plan. For travel arrangement intents with a destination and date, at minimum request weather_lookup for the destination/date. Request Calendar, Reminders, or Notes only when the StandardIntent or original request contains enough concrete details for that write; otherwise ask for clarification for missing details.
When the original request includes reminder language such as "提醒", "remind", "记得", or "todo" and the reminder title/content is clear, request mac_reminder_create. The dueAt field is optional; do not omit a reminder just because the user did not give a precise reminder time.
When the original request asks to write/create/save a note or "写到Notes/笔记", request mac_note_create if the note title and body can be derived from the request and available context.
When the original request asks to create/schedule a calendar event and includes a title plus start time, request mac_calendar_create. If end time is missing, default to one hour after start. Do not ask for location, notes, attendees, or calendar name unless the user explicitly cares.
When the original request says the sound is too loud/noisy, asks to be quieter, or asks to lower volume, request system_set_volume. If no exact percentage is supplied, choose a conservative value between 20 and 30.
When the original request asks to draft an email for the user to see in the mail app, request mac_mail_draft_create if a concrete recipient email address is present. Use email_draft only for local HER draft-record tests or when the user explicitly asks for a local HER draft record. If the user only names a person/title without an address, ask for the recipient email address and do not request either draft tool.
When the original request asks to search local email, request email_search. Only request email_read when the request or context already includes a concrete email/draft id; HER Tool Gateway requests cannot depend on the future result of email_search inside the same final block.
When a family/personal event request is vague, such as a birthday or return-home event with only "安排一下/准备一下", ask a brief clarifying question instead of inventing calendar times, reminders, notes, or email recipients.
When the original request explicitly asks to use CLI, command line, shell, terminal, or "命令行", request advanced_shell_command through HER Tool Gateway for the command. Do not satisfy explicit local CLI requests only with Codex-native shell output. For advanced_shell_command, include arguments.command and arguments.reason; the Gateway request's outer reason is not a substitute for arguments.reason.
If a request says to create or transform a file with CLI and then open it in an app, use advanced_shell_command only for the CLI file creation/transformation, then request file_open for opening the resulting file. Do not hide app opening inside the shell command unless no HER file/app tool exists.
When a later HER tool depends on a file or state created by an earlier HER tool, set a conservative runAfterMs on the dependent request or split the work so the second tool does not race the first.

StandardIntent:
${JSON.stringify(intent, null, 2)}

Original request:
${request}`;

  return readyRouteStep(
    "codex",
    "Run Codex for complex intent",
    "coding_agent_start",
    {
      prompt,
      ...(input.cwd || pathAlias?.value ? { repoPath: input.cwd ?? pathAlias?.value } : {}),
      mode: "patch",
    },
    "Complex Realtime intent should run through HER's Codex runtime, with any side effects requested through HER Tool Gateway.",
    "high",
  );
};

const clarifyStep = (title: string, reason: string): RouteStep => ({
  provider: "native",
  status: "needs_clarification",
  title,
  reason,
});

const providerForTool = (toolName: ToolName): RouteProvider => {
  const group = toolGroupLookup[toolName];
  if (group === "browser") return "browser";
  if (group === "phone") return "phone";
  if (group === "agents") return "codex";
  return "native";
};

const readStringEntity = (intent: StandardIntent, key: string) => {
  const value = intent.entities?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
};

const readStringArrayEntity = (intent: StandardIntent, key: string) => {
  const value = intent.entities?.[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim());
};

const readNumberEntity = (intent: StandardIntent, key: string) => {
  const value = intent.entities?.[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value.replace(/%/g, "").trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
};

const readBooleanEntity = (intent: StandardIntent, key: string) => {
  const value = intent.entities?.[key];
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (/^(true|yes|1)$/i.test(value.trim())) return true;
    if (/^(false|no|0)$/i.test(value.trim())) return false;
  }
  return undefined;
};

const readStringArgument = (args: Record<string, unknown> | undefined, key: string) => {
  const value = args?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
};

const normalizeVideoServiceName = (value: unknown): "youtube" | "apple_tv" | "bilibili" | undefined => {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (/^(youtube|you_tube|yt|油管)$/i.test(normalized)) return "youtube";
  if (/^(apple_tv|tv|苹果_tv|苹果电视)$/i.test(normalized)) return "apple_tv";
  if (/^(bilibili|bili|b站|哔哩|哔哩哔哩)$/i.test(normalized)) return "bilibili";
  return undefined;
};

const normalizeVideoMode = (service: "youtube" | "apple_tv" | "bilibili", request: string, value: unknown): "play" | "search" => {
  const mode = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (service === "youtube") {
    if (/(搜索|搜|找|search|find|show)/i.test(request)) return "search";
    if (/(打开|播放|放|看|观看|open|play|watch)/i.test(request)) return "play";
  }
  if (mode === "search" || mode === "play") return mode;
  return service === "youtube" ? youtubeRequestMode(request) : videoRequestMode(request);
};

const cleanVideoQuery = (query: string) =>
  query
    .replace(/\bsite:\s*(www\.)?(youtube\.com|youtu\.be)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();

const readIntentVideoQuery = (intent: StandardIntent) => {
  const args = intent.toolArguments ?? {};
  const query =
    readStringArgument(args, "query") ??
    readStringArgument(args, "title") ??
    readStringArgument(args, "searchQuery") ??
    readStringEntity(intent, "query") ??
    readStringEntity(intent, "title") ??
    readStringEntity(intent, "searchQuery") ??
    readStringEntity(intent, "keyword");
  return query ? cleanVideoQuery(query) : undefined;
};

const normalizeIntentVideoPlayArguments = (intent: StandardIntent) => {
  const args = intent.toolArguments ?? {};
  const service =
    normalizeVideoServiceName(args.service) ??
    normalizeVideoServiceName(args.platform) ??
    normalizeVideoServiceName(readStringEntity(intent, "service")) ??
    normalizeVideoServiceName(readStringEntity(intent, "platform")) ??
    normalizeVideoServiceName(readStringEntity(intent, "site"));
  const query = readIntentVideoQuery(intent);
  if (!service || !query) return undefined;
  return {
    service,
    query,
    mode: normalizeVideoMode(service, intent.originalText, args.mode ?? readStringEntity(intent, "mode")),
  };
};

const buildYouTubeIntentRouteStep = (intent: StandardIntent): RouteStep | undefined => {
  const service =
    normalizeVideoServiceName(readStringEntity(intent, "service")) ??
    normalizeVideoServiceName(readStringEntity(intent, "platform")) ??
    normalizeVideoServiceName(readStringEntity(intent, "site"));
  const text = `${intent.originalText} ${intent.intent} ${intent.action ?? ""}`;
  if (service !== "youtube" && !/(youtube|you\s*tube|油管|\byt\b)/i.test(text)) return undefined;
  if (!/(视频|影片|播放|观看|看|打开|搜索|搜|找|video|watch|play|open|search|find)/i.test(text)) return undefined;

  const query = readIntentVideoQuery(intent);
  if (!query || /^(youtube|you\s*tube|油管)$/i.test(query)) return undefined;
  return readyRouteStep(
    "native",
    "Open YouTube video",
    "video_play",
    { service: "youtube", query, mode: youtubeRequestMode(intent.originalText) },
    "Realtime described a YouTube video request even though the domain was browser. HER routes it to the video workflow.",
  );
};

const defaultCalendarEnd = (start: string | undefined) => {
  if (!start) return undefined;
  const startDate = new Date(start);
  if (!Number.isFinite(startDate.getTime())) return undefined;
  return new Date(startDate.getTime() + 60 * 60 * 1000).toISOString();
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

const titleForTask = (name: ToolName) =>
  name
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");

const extractCodingAgentTaskId = (result: unknown) => {
  if (!result || typeof result !== "object" || Array.isArray(result)) return undefined;
  const task = (result as { task?: unknown }).task;
  if (!task || typeof task !== "object" || Array.isArray(task)) return undefined;
  const id = (task as { id?: unknown }).id;
  return typeof id === "string" ? id : undefined;
};

const herTaskStatuses = new Set(["queued", "running", "awaiting_confirmation", "completed", "failed", "cancelled", "blocked"]);
const legacyTaskStatuses = new Set(["queued", "running", "completed", "failed", "cancelled", "needs_confirmation"]);

const isHerTaskStatus = (status: unknown): status is HerTaskStatus =>
  typeof status === "string" && herTaskStatuses.has(status);

const isLegacyTaskStatus = (status: unknown): status is TaskStatus =>
  typeof status === "string" && legacyTaskStatuses.has(status);
