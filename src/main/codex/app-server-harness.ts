import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { createInterface } from "node:readline";
import { config } from "../config";
import { AuditLog } from "../audit";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

type RpcRequest = {
  id?: number | string;
  method: string;
  params?: JsonValue;
};

type RpcResponse = {
  id: number | string;
  result?: JsonValue;
  error?: {
    code?: number;
    message: string;
    data?: JsonValue;
  };
};

type PendingRequest = {
  method: string;
  resolve: (value: JsonValue | undefined) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
};

export type CodexTaskSandbox = "read_only" | "workspace_write";

export type CodexTaskInput = {
  prompt: string;
  cwd?: string;
  model?: string;
  sandbox?: CodexTaskSandbox;
  timeoutMs?: number;
  onProgress?: (event: CodexProgressEvent) => void;
};

export type CodexProgressEvent = {
  at: string;
  source: "codex";
  status: "running" | "warning" | "ok" | "error";
  summary: string;
  method?: string;
};

export type CodexTaskResult = {
  provider: "codex";
  threadId?: string;
  turnId?: string;
  status: "completed" | "failed";
  finalText: string;
  eventCounts: Record<string, number>;
  diagnostics?: string[];
  cwd: string;
  sandbox: CodexTaskSandbox;
};

const DEFAULT_REQUEST_TIMEOUT_MS = 60000;

const codexDeveloperInstructions = () => [
  "You are running as HER's background Codex runtime. Report progress and results as HER, not as Codex.",
  "Do not attempt to control macOS, desktop apps, media, browser, phone, calendar, reminders, or notes directly with shell, AppleScript, MCP, plugins, or computer-use when HER exposes a matching local tool.",
  "For HER local actions, request execution only through HER Tool Gateway by including exactly one final <her_tool_gateway> JSON block. HER will validate tool names, arguments, permissions, confirmations, and enabled groups before anything executes.",
  "HER Tool Gateway block format: <her_tool_gateway>{\"requests\":[{\"toolName\":\"tool_name\",\"arguments\":{},\"priority\":\"normal\",\"reason\":\"why this HER tool is needed\"}]}</her_tool_gateway>.",
  "Do not claim HER tool requests executed. Say they are being requested through HER Gateway; HER will queue or confirm them after your turn.",
  config.codexNativeToolsFallback
    ? "If HER's exposed tool namespace lacks a provider for a non-side-effecting research or code step, you may use Codex-native tools, MCP servers, or plugins already available inside this Codex runtime. Treat these as Codex-native fallback tools, not HER tool execution. If a needed native tool is unavailable or blocked, report that explicitly instead of pretending the action completed."
    : "Do not use Codex-native tools, MCP servers, plugins, or Computer Use as a fallback. If HER's exposed tool namespace lacks a provider, report the missing provider explicitly.",
  "Do not perform purchases, bookings, publishing, sending, deleting, calling, or other irreversible actions through fallback tools. Return a plan or ask HER/user for confirmation instead.",
].join(" ");

export class CodexAppServerHarness {
  constructor(private audit: AuditLog) {}

  async runTask(input: CodexTaskInput): Promise<CodexTaskResult> {
    if (!config.codexEnabled) {
      throw new Error("Codex provider is disabled. Set HER_CODEX_ENABLED=true to enable it.");
    }

    const cwd = path.resolve(input.cwd || process.cwd());
    const sandbox = input.sandbox ?? "read_only";
    const timeoutMs = input.timeoutMs ?? config.codexTurnTimeoutMs;
    const model = input.model || config.codexModel || undefined;
    const client = new CodexAppServerClient(this.audit, { cwd });
    const eventCounts: Record<string, number> = {};
    const deltaTextParts: string[] = [];
    const completedTextParts: string[] = [];
    const diagnostics: string[] = [];
    let threadId: string | undefined;
    let turnId: string | undefined;
    let completedStatus: "completed" | "failed" = "completed";

    this.audit.write({
      action: "codex.task",
      summary: "Starting Codex app-server task",
      status: "started",
      details: {
        cwd,
        sandbox,
        model: model ?? "[app-server-default]",
        timeoutMs,
      },
    });

    try {
      await client.start();
      input.onProgress?.({
        at: new Date().toISOString(),
        source: "codex",
        status: "running",
        summary: "HER 已启动后台 Codex 任务",
      });
      client.onNotification((method, params) => {
        eventCounts[method] = (eventCounts[method] ?? 0) + 1;
        const text = extractNotificationText(method, params);
        if (text && method === "item/agentMessage/delta") deltaTextParts.push(text);
        else if (text) completedTextParts.push(text);
        const diagnostic = extractDiagnosticText(method, params);
        if (diagnostic) diagnostics.push(diagnostic);
        if (method === "turn/completed") {
          const status = readNestedString(params, ["turn", "status"]) ?? readStringProp(params, "status");
          if (status && !/completed|succeeded|success/i.test(status)) completedStatus = "failed";
        }
        this.audit.write({
          action: "codex.event",
          summary: `Codex event ${method}`,
          status: method === "turn/completed" ? "ok" : "running",
          details: compactCodexEvent(method, params),
        });
        const progress = projectCodexProgress(method, params);
        if (progress) input.onProgress?.(progress);
      });

      await client.initialize();
      const threadResponse = await client.request("thread/start", compactObject({
        cwd,
        model,
        sandbox: toCodexSandbox(sandbox),
        approvalPolicy: "never",
        developerInstructions: codexDeveloperInstructions(),
      }));
      threadId = readNestedString(threadResponse, ["thread", "id"]);
      if (!threadId) throw new Error("Codex thread/start did not return thread.id.");

      const turnResponse = await client.request("turn/start", compactObject({
        threadId,
        cwd,
        input: [{ type: "text", text: input.prompt }],
        approvalPolicy: "never",
      }), { timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS });
      turnId = readNestedString(turnResponse, ["turn", "id"]);
      if (!turnId) throw new Error("Codex turn/start did not return turn.id.");

      await client.waitForNotification(
        (method, params) => {
          if (method !== "turn/completed") return false;
          const eventThreadId = readNestedString(params, ["turn", "threadId"]) ?? readStringProp(params, "threadId");
          const eventTurnId = readNestedString(params, ["turn", "id"]) ?? readStringProp(params, "turnId");
          return (!eventThreadId || eventThreadId === threadId) && (!eventTurnId || eventTurnId === turnId);
        },
        timeoutMs,
        "turn/completed",
      );

      const finalText = normalizeFinalText(deltaTextParts, completedTextParts);
      this.audit.write({
        action: "codex.task",
        summary: `Codex task ${completedStatus}`,
        status: completedStatus === "completed" ? "ok" : "error",
        details: { threadId, turnId, eventCounts, finalText, diagnostics },
      });
      return {
        provider: "codex",
        threadId,
        turnId,
        status: completedStatus,
        finalText,
        eventCounts,
        ...(diagnostics.length ? { diagnostics } : {}),
        cwd,
        sandbox,
      };
    } finally {
      await client.close();
    }
  }
}

class CodexAppServerClient {
  private child?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<number | string, PendingRequest>();
  private notificationHandlers = new Set<(method: string, params: JsonValue | undefined) => void>();
  private stderrTail = "";

  constructor(
    private audit: AuditLog,
    private options: { cwd: string },
  ) {}

  async start() {
    this.child = spawn(config.codexCommand, config.codexArgs, {
      cwd: this.options.cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const lines = createInterface({ input: this.child.stdout });
    lines.on("line", (line) => this.handleLine(line));
    this.child.stderr.on("data", (chunk: Buffer | string) => {
      const text = chunk.toString("utf8");
      this.stderrTail = `${this.stderrTail}${text}`.slice(-2000);
      const trimmed = text.trim();
      if (trimmed) {
        this.audit.write({
          action: "codex.stderr",
          summary: trimmed.slice(0, 300),
          status: "running",
        });
      }
    });
    this.child.once("error", (error) => this.rejectAll(error));
    this.child.once("exit", (code, signal) => {
      if (this.pending.size === 0) return;
      this.rejectAll(new Error(`codex app-server exited with code ${code ?? "null"} signal ${signal ?? "null"}: ${this.stderrTail.trim()}`));
    });
  }

  async initialize() {
    await this.request("initialize", {
      clientInfo: {
        name: "her",
        title: "HER",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
      },
    });
    this.notify("initialized", {});
  }

  request(
    method: string,
    params?: JsonValue,
    options: { timeoutMs?: number } = {},
  ): Promise<JsonValue | undefined> {
    if (!this.child) return Promise.reject(new Error("codex app-server is not started"));
    const id = this.nextId++;
    const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const message: RpcRequest = { id, method, params };
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timeout.unref?.();
      this.pending.set(id, { method, resolve, reject, timeout });
      this.write(message);
    });
  }

  notify(method: string, params?: JsonValue) {
    this.write({ method, params });
  }

  onNotification(handler: (method: string, params: JsonValue | undefined) => void) {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  waitForNotification(
    predicate: (method: string, params: JsonValue | undefined) => boolean,
    timeoutMs: number,
    label: string,
  ) {
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out waiting for Codex ${label} after ${timeoutMs}ms`));
      }, timeoutMs);
      timeout.unref?.();
      const cleanup = this.onNotification((method, params) => {
        if (!predicate(method, params)) return;
        clearTimeout(timeout);
        cleanup();
        resolve();
      });
    });
  }

  async close() {
    const child = this.child;
    this.child = undefined;
    if (!child) return;
    child.stdin.end();
    if (child.exitCode !== null) return;
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
        resolve();
      }, 1000);
      timer.unref?.();
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private write(message: RpcRequest | RpcResponse) {
    if (!this.child) throw new Error("codex app-server is not started");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string) {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      this.audit.write({ action: "codex.parse", summary: trimmed.slice(0, 300), status: "error" });
      return;
    }
    if (!isObject(parsed)) return;
    if ("id" in parsed && (typeof parsed.id === "number" || typeof parsed.id === "string") && typeof parsed.method !== "string") {
      this.handleResponse(parsed as RpcResponse);
      return;
    }
    if ("id" in parsed && (typeof parsed.id === "number" || typeof parsed.id === "string") && typeof parsed.method === "string") {
      this.audit.write({
        action: "codex.request",
        summary: `Unhandled Codex server request ${parsed.method}`,
        status: "error",
        details: { method: parsed.method },
      });
      this.write({
        id: parsed.id,
        error: {
          code: -32601,
          message: `HER Codex harness does not expose a handler for ${parsed.method}`,
        },
      });
      return;
    }
    if (typeof parsed.method === "string") {
      const params = isJsonValue(parsed.params) ? parsed.params : undefined;
      for (const handler of this.notificationHandlers) handler(parsed.method, params);
    }
  }

  private handleResponse(response: RpcResponse) {
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    clearTimeout(pending.timeout);
    if (response.error) {
      pending.reject(new Error(`${pending.method} failed: ${response.error.message}`));
      return;
    }
    pending.resolve(response.result);
  }

  private rejectAll(error: Error) {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
  }
}

const toCodexSandbox = (sandbox: CodexTaskSandbox) =>
  sandbox === "workspace_write" ? "workspace-write" : "read-only";

const compactObject = (value: Record<string, JsonValue | undefined>): JsonValue =>
  Object.fromEntries(Object.entries(value).filter(([, item]) => typeof item !== "undefined")) as JsonValue;

const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const isJsonValue = (value: unknown): value is JsonValue => {
  if (value === null) return true;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (!isObject(value)) return false;
  return Object.values(value).every(isJsonValue);
};

const readStringProp = (value: JsonValue | undefined, key: string) => {
  if (!isObject(value)) return undefined;
  const item = value[key];
  return typeof item === "string" ? item : undefined;
};

const readNestedString = (value: JsonValue | undefined, pathParts: string[]) => {
  let current: unknown = value;
  for (const part of pathParts) {
    if (!isObject(current)) return undefined;
    current = current[part];
  }
  return typeof current === "string" ? current : undefined;
};

const extractNotificationText = (method: string, params: JsonValue | undefined) => {
  if (!/agentMessage|message|item\/completed/i.test(method)) return "";
  const direct = readStringProp(params, "text") ?? readStringProp(params, "delta");
  if (direct) return direct;
  const nested =
    readNestedString(params, ["item", "text"]) ??
    readNestedString(params, ["item", "message", "text"]) ??
    readNestedString(params, ["message", "text"]);
  return nested ?? "";
};

const extractDiagnosticText = (method: string, params: JsonValue | undefined) => {
  if (!/warning|error|failed/i.test(method)) return "";
  return (
    readStringProp(params, "message") ??
    readNestedString(params, ["error", "message"]) ??
    readNestedString(params, ["error", "data", "message"]) ??
    readNestedString(params, ["item", "message"]) ??
    readNestedString(params, ["item", "error", "message"]) ??
    ""
  ).slice(0, 1000);
};

const normalizeFinalText = (deltaParts: string[], completedParts: string[]) => {
  const text = (deltaParts.length ? deltaParts.join("") : completedParts.join("\n")).trim();
  return text || "Codex completed without a final text message.";
};

const compactCodexEvent = (method: string, params: JsonValue | undefined) => {
  const text = extractNotificationText(method, params);
  const diagnostic = extractDiagnosticText(method, params);
  return {
    method,
    text: text ? text.slice(0, 500) : undefined,
    diagnostic: diagnostic || undefined,
    itemType: readNestedString(params, ["item", "type"]) ?? readStringProp(params, "type"),
    threadId: readNestedString(params, ["turn", "threadId"]) ?? readStringProp(params, "threadId"),
    turnId: readNestedString(params, ["turn", "id"]) ?? readStringProp(params, "turnId"),
  };
};

const projectCodexProgress = (method: string, params: JsonValue | undefined): CodexProgressEvent | undefined => {
  if (method === "thread/started") return progress(method, "running", "HER 已建立后台任务线程");
  if (method === "turn/started") return progress(method, "running", "HER 正在处理后台任务");
  if (method === "item/started") return progress(method, "running", describeCodexItem(params, "HER 正在执行一个后台步骤"));
  if (method === "item/completed") return progress(method, "running", describeCodexItem(params, "HER 完成了一个后台步骤"));
  if (method === "item/agentMessage/delta") return progress(method, "running", "HER 正在整理结果");
  if (method === "thread/tokenUsage/updated") return progress(method, "running", "HER 更新了后台任务用量");
  if (method === "account/rateLimits/updated") return progress(method, "running", "HER 更新了后台限流状态");
  if (method === "warning") return progress(method, "warning", readStringProp(params, "message") ?? "HER 后台任务收到警告");
  if (method === "turn/completed") return progress(method, "ok", "HER 后台任务已完成");
  if (/error|failed/i.test(method)) return progress(method, "error", "HER 后台任务遇到错误");
  return undefined;
};

const progress = (
  method: string,
  status: CodexProgressEvent["status"],
  summary: string,
): CodexProgressEvent => ({
  at: new Date().toISOString(),
  source: "codex",
  status,
  summary,
  method,
});

const describeCodexItem = (params: JsonValue | undefined, fallback: string) => {
  const itemType = readNestedString(params, ["item", "type"]) ?? readStringProp(params, "type");
  if (!itemType) return fallback;
  if (/command|exec/i.test(itemType)) return "HER 正在运行后台命令";
  if (/file|patch|diff|edit/i.test(itemType)) return "HER 正在处理文件变更";
  if (/reason|analysis/i.test(itemType)) return "HER 正在分析任务";
  if (/agent|message/i.test(itemType)) return "HER 正在整理结果";
  return fallback;
};
