import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuditLog } from "../../src/main/audit";
import { ConfirmationQueue } from "../../src/main/tools/confirmation";
import { ToolRegistry } from "../../src/main/tools/registry";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("complex command routing", () => {
  it("routes complex coding intents to the Codex task runtime without executing side effects", async () => {
    const registry = createRegistry();
    const response = await registry.execute({
      name: "intent_route",
      source: "local",
      arguments: {
        intent: {
          originalText: "阅读这个 repo，找出 npm test 失败原因，修复并准备一个提交说明",
          intent: "fix failing tests in repository",
          complexity: "complex",
          domain: "coding",
          action: "fix_tests",
          entities: { repoPath: process.cwd() },
          confidence: 0.92,
          routePreference: "codex",
        },
        cwd: process.cwd(),
      },
    });

    const result = await readFullResult(registry, response) as RouteResult;
    expect(result.route).toBe("codex");
    expect(result.plan).toHaveLength(1);
    expect(result.plan[0]).toMatchObject({
      provider: "codex",
      status: "ready",
      toolName: "coding_agent_start",
      requiresConfirmation: true,
    });
    expect(result.plan[0].taskCreate).toMatchObject({
      toolName: "coding_agent_start",
      priority: "high",
    });
    expect(String(result.plan[0].taskCreate?.arguments?.prompt)).toContain("StandardIntent");
  });

  it("keeps ambiguous complex intents in clarification instead of guessing tools", async () => {
    const registry = createRegistry();
    const response = await registry.execute({
      name: "intent_route",
      source: "local",
      arguments: {
        intent: {
          originalText: "帮我把那个项目处理一下，顺便安排后面的事情",
          intent: "handle vague project",
          complexity: "ambiguous",
          domain: "unknown",
          action: "handle",
          missingInfo: ["target project", "desired outcome"],
          confidence: 0.33,
          routePreference: "clarify",
        },
      },
    });

    const result = await readFullResult(registry, response) as RouteResult;
    expect(result.route).toBe("native");
    expect(result.plan).toHaveLength(1);
    expect(result.plan[0]).toMatchObject({
      status: "needs_clarification",
      title: "Realtime intent needs clarification",
    });
    expect(result.nextAction).toBe("Ask one short clarification before queueing work.");
  });

  it("routes mixed research plus repository work to search context and Codex", async () => {
    const registry = createRegistry();
    const response = await registry.execute({
      name: "task_route",
      source: "local",
      arguments: {
        userRequest: "查官方文档确认 Vite 最新配置，然后修复这个 repo 的 build 问题",
        cwd: process.cwd(),
      },
    });

    const result = await readFullResult(registry, response) as RouteResult;
    expect(result.route).toBe("mixed");
    expect(result.plan).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provider: "search", status: "not_implemented" }),
        expect.objectContaining({
          provider: "codex",
          status: "ready",
          toolName: "coding_agent_start",
          requiresConfirmation: true,
        }),
      ]),
    );
    const codexStep = result.plan.find((step) => step.toolName === "coding_agent_start");
    expect(String(codexStep?.taskCreate?.arguments?.prompt)).toContain("HER-provided search summary");
  });

  it("queues complex realtime intents as managed tasks and does not run Codex inline", async () => {
    const registry = createRegistry();
    const response = await registry.execute({
      name: "intent_route",
      source: "realtime",
      arguments: {
        intent: {
          originalText: "重构 Tool Manifest，并修复相关测试",
          intent: "refactor tool manifest",
          complexity: "complex",
          domain: "coding",
          action: "refactor",
          confidence: 0.9,
          routePreference: "codex",
        },
      },
    });

    const result = expectOkResult(response) as RealtimeRouteResult;
    expect(result.mode).toBe("queued");
    expect(result.queuedTasks).toHaveLength(1);
    expect(result.queuedTasks[0]).toMatchObject({
      toolName: "coding_agent_start",
      requiresConfirmation: true,
    });
    expect(["queued", "running"]).toContain(result.queuedTasks[0].status);
    expect(result.nextAction).toBe("Tell the user HER is waiting for confirmation.");
  });
});

type ToolCallResult = Awaited<ReturnType<ToolRegistry["execute"]>>;

type RouteStep = {
  provider: string;
  status: string;
  title: string;
  toolName?: string;
  requiresConfirmation?: boolean;
  taskCreate?: {
    toolName: string;
    priority: string;
    arguments?: Record<string, unknown>;
  };
};

type RouteResult = {
  route: string;
  plan: RouteStep[];
  nextAction: string;
};

type RealtimeRouteResult = {
  mode: string;
  queuedTasks: Array<{
    toolName: string;
    status: string;
    requiresConfirmation: boolean;
  }>;
  nextAction: string;
};

const createRegistry = (confirmations = new ConfirmationQueue()) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "her-complex-command-test-"));
  tmpDirs.push(dir);
  return new ToolRegistry(confirmations, new AuditLog());
};

const expectOkResult = (response: ToolCallResult) => {
  expect(response.ok).toBe(true);
  if (!response.ok) throw new Error(response.error);
  expect(response).not.toHaveProperty("requiresConfirmation", true);
  return response.result;
};

const readFullResult = async (registry: ToolRegistry, response: ToolCallResult) => {
  const result = expectOkResult(response);
  if (!result || typeof result !== "object" || !("truncated" in result) || !("handle" in result)) return result;

  const handle = String((result as { handle: unknown }).handle);
  let offset = 0;
  let content = "";
  for (;;) {
    const chunkResponse = await registry.execute({
      name: "tool_result_read",
      source: "local",
      arguments: { handle, offset, maxChars: 6000 },
    });
    const chunk = expectOkResult(chunkResponse) as { content: string; hasMore: boolean; nextOffset?: number };
    content += chunk.content;
    if (!chunk.hasMore) break;
    offset = chunk.nextOffset ?? content.length;
  }
  return JSON.parse(content) as unknown;
};
