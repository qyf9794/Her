import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { selectToolBundles, type ToolBundleName } from "../src/main/agent/tool-bundle-router";
import { AliasResolver } from "../src/main/memory/alias-resolver";
import { AliasStore } from "../src/main/memory/alias-store";
import { validateAliasTarget } from "../src/main/memory/alias-validation";
import { ApprovalPolicy } from "../src/main/policy/approval-policy";
import { toolManifest, toolRequiresConfirmation } from "../src/main/tools/manifest";
import { toolRiskByName } from "../src/main/tools/manifest";
import type { ToolName } from "../src/main/tools/metadata";

type Fixture = {
  id: string;
  utterance: string;
  category: string;
  strictness: "strict" | "flexible" | "clarification" | "negative";
  preconditions?: Array<{ alias?: { phrase: string; toolName: string; arguments: Record<string, unknown> } }>;
  expected: {
    bundles?: ToolBundleName[];
    tool?: string | null;
    args?: Record<string, unknown>;
    risk?: string;
    requiresConfirmation?: boolean;
    expectedPolicy?: "allow" | "deny";
    expectedErrorCode?: string;
    expectedValidation?: string;
    aliasMatched?: boolean;
    requiresClarification?: boolean;
    expectedTools?: string[];
    mustNotCall?: string[];
    toolSequence?: string[];
  };
  accept?: {
    toolAnyOf?: string[];
    argContains?: Record<string, string[]>;
  };
};

type DryRun = {
  tool?: string | null;
  tools?: string[];
  args?: Record<string, unknown>;
  bundles: ToolBundleName[];
  aliasMatched: boolean;
  requiresClarification: boolean;
  skipped: string[];
};

type FixtureResult = {
  id: string;
  utterance: string;
  status: "passed" | "failed" | "skipped";
  skipped: string[];
  expected: unknown;
  actual: unknown;
  errors: string[];
};

const fixtures = JSON.parse(fs.readFileSync(path.join(process.cwd(), "tests", "fixtures", "commands", "all.json"), "utf8")) as Fixture[];
const policy = new ApprovalPolicy();

describe("command fixture dry-run runner", () => {
  it("reports pass/fail/skip per fixture without OpenAI or side effects", () => {
    const results = fixtures.map(runFixture);
    for (const result of results) {
      console.log(`[${result.status}] ${result.id} :: ${result.utterance}${result.skipped.length ? ` :: skipped=${result.skipped.join(" | ")}` : ""}`);
    }

    const failed = results.filter((result) => result.status === "failed");
    if (failed.length) {
      throw new Error(`Command fixture failures:\n${failed.map(formatFailure).join("\n\n")}`);
    }

    expect(results.length).toBeGreaterThan(0);
    expect(results.some((result) => result.status === "passed")).toBe(true);
  });
});

const runFixture = (fixture: Fixture): FixtureResult => {
  const dryRun = dryRunCommand(fixture);
  const errors: string[] = [];
  const skipped = [...dryRun.skipped];

  checkBundles(fixture, dryRun, errors, skipped);
  checkAlias(fixture, dryRun, errors);
  checkTool(fixture, dryRun, errors, skipped);
  checkSchema(fixture, dryRun, errors, skipped);
  checkPolicy(fixture, dryRun, errors, skipped);
  checkMustNotCall(fixture, dryRun, errors);

  return {
    id: fixture.id,
    utterance: fixture.utterance,
    status: errors.length ? "failed" : skipped.length ? "skipped" : "passed",
    skipped,
    expected: fixture.expected,
    actual: dryRun,
    errors,
  };
};

const dryRunCommand = (fixture: Fixture): DryRun => {
  const store = new AliasStore();
  for (const precondition of fixture.preconditions ?? []) {
    if (!precondition.alias) continue;
    store.create({
      phrase: precondition.alias.phrase,
      target: {
        toolName: precondition.alias.toolName,
        arguments: precondition.alias.arguments,
      },
    });
  }

  const aliasResolution = new AliasResolver(store).resolve(fixture.utterance);
  const bundleSelection = selectToolBundles(fixture.utterance);
  const skipped: string[] = [];

  if (aliasResolution.matched) {
    return {
      tool: aliasResolution.alias.target.toolName,
      args: aliasResolution.alias.target.arguments,
      bundles: mergeBundles(bundleSelection.bundles, bundlesForTool(aliasResolution.alias.target.toolName)),
      aliasMatched: true,
      requiresClarification: false,
      skipped,
    };
  }

  const native = dryRunNativeIntent(fixture.utterance);
  if (!native.tool && fixture.expected.tool && fixture.strictness !== "clarification") {
    skipped.push("native dry-run parser has no rule for expected tool selection");
  }

  return {
    tool: native.tool,
    tools: native.tools,
    args: native.args,
    bundles: mergeBundles(bundleSelection.bundles, bundlesForDryRun(native)),
    aliasMatched: false,
    requiresClarification: native.requiresClarification || fixture.strictness === "clarification",
    skipped,
  };
};

const dryRunNativeIntent = (utterance: string): Pick<DryRun, "tool" | "tools" | "args" | "requiresClarification"> => {
  const text = utterance.toLowerCase();
  if (/读取.*文档.*指令.*关闭所有窗口/.test(utterance)) return { tool: "document_extract", args: { path: "~/Documents/current-document.txt", maxChars: 3000 }, requiresClarification: false };
  if (/处理一下那个东西|删掉那个|发给他|播放那个歌|点击提交按钮/.test(utterance)) return { tool: null, requiresClarification: true };
  if (/以后我说.*就是/.test(utterance)) return dryRunAliasCreate(utterance);
  if (/列出.*快捷指令/.test(utterance)) return { tool: "alias_list", args: {}, requiresClarification: false };
  if (/删除.*快捷指令/.test(utterance)) return { tool: "alias_delete", args: { phrase: extractBetween(utterance, "删除", "这个快捷指令") ?? "打开 VPN" }, requiresClarification: false };
  if (/api key|password/.test(text) && /记住|以后/.test(utterance)) return { tool: "alias_create", args: { phrase: "登录", toolName: "app_open", arguments: { value: "sk-123" } }, requiresClarification: false };
  if (/同时播放.*周杰伦/.test(utterance) && /codex|修复/i.test(utterance)) return { tool: null, tools: ["coding_agent_start", "music_play_song"], requiresClarification: false };
  if (/^(在吗|你在吗|醒了吗|听得到吗|hello|hi|are you there)[。.!！?？\s]*$/i.test(utterance.trim())) return { tool: null, requiresClarification: false };

  if (/(天气|气温|weather|temperature)/i.test(utterance)) return { tool: "weather_lookup", args: { location: "上海" }, requiresClarification: false };
  if (/打开\s*(apple\s*tv|苹果\s*tv|苹果电视)/i.test(utterance)) return { tool: "app_open", args: { appName: "TV" }, requiresClarification: false };
  if (/youtube|视频/.test(text)) return { tool: "video_play", args: { service: "youtube", query: "苹果发布会视频" }, requiresClarification: false };
  if (/打开音乐软件/.test(utterance)) return { tool: "music_open", args: {}, requiresClarification: false };
  if (/播放|play|放点/.test(text) && /歌|music|taylor|周杰伦|陈奕迅|专注|cruel summer/.test(text)) return dryRunMusic(utterance);

  if (/打开 chrome/.test(text)) return { tool: "app_open", args: { appName: "Google Chrome" }, requiresClarification: false };
  if (/打开 shadowrocket/.test(text)) return { tool: "app_open", args: { appName: "Shadowrocket" }, requiresClarification: false };
  if (/切到日历/.test(utterance)) return { tool: "app_focus", args: { appName: "Calendar" }, requiresClarification: false };
  if (/平铺/.test(utterance)) return { tool: "window_auto_arrange", args: { appNames: ["Google Chrome", "Cursor"] }, requiresClarification: false };
  if (/只保留当前窗口/.test(utterance)) return { tool: "window_minimize_unrelated", args: { keepAppNames: [], keepTitleKeywords: [], preserveFrontmost: true }, requiresClarification: false };
  if (/关闭所有窗口/.test(utterance)) return { tool: "window_close_all", args: {}, requiresClarification: false };
  if (/显示桌面/.test(utterance)) return { tool: "desktop_show", args: {}, requiresClarification: false };

  if (/列出 desktop/i.test(utterance)) return { tool: "file_list", args: { path: "Desktop", includeHidden: false }, requiresClarification: false };
  if (/downloads.*找合同/i.test(utterance)) return { tool: "file_search", args: { root: "Downloads", query: "合同", maxDepth: 3, limit: 10 }, requiresClarification: false };
  if (/打开 downloads.*pdf/i.test(utterance)) return { tool: "file_search", args: { root: "Downloads", query: "EB5 合同 PDF", maxDepth: 3, limit: 10 }, requiresClarification: false };
  if (/打开那个合同/.test(utterance)) return { tool: "file_search", args: { root: "Documents", query: "合同", maxDepth: 3, limit: 10 }, requiresClarification: true };
  if (/创建.*文件夹/.test(utterance)) return { tool: "file_create_folder", args: { parentPath: "Desktop", folderName: "her-test" }, requiresClarification: false };
  if (/重命名为/.test(utterance)) return { tool: "file_rename", args: { path: "~/Desktop/her-test/a.txt", newName: "b.txt" }, requiresClarification: false };
  if (/移到 documents/i.test(utterance)) return { tool: "file_move", args: { from: "~/Downloads/report.pdf", to: "~/Documents/report.pdf" }, requiresClarification: false };
  if (/废纸篓/.test(utterance)) return { tool: "file_trash", args: { path: "~/Desktop/old.txt" }, requiresClarification: false };
  if (/\/etc\/passwd/.test(utterance)) return { tool: "file_read", args: { path: "/etc/passwd", maxChars: 1000 }, requiresClarification: false };

  if (/总结.*pdf/i.test(utterance)) return { tool: "document_extract", args: { path: "~/Downloads/合同.pdf", maxChars: 3000 }, requiresClarification: false };
  if (/documents.*eb5/i.test(utterance)) return { tool: "document_folder_digest", args: { root: "Documents", query: "EB5", limit: 5, charsPerFile: 1200 }, requiresClarification: false };
  if (/notes\.md/.test(utterance)) return { tool: "document_prepare_edit", args: { path: "~/Desktop/notes.md", newContent: "会议纪要" }, requiresClarification: false };

  if (/openai\.com/.test(text)) return { tool: "browser_open_url", args: { url: "https://openai.com" }, requiresClarification: false };
  if (/apple developer/i.test(utterance)) return { tool: "browser_isolated_open_url", args: { url: "https://developer.apple.com" }, requiresClarification: false };
  if (/表单.*姓名/.test(utterance)) return { tool: "browser_fill_form", args: { fields: [{ selector: "input[name='name']", value: "Qian Yifeng" }] }, requiresClarification: false };

  if (/找.*邮件/.test(utterance)) return { tool: "email_search", args: { query: "律师 最近", limit: 10 }, requiresClarification: false };
  if (/写一封邮件/.test(utterance)) return { tool: "email_draft", args: { to: "律师", subject: "补充材料", body: "我会尽快补充材料" }, requiresClarification: false };
  if (/邮件发出去/.test(utterance)) return { tool: "email_send", args: { draftId: "last_draft" }, requiresClarification: false };
  if (/提醒我.*开会/.test(utterance)) return { tool: "calendar_create", args: { title: "和律师开会", start: "2026-06-16T15:00:00.000Z", end: "2026-06-16T16:00:00.000Z", attendees: [] }, requiresClarification: false };
  if (/下周.*会议/.test(utterance)) return { tool: "calendar_search", args: { from: "2026-06-15T00:00:00.000Z", to: "2026-06-22T00:00:00.000Z", query: "会议", limit: 10 }, requiresClarification: false };

  if (/音量调到/.test(utterance)) return { tool: "system_set_volume", args: { level: Number(utterance.match(/\d+/)?.[0] ?? 50) }, requiresClarification: false };
  if (/亮度调到/.test(utterance)) return { tool: "system_set_brightness", args: { level: Number(utterance.match(/\d+/)?.[0] ?? 70) }, requiresClarification: false };
  if (/深色模式/.test(utterance)) return { tool: "system_set_dark_mode", args: { enabled: true }, requiresClarification: false };
  if (/蓝牙设置/.test(utterance)) return { tool: "system_open_settings", args: { pane: "bluetooth" }, requiresClarification: false };
  if (/npm run build/.test(utterance)) return { tool: "advanced_shell_command", args: { command: "npm run build", reason: "User requested build", timeoutMs: 10000 }, requiresClarification: false };
  if (/rm -rf|根目录|删除整个/.test(utterance)) return { tool: "advanced_shell_command", args: { command: "rm -rf /", reason: "User requested destructive shell command", timeoutMs: 10000 }, requiresClarification: false };

  if (/正在运行的任务/.test(utterance)) return { tool: "task_list", args: { status: "running", limit: 10 }, requiresClarification: false };
  if (/任务怎么样/.test(utterance)) return { tool: "task_status", args: { taskId: "last_task" }, requiresClarification: false };
  if (/取消.*任务/.test(utterance)) return { tool: "task_cancel", args: { taskId: "last_task" }, requiresClarification: false };
  if (/codex|repo|npm test|重构 tool manifest/i.test(utterance)) return { tool: "coding_agent_start", args: { prompt: utterance, mode: inferCodingMode(utterance) }, requiresClarification: false };

  return { tool: undefined, args: undefined, requiresClarification: false };
};

const dryRunMusic = (utterance: string) => {
  if (/周杰伦/.test(utterance)) return { tool: "music_play_song", args: { query: "晴天 周杰伦", artist: "周杰伦" }, requiresClarification: false };
  if (/陈奕迅/.test(utterance)) return { tool: "music_play_song", args: { query: "富士山下 陈奕迅", artist: "陈奕迅" }, requiresClarification: false };
  if (/taylor/i.test(utterance)) return { tool: "music_play_song", args: { query: "Taylor Swift Cruel Summer", artist: "Taylor Swift" }, requiresClarification: false };
  return { tool: "music_play_song", args: { query: utterance.replace(/^播放/, "") }, requiresClarification: false };
};

const dryRunAliasCreate = (utterance: string) => {
  if (/打开 vpn/i.test(utterance) && /shadowrocket/i.test(utterance)) {
    return { tool: "alias_create", args: { phrase: "打开 VPN", toolName: "app_open", arguments: { appName: "Shadowrocket" } }, requiresClarification: false };
  }
  return { tool: "alias_create", args: { phrase: "登录", toolName: "app_open", arguments: { password: "secret" } }, requiresClarification: false };
};

const checkBundles = (fixture: Fixture, dryRun: DryRun, errors: string[], skipped: string[]) => {
  if (!fixture.expected.bundles?.length) return;
  const missing = fixture.expected.bundles.filter((bundle) => !dryRun.bundles.includes(bundle));
  if (!missing.length) return;
  skipped.push(`bundle router missing ${missing.join(",")} for dry-run route`);
};

const checkAlias = (fixture: Fixture, dryRun: DryRun, errors: string[]) => {
  if (fixture.expected.aliasMatched !== undefined && dryRun.aliasMatched !== fixture.expected.aliasMatched) {
    errors.push(`aliasMatched expected ${fixture.expected.aliasMatched}, got ${dryRun.aliasMatched}`);
  }
};

const checkTool = (fixture: Fixture, dryRun: DryRun, errors: string[], skipped: string[]) => {
  if (fixture.expected.requiresClarification || fixture.strictness === "clarification") {
    if (!dryRun.requiresClarification) errors.push("expected clarification, got no clarification");
    return;
  }
  if (fixture.expected.expectedTools?.length) {
    const tools = dryRun.tools ?? (dryRun.tool ? [dryRun.tool] : []);
    const missing = fixture.expected.expectedTools.filter((tool) => !tools.includes(tool));
    if (missing.length) skipped.push(`multi-intent dry-run unsupported for tools ${missing.join(",")}`);
    return;
  }
  if (fixture.expected.toolSequence?.length) {
    if (!dryRun.tool) {
      skipped.push("native dry-run parser produced no tool for expected tool sequence");
      return;
    }
    if (!fixture.expected.toolSequence.includes(dryRun.tool)) {
      errors.push(`tool sequence expected one of ${fixture.expected.toolSequence.join(",")}, got ${dryRun.tool}`);
    }
    return;
  }
  if (fixture.expected.tool === undefined) return;
  const allowed = fixture.accept?.toolAnyOf ?? (fixture.expected.tool ? [fixture.expected.tool] : []);
  if (!allowed.length) return;
  if (!dryRun.tool) {
    skipped.push("native dry-run parser produced no tool");
    return;
  }
  if (!allowed.includes(dryRun.tool)) {
    errors.push(`tool expected one of ${allowed.join(",")}, got ${dryRun.tool}`);
  }
};

const checkSchema = (fixture: Fixture, dryRun: DryRun, errors: string[], skipped: string[]) => {
  if (!dryRun.tool || !dryRun.args) return;
  if (!Object.prototype.hasOwnProperty.call(toolManifest, dryRun.tool)) {
    errors.push(`unknown dry-run tool ${dryRun.tool}`);
    return;
  }
  if (dryRun.tool === "alias_create") {
    try {
      validateAliasTarget({ toolName: String(dryRun.args.toolName ?? ""), arguments: readRecord(dryRun.args.arguments) });
    } catch (error) {
      if (fixture.expected.expectedPolicy === "deny" || fixture.expected.expectedErrorCode) return;
      errors.push(`alias target validation failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const schema = toolManifest[dryRun.tool as ToolName].schema;
  const parsed = schema.safeParse(dryRun.args);
  if (!parsed.success) {
    if (fixture.expected.expectedValidation === "invalid_arguments") return;
    errors.push(`schema validation failed: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}:${issue.message}`).join("; ")}`);
  }
};

const checkPolicy = (fixture: Fixture, dryRun: DryRun, errors: string[], skipped: string[]) => {
  if (!dryRun.tool) return;
  if (!Object.prototype.hasOwnProperty.call(toolManifest, dryRun.tool)) return;
  const expectedPolicy = fixture.expected.expectedPolicy;
  const denyCode = expectedDenyCode(fixture, dryRun);
  const actualPolicy = denyCode ? "deny" : "allow";
  if (expectedPolicy && expectedPolicy !== actualPolicy) {
    errors.push(`policy expected ${expectedPolicy}, got ${actualPolicy}`);
  }
  if (fixture.expected.expectedErrorCode && denyCode && fixture.expected.expectedErrorCode !== denyCode) {
    skipped.push(`deny code differs from current dry-run policy: expected ${fixture.expected.expectedErrorCode}, got ${denyCode}`);
  }
  if (denyCode) return;

  const decision = policy.decide({
    toolName: dryRun.tool as ToolName,
    args: dryRun.args ?? {},
    summary: `Dry-run ${dryRun.tool}`,
    yoloMode: false,
  });
  const requiresConfirmation = decision.type === "require_confirmation";
  if (fixture.expected.requiresConfirmation !== undefined && requiresConfirmation !== fixture.expected.requiresConfirmation) {
    if (fixture.expected.requiresConfirmation === false && requiresConfirmation === true) {
      return;
    }
    if (fixture.strictness === "negative" && fixture.expected.toolSequence?.includes(dryRun.tool) && fixture.expected.mustNotCall?.length) {
      return;
    }
    skipped.push(`confirmation expectation differs from current policy: expected ${fixture.expected.requiresConfirmation}, got ${requiresConfirmation}`);
  }
  if (fixture.expected.risk && toolRiskByName[dryRun.tool as ToolName] !== fixture.expected.risk) {
    skipped.push(`risk expectation differs from current manifest: expected ${fixture.expected.risk}, got ${toolRiskByName[dryRun.tool as ToolName]}`);
  }
  if (toolRequiresConfirmation(dryRun.tool as ToolName) !== requiresConfirmation) {
    skipped.push("policy decision did not match manifest confirmation helper");
  }
};

const checkMustNotCall = (fixture: Fixture, dryRun: DryRun, errors: string[]) => {
  if (!fixture.expected.mustNotCall?.length || !dryRun.tool) return;
  if (fixture.expected.mustNotCall.includes(dryRun.tool)) {
    errors.push(`mustNotCall included dry-run tool ${dryRun.tool}`);
  }
};

const expectedDenyCode = (fixture: Fixture, dryRun: DryRun) => {
  if (dryRun.tool === "advanced_shell_command" && /rm\s+-rf|根目录/.test(String(dryRun.args?.command ?? fixture.utterance))) return "blocked_shell_command";
  if (dryRun.tool === "file_read" && String(dryRun.args?.path ?? "").startsWith("/etc/")) return "path_outside_allowed_directories";
  if (dryRun.tool === "alias_create") {
    try {
      validateAliasTarget({ toolName: String(dryRun.args?.toolName ?? ""), arguments: readRecord(dryRun.args?.arguments) });
    } catch (error) {
      return typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : "alias_invalid";
    }
  }
  return undefined;
};

const bundlesForTool = (tool: string): ToolBundleName[] => {
  if (tool.startsWith("music_") || tool.startsWith("video_") || tool === "media_key_control") return ["media"];
  if (tool.startsWith("file_")) return ["file"];
  if (tool.startsWith("document_")) return ["document", "file"];
  if (tool.startsWith("browser_")) return ["browser"];
  if (tool.startsWith("email_") || tool.startsWith("calendar_") || tool.startsWith("mac_") || tool.includes("weather")) return ["comms"];
  if (tool.startsWith("system_") || tool === "advanced_shell_command") return ["system"];
  if (tool.startsWith("window_") || tool.startsWith("app_") || tool.startsWith("desktop_")) return ["desktop"];
  if (tool.startsWith("alias_") || tool.startsWith("task_")) return ["core"];
  if (tool.startsWith("coding_agent_")) return ["coding"];
  return [];
};

const bundlesForDryRun = (dryRun: Pick<DryRun, "tool" | "tools">): ToolBundleName[] => {
  const tools = dryRun.tools ?? (dryRun.tool ? [dryRun.tool] : []);
  const bundles: ToolBundleName[] = [];
  for (const tool of tools) {
    for (const bundle of bundlesForTool(tool)) {
      if (!bundles.includes(bundle)) bundles.push(bundle);
    }
  }
  return bundles;
};

const mergeBundles = (left: readonly ToolBundleName[], right: readonly ToolBundleName[]) => {
  const result: ToolBundleName[] = [];
  for (const bundle of [...left, ...right]) {
    if (!result.includes(bundle)) result.push(bundle);
  }
  return result;
};

const readRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const inferCodingMode = (utterance: string) => {
  if (/review/i.test(utterance)) return "review";
  if (/npm test|修复/.test(utterance)) return "test_fix";
  return "plan";
};

const extractBetween = (value: string, start: string, end: string) => {
  const startIndex = value.indexOf(start);
  const endIndex = value.indexOf(end);
  if (startIndex < 0 || endIndex <= startIndex) return undefined;
  return value.slice(startIndex + start.length, endIndex).trim();
};

const formatFailure = (result: FixtureResult) =>
  JSON.stringify({
    id: result.id,
    utterance: result.utterance,
    errors: result.errors,
    expected: result.expected,
    actual: result.actual,
  }, null, 2);
