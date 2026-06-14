#!/usr/bin/env node

import dotenv from "dotenv";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { OpenAIRealtimeWebSocket, RealtimeAgent, RealtimeSession, tool } from "@openai/agents/realtime";

dotenv.config({ path: ".env.local" });
dotenv.config({ path: ".env" });

process.env.HER_TOOL_QUEUE_MAX_CREATES_PER_MINUTE = "120";
process.env.HER_TOOL_QUEUE_MIN_START_INTERVAL_MS = "0";
process.env.HER_TOOL_QUEUE_BACKOFF_BASE_MS = "250";
process.env.HER_TOOL_QUEUE_BACKOFF_MAX_MS = "500";
process.env.HER_TOOL_QUEUE_TASK_TIMEOUT_MS = "90000";

const require = createRequire(import.meta.url);
const { ToolRegistry } = require("../electron/dist/main/tools/registry.js");
const { ConfirmationQueue } = require("../electron/dist/main/tools/confirmation.js");
const { AuditLog } = require("../electron/dist/main/audit.js");
const { MemoryStore } = require("../electron/dist/main/memory-store.js");
const { buildRealtimeAgentInstructions } = require("../electron/dist/shared/realtime-agent.js");
const { realtimeToolDefinitions } = require("../electron/dist/shared/tools.js");

const apiKey = process.env.OPENAI_API_KEY;
const model = process.env.HER_REALTIME_MODEL ?? "gpt-realtime-2";
const profile = process.env.HER_COMPLEX_SMOKE_PROFILE ?? "travel";
const limit = Number(process.env.HER_COMPLEX_SMOKE_LIMIT ?? "10");
const codexTimeoutMs = Number(process.env.HER_COMPLEX_SMOKE_CODEX_TIMEOUT_MS ?? "120000");
const realtimeTimeoutMs = Number(process.env.HER_COMPLEX_SMOKE_REALTIME_TIMEOUT_MS ?? "45000");

if (!apiKey) {
  console.error("OPENAI_API_KEY is not configured.");
  process.exit(1);
}

const root = process.cwd();
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "her-complex-smoke-"));
const fixtureDir = path.join(tmpRoot, "fixtures");
fs.mkdirSync(fixtureDir, { recursive: true });
const itineraryPath = path.join(fixtureDir, "la-itinerary.txt");
const invoicePath = path.join(fixtureDir, "invoice-la-hotel.txt");
const briefPath = path.join(fixtureDir, "client-meeting-brief.md");
fs.writeFileSync(itineraryPath, "Flight: SHA to LAX, 2026-06-06 15:00. Hotel: Downtown LA. Reminder: bring passport and charger.\n", "utf8");
fs.writeFileSync(invoicePath, "Invoice LA-HOTEL-001 total 438.20 USD for downtown Los Angeles hotel deposit.\n", "utf8");
fs.writeFileSync(briefPath, "# Alex client meeting\nDiscuss launch timeline, contract risks, and follow-up owners.\n", "utf8");
const broadFixtureDir = path.join(os.homedir(), "Documents", "HER Smoke Broad Fixtures");
fs.mkdirSync(broadFixtureDir, { recursive: true });
const broadMarkdownPath = path.join(broadFixtureDir, "her-smoke-report.md");
const broadCsvPath = path.join(broadFixtureDir, "her-smoke-data.csv");
const broadDocxPath = path.join(broadFixtureDir, "her-smoke-word-brief.docx");
fs.writeFileSync(broadMarkdownPath, "# HER Smoke Report\n\nRevenue: 1200\nRisk: browser page parser missing until this test.\nAction: verify broad tool routing.\n", "utf8");
fs.writeFileSync(broadCsvPath, "item,amount\nflight,420\nhotel,880\n", "utf8");
createMinimalDocx(broadDocxPath, "HER smoke Word brief. Check Word document extraction and opening routes. Owner: HER broad smoke.");
const restoreEmailDrafts = setupVoiceEmailFixture(profile);

const requestedCaseIds = new Set(
  (process.env.HER_COMPLEX_SMOKE_CASE ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean),
);

const travelCases = [
  {
    id: "travel_weather",
    text: "我明天要去洛杉矶，帮我安排",
    expectedGateway: ["weather_lookup"],
  },
  {
    id: "travel_weather_reminder",
    text: "我明天下午3点飞洛杉矶，帮我查天气，并提醒我13点出门",
    expectedGateway: ["weather_lookup", "mac_reminder_create"],
  },
  {
    id: "meeting_package",
    text: "明天下午15点到16点在洛杉矶见客户Alex，帮我建日历、提醒带合同、写会议笔记模板",
    expectedGateway: ["mac_calendar_create", "mac_reminder_create", "mac_note_create"],
  },
  {
    id: "packing_note_weather",
    text: "帮我准备一份明天洛杉矶出差打包清单笔记，结合当地天气，写到Notes里",
    expectedGateway: ["weather_lookup", "mac_note_create"],
  },
  {
    id: "itinerary_extract_note",
    text: `阅读这个行程文件 ${itineraryPath}，提炼明天洛杉矶出差注意事项，并写一条Notes笔记`,
    expectedGateway: ["document_extract", "mac_note_create"],
  },
  {
    id: "invoice_search_summary",
    text: `在这个文件夹 ${fixtureDir} 里找和invoice相关的文件，总结洛杉矶出差费用线索，不要移动文件`,
    expectedGateway: ["file_search"],
  },
  {
    id: "customer_visit_weather_calendar",
    text: "明天上午10点到11点安排洛杉矶客户拜访，顺便查天气",
    expectedGateway: ["weather_lookup", "mac_calendar_create"],
  },
  {
    id: "call_reminder",
    text: "明天到洛杉矶后提醒我给+15555550100打电话，内容是确认客户会议地址",
    expectedGateway: ["mac_reminder_create"],
  },
  {
    id: "brief_to_calendar_note",
    text: `读取会议brief ${briefPath}，明天下午4点安排30分钟复盘，并写一个Notes复盘模板`,
    expectedGateway: ["document_extract", "mac_calendar_create", "mac_note_create"],
  },
  {
    id: "repo_status_native_codex",
    text: "帮我检查当前HER项目git状态并总结，不要修改文件",
    expectedGateway: [],
    allowNoGateway: true,
  },
];

const broadCases = [
  {
    id: "windows_workspace",
    text: "我准备写报告，帮我把Safari和Notes打开并排好",
    expectedGateway: ["window_auto_arrange"],
  },
  {
    id: "documents_word_digest",
    text: `帮我看一下 ${broadFixtureDir} 里面和HER smoke有关的Word和markdown资料，提炼重点`,
    expectedGatewayOneOf: [["document_folder_digest"], ["file_search", "document_extract"]],
  },
  {
    id: "cli_generate_excel_csv",
    text: `用CLI在 ${broadFixtureDir} 生成一个Excel能打开的her-smoke-summary.csv，写两行预算数据，然后用Excel打开`,
    expectedGateway: ["advanced_shell_command", "file_open"],
  },
  {
    id: "music_play_and_state",
    text: "帮我播放周杰伦的晴天，然后读取一下Music当前播放状态确认",
    expectedGateway: ["music_play_song", "music_playback_state"],
  },
  {
    id: "apple_tv_open_and_state",
    text: "在TV app里打开Ted Lasso，然后读一下Apple TV当前播放状态",
    expectedGateway: ["video_play", "apple_tv_playback_state"],
  },
  {
    id: "browser_page_parse",
    text: "用隔离浏览器打开 https://example.com ，解析这个页面的标题、正文和链接，不要点任何按钮",
    expectedGateway: ["browser_isolated_open_url", "browser_read_page"],
  },
  {
    id: "browser_fill_no_submit",
    text: "用隔离浏览器打开 https://httpbin.org/forms/post ，把客户名填成HER Smoke，但不要提交表单",
    expectedGateway: ["browser_isolated_open_url", "browser_fill_form"],
  },
  {
    id: "clipboard_and_settings",
    text: "把“HER broad smoke clipboard”放到剪贴板，然后打开系统声音设置让我检查",
    expectedGateway: ["desktop_clipboard_write", "system_open_settings"],
  },
  {
    id: "contacts_pre_call_check",
    text: "做个通话前检查：查一下通讯录里有没有Alex，把候选整理出来，但不要拨出去",
    expectedGateway: ["contacts_search"],
    allowSimpleDirect: true,
  },
  {
    id: "repo_cli_status",
    text: `用命令行检查 ${root} 这个HER项目的git状态和最近一次提交，只读不要修改文件`,
    expectedGateway: ["advanced_shell_command"],
  },
];

const voiceCases = [
  {
    id: "mom_birthday_vague_clarify",
    text: "明天是我妈妈的生日，帮我安排一下",
    expectedClarify: true,
  },
  {
    id: "mom_birthday_full_package",
    text: "明天是我妈妈的生日，早上9点提醒我买花，晚上7点到8点安排视频电话，再给 mom@example.com 写一封生日祝福邮件草稿",
    expectedGateway: ["mac_reminder_create", "mac_calendar_create", "mac_mail_draft_create"],
  },
  {
    id: "daughter_return_vague_clarify",
    text: "下周六我女儿回国，帮我准备一下",
    expectedClarify: true,
  },
  {
    id: "daughter_pickup_full_package",
    text: "下周六我女儿下午3点到4点在浦东机场，帮我查上海天气，创建接机日历，并提醒我提前2小时出发",
    expectedGateway: ["weather_lookup", "mac_calendar_create", "mac_reminder_create"],
  },
  {
    id: "noise_lower_volume",
    text: "声音太吵了，帮我小声一点",
    expectedGateway: ["system_set_volume"],
    allowSimpleDirect: true,
  },
  {
    id: "meeting_system_workspace",
    text: "我要开会了，把音量调到30，打开日历和Notes，把无关窗口最小化",
    expectedGateway: ["system_set_volume", "app_open", "app_open", "window_minimize_unrelated"],
  },
  {
    id: "email_missing_recipient_clarify",
    text: "帮我给王总写封邮件说明明天不能参会",
    expectedClarify: true,
  },
  {
    id: "email_draft_and_followup",
    text: "给 test@example.com 写一封邮件草稿，说我下周六去机场接女儿，晚上再回复她，并提醒我下周六晚上8点跟进",
    expectedGateway: ["mac_mail_draft_create", "mac_reminder_create"],
  },
  {
    id: "email_local_search",
    text: "查一下本地邮件里有没有HER voice smoke相关内容，先列出候选，不要发送任何邮件",
    expectedGateway: ["email_search"],
    allowSimpleDirect: true,
  },
  {
    id: "recording_quiet_system_package",
    text: "我现在要录音，把音量降到20，打开麦克风隐私设置，退出Music，然后提醒我30分钟后检查录音文件",
    expectedGateway: ["system_set_volume", "system_open_settings", "app_quit", "mac_reminder_create"],
  },
];

const semanticCases = [
  {
    id: "normal_browser_url",
    text: "用我的主浏览器打开 https://example.com ，不要用隔离浏览器，也不要解析页面",
    expectedGateway: ["browser_open_url"],
    allowSimpleDirect: true,
  },
  {
    id: "duckduckgo_search_page_only",
    text: "用DuckDuckGo打开搜索页搜 HER voice agent，只打开搜索结果页，不要读取内容",
    expectedGateway: ["browser_search_open"],
    allowSimpleDirect: true,
  },
  {
    id: "shortcut_discovery_no_run",
    text: "看看我本机有没有和Apple TV或音乐相关的快捷指令，只列名字，不要运行",
    expectedGateway: ["shortcut_list"],
    allowSimpleDirect: true,
  },
  {
    id: "shortcut_run_missing_name_clarify",
    text: "运行那个打开电视的快捷指令",
    expectedClarify: true,
  },
  {
    id: "phone_pronoun_missing_clarify",
    text: "给他打电话",
    expectedClarify: true,
  },
  {
    id: "browser_fill_and_submit",
    text: "用隔离浏览器打开 https://httpbin.org/forms/post，把客户名填成HER UX，然后提交表单",
    expectedGateway: ["browser_isolated_open_url", "browser_fill_form", "browser_click"],
  },
  {
    id: "document_prepare_edit",
    text: `把 ${broadMarkdownPath} 改成一个三行Markdown：标题HER Semantic Smoke，第二行写checked，第三行写done。先展示编辑预览再写入`,
    expectedGateway: ["document_prepare_edit"],
  },
  {
    id: "dark_mode_natural",
    text: "屏幕太刺眼了，帮我切到深色模式",
    expectedGateway: ["system_set_dark_mode"],
    allowSimpleDirect: true,
  },
  {
    id: "brightness_natural_clarify",
    text: "屏幕太暗了，帮我调一下亮度",
    expectedGateway: ["system_set_brightness"],
    allowSimpleDirect: true,
    allowTaskFailures: true,
  },
  {
    id: "unknown_tool_clarify",
    text: "帮我把洗衣机调到快洗模式",
    expectedClarify: true,
  },
];

const profileCases = {
  travel: travelCases,
  broad: broadCases,
  voice: voiceCases,
  semantic: semanticCases,
};

if (!profileCases[profile]) {
  console.error(`Unknown HER_COMPLEX_SMOKE_PROFILE=${profile}. Expected one of: ${Object.keys(profileCases).join(", ")}`);
  restoreEmailDrafts();
  process.exit(1);
}

const allCases = profileCases[profile];

const cases = allCases
  .filter((testCase) => requestedCaseIds.size === 0 || requestedCaseIds.has(testCase.id))
  .slice(0, limit);

const smokeGate = {
  assertToolAllowed: async () => {},
  authorizedAppNames: async () =>
    new Set([
      "Safari",
      "Calendar",
      "Notes",
      "Music",
      "Mail",
    ]),
};

const failures = [];
const results = [];

for (const testCase of cases) {
  const startedAt = Date.now();
  try {
    const parsed = await parseWithRealtime(testCase.text);
    assertRealtimeIntent(testCase, parsed.intent);
    const registry = createRegistry();
    if (testCase.expectedClarify) {
      const route = await routeIntentAllowClarify(registry, parsed.intent);
      const clarifySteps = (route.plan ?? []).filter((step) => step.status === "needs_clarification");
      if (!clarifySteps.length) {
        throw new Error(`Expected clarification route, got ${summarizeForError(route)}`);
      }
      results.push({
        id: testCase.id,
        ok: true,
        ms: Date.now() - startedAt,
        intent: summarizeIntent(parsed.intent),
        route: route.route,
        clarification: clarifySteps.map((step) => ({ title: step.title, reason: step.reason })),
      });
      console.log(JSON.stringify(results.at(-1), null, 2));
      continue;
    }
    if (parsed.intent.complexity === "simple" && testCase.allowSimpleDirect) {
      const direct = await runDirectThroughHer(registry, parsed.intent, testCase);
      results.push({
        id: testCase.id,
        ok: true,
        ms: Date.now() - startedAt,
        intent: summarizeIntent(parsed.intent),
        gatewayTools: direct.gatewayTools,
        taskStatuses: direct.taskStatuses,
      });
      console.log(JSON.stringify(results.at(-1), null, 2));
      continue;
    }
    const route = await routeIntent(registry, parsed.intent);
    const codex = await runCodexThroughHer(registry, route);
    const gateway = codex.herToolGateway;
    if (!gateway && !testCase.allowNoGateway) {
      throw new Error(`Codex completed without HER Tool Gateway requests. Codex result: ${summarizeForError(codex)}`);
    }
    const gatewayTools = gateway?.requests?.map((request) => request.toolName) ?? [];
    for (const expected of testCase.expectedGateway ?? []) {
      if (!gatewayTools.includes(expected)) {
        throw new Error(`Missing gateway tool ${expected}; got ${gatewayTools.join(", ") || "[none]"}. Codex result: ${summarizeForError(codex)}`);
      }
    }
    if (testCase.expectedGatewayOneOf) {
      const matched = testCase.expectedGatewayOneOf.some((candidate) =>
        candidate.every((expected) => gatewayTools.includes(expected)),
      );
      if (!matched) {
        throw new Error(`Missing one expected gateway tool set ${JSON.stringify(testCase.expectedGatewayOneOf)}; got ${gatewayTools.join(", ") || "[none]"}. Codex result: ${summarizeForError(codex)}`);
      }
    }
    const taskStatuses = gateway ? await pollGatewayTasks(registry, gateway.results ?? [], { allowTaskFailures: Boolean(testCase.allowTaskFailures) }) : [];
    const incomplete = taskStatuses.filter((item) => item.status !== "completed");
    if (incomplete.length && !testCase.allowTaskFailures) {
      throw new Error(`Gateway tasks did not all complete: ${JSON.stringify(incomplete)}. Codex result: ${summarizeForError(codex)}`);
    }
    results.push({
      id: testCase.id,
      ok: true,
      ms: Date.now() - startedAt,
      intent: summarizeIntent(parsed.intent),
      gatewayTools,
      taskStatuses,
    });
    console.log(JSON.stringify(results.at(-1), null, 2));
  } catch (error) {
    const failure = {
      id: testCase.id,
      ok: false,
      ms: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    };
    failures.push(failure);
    results.push(failure);
    console.error(JSON.stringify(failure, null, 2));
  }
}

const summary = {
  ok: failures.length === 0,
  model,
  profile,
  tmpRoot,
  broadFixtureDir,
  checked: cases.length,
  passed: cases.length - failures.length,
  failed: failures.length,
  failures,
};
console.log(JSON.stringify(summary, null, 2));
restoreEmailDrafts();
if (failures.length) process.exit(1);

function createMinimalDocx(outputPath, text) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "her-docx-"));
  fs.mkdirSync(path.join(workDir, "_rels"), { recursive: true });
  fs.mkdirSync(path.join(workDir, "word", "_rels"), { recursive: true });
  fs.writeFileSync(path.join(workDir, "[Content_Types].xml"), `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`, "utf8");
  fs.writeFileSync(path.join(workDir, "_rels", ".rels"), `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`, "utf8");
  fs.writeFileSync(path.join(workDir, "word", "document.xml"), `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body><w:p><w:r><w:t>${escapeXml(text)}</w:t></w:r></w:p></w:body>
</w:document>`, "utf8");
  try {
    execFileSync("zip", ["-qr", outputPath, "."], { cwd: workDir, stdio: "ignore" });
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

function setupVoiceEmailFixture(activeProfile) {
  if (activeProfile !== "voice") return () => {};
  const emailPath = path.join(root, "data", "email-drafts.json");
  const existed = fs.existsSync(emailPath);
  const original = existed ? fs.readFileSync(emailPath, "utf8") : undefined;
  let drafts = [];
  try {
    drafts = existed ? JSON.parse(original) : [];
    if (!Array.isArray(drafts)) drafts = [];
  } catch {
    drafts = [];
  }
  drafts.unshift({
    id: "her-voice-smoke-seed",
    to: "voice-smoke@example.com",
    subject: "HER voice smoke seeded local draft",
    body: "This seeded local email draft exists only for HER voice smoke search coverage.",
    createdAt: new Date().toISOString(),
  });
  fs.mkdirSync(path.dirname(emailPath), { recursive: true });
  fs.writeFileSync(emailPath, `${JSON.stringify(drafts, null, 2)}\n`, "utf8");
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    if (existed && original !== undefined) {
      fs.writeFileSync(emailPath, original, "utf8");
    } else {
      fs.rmSync(emailPath, { force: true });
    }
  };
}

function escapeXml(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

async function parseWithRealtime(text) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await parseWithRealtimeOnce(text);
    } catch (error) {
      lastError = error;
      if (!/without intent_route/i.test(error instanceof Error ? error.message : String(error))) break;
      await sleep(500);
    }
  }
  throw lastError;
}

async function parseWithRealtimeOnce(text) {
  const capturedCalls = [];
  const tools = realtimeToolDefinitions.map((definition) =>
    tool({
      name: definition.name,
      description: definition.description,
      parameters: definition.parameters,
      strict: false,
      execute: async (input) => {
        const args = coerceToolArguments(input);
        capturedCalls.push({ name: definition.name, arguments: args });
        return {
          ok: true,
          captured: true,
          nextAction: "Complex smoke captured tool call only.",
        };
      },
    }),
  );
  const agent = new RealtimeAgent({
    name: "HER Complex Smoke Parser",
    instructions: `${buildRealtimeAgentInstructions()}

Headless smoke-test override:
- For the next user message, your first and only action must be calling intent_route with StandardIntent JSON.
- Do not speak before calling intent_route.
- Do not call task_create, confirmation_decide, or any side-effecting tool in this Realtime parser session.
- Stop after intent_route returns.`,
    tools,
  });
  const transport = new OpenAIRealtimeWebSocket({ useInsecureApiKey: true });
  const session = new RealtimeSession(agent, {
    model,
    transport,
    config: {
      outputModalities: ["text"],
      toolChoice: "auto",
      parallelToolCalls: false,
      providerData: {
        max_output_tokens: 700,
        truncation: {
          type: "retention_ratio",
          retention_ratio: 0.8,
          token_limits: { post_instructions: 6000 },
        },
      },
    },
  });

  const result = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Realtime parse timed out after ${realtimeTimeoutMs}ms.`)), realtimeTimeoutMs);
    session.on("agent_tool_end", () => {
      const intentCall = capturedCalls.find((call) => call.name === "intent_route");
      if (!intentCall) return;
      clearTimeout(timeout);
      resolve({ capturedCalls, intent: intentCall.arguments.intent });
    });
    session.on("agent_end", (_context, _agent, output) => {
      const intentCall = capturedCalls.find((call) => call.name === "intent_route");
      clearTimeout(timeout);
      if (!intentCall) reject(new Error(`Realtime ended without intent_route. Output: ${output}`));
      else resolve({ capturedCalls, intent: intentCall.arguments.intent });
    });
    session.on("error", (event) => {
      clearTimeout(timeout);
      reject(errorFromRealtimeEvent(event));
    });
    session.connect({ apiKey, model })
      .then(() => session.sendMessage(text))
      .catch((error) => {
        clearTimeout(timeout);
        reject(error);
      });
  }).finally(() => session.close());

  return result;
}

function createRegistry() {
  return new ToolRegistry(new ConfirmationQueue(), new AuditLog(), smokeGate, undefined, new MemoryStore(tmpRoot));
}

async function routeIntent(registry, intent) {
  const response = await registry.execute({ name: "intent_route", arguments: { intent, cwd: root }, source: "local" });
  if (!response.ok) throw new Error(`intent_route failed: ${response.error}`);
  const route = await readFullResult(registry, response.result);
  const step = route.plan?.[0];
  if (route.route !== "codex" || step?.toolName !== "codex_task_run") {
    throw new Error(`Expected codex route, got route=${route.route} tool=${step?.toolName}`);
  }
  return route;
}

async function routeIntentAllowClarify(registry, intent) {
  const response = await registry.execute({ name: "intent_route", arguments: { intent, cwd: root }, source: "local" });
  if (!response.ok) throw new Error(`intent_route failed: ${response.error}`);
  return readFullResult(registry, response.result);
}

async function runCodexThroughHer(registry, route) {
  const step = route.plan[0];
  const queued = await registry.execute({
    name: "task_create",
    arguments: {
      toolName: "codex_task_run",
      arguments: { ...step.arguments, timeoutMs: codexTimeoutMs },
      priority: "high",
      runAfterMs: 0,
    },
    source: "local",
  });
  if (!queued.ok) throw new Error(`task_create codex failed: ${queued.error}`);
  await sleep(100);
  const task = await readTask(registry, queued.result.task.taskId);
  if (task.status !== "needs_confirmation" || !task.confirmationId) {
    throw new Error(`Expected codex confirmation, got status=${task.status}`);
  }
  const decided = await registry.execute({
    name: "confirmation_decide",
    arguments: { confirmationId: task.confirmationId, approved: true },
    source: "local",
  });
  if (!decided.ok) throw new Error(`Codex confirmation failed: ${decided.error}`);
  const payload = await readFullResult(registry, decided.result);
  return readFullResult(registry, payload.result);
}

async function runDirectThroughHer(registry, intent, testCase) {
  const response = await registry.execute({ name: "intent_route", arguments: { intent, cwd: root }, source: "local" });
  if (!response.ok) throw new Error(`intent_route direct failed: ${response.error}`);
  const route = await readFullResult(registry, response.result);
  const steps = (route.plan ?? []).filter((step) => step.status === "ready" && step.toolName);
  if (!steps.length) throw new Error(`Expected direct ready route, got ${summarizeForError(route)}`);
  const gatewayTools = steps.map((step) => step.toolName);
  for (const expected of testCase.expectedGateway ?? []) {
    if (!gatewayTools.includes(expected)) {
      throw new Error(`Missing direct tool ${expected}; got ${gatewayTools.join(", ") || "[none]"}. Route: ${summarizeForError(route)}`);
    }
  }
  const gatewayResults = [];
  for (const step of steps) {
    const queued = await registry.execute({
      name: "task_create",
      arguments: { toolName: step.toolName, arguments: step.arguments ?? {}, priority: step.priority ?? "normal", runAfterMs: 0 },
      source: "local",
    });
    if (!queued.ok) throw new Error(`task_create direct failed for ${step.toolName}: ${queued.error}`);
    gatewayResults.push({ ok: true, toolName: step.toolName, taskId: queued.result.task.taskId });
  }
  const taskStatuses = await pollGatewayTasks(registry, gatewayResults, { allowTaskFailures: Boolean(testCase.allowTaskFailures) });
  const incomplete = taskStatuses.filter((item) => item.status !== "completed");
  if (incomplete.length && !testCase.allowTaskFailures) throw new Error(`Direct tasks did not all complete: ${JSON.stringify(incomplete)}`);
  return { gatewayTools, taskStatuses };
}

async function pollGatewayTasks(registry, gatewayResults, options = {}) {
  const statuses = [];
  for (const result of gatewayResults) {
    if (!result.ok || !result.taskId) {
      statuses.push({ toolName: result.toolName, status: "gateway_failed", error: result.error });
      continue;
    }
    let task;
    let approved = false;
    for (let attempt = 0; attempt < 35; attempt += 1) {
      task = await readTask(registry, result.taskId);
      if (task.status === "needs_confirmation" && task.confirmationId) {
        const decided = await registry.execute({
          name: "confirmation_decide",
          arguments: { confirmationId: task.confirmationId, approved: true },
          source: "local",
        });
        if (!decided.ok) {
          if (options.allowTaskFailures) {
            statuses.push({
              toolName: result.toolName,
              status: "failed",
              error: decided.error,
              confirmationId: task.confirmationId,
              approved: true,
            });
            task = undefined;
            break;
          }
          throw new Error(`Gateway confirmation failed for ${result.toolName}: ${decided.error}`);
        }
        approved = true;
        await sleep(500);
        continue;
      }
      if (["completed", "failed", "cancelled"].includes(task.status)) break;
      await sleep(1000);
    }
    if (!task) continue;
    statuses.push({
      toolName: result.toolName,
      status: task?.status,
      error: task?.error,
      confirmationId: task?.confirmationId,
      approved,
    });
  }
  return statuses;
}

async function readTask(registry, taskId) {
  const response = await registry.execute({ name: "task_status", arguments: { taskId }, source: "local" });
  if (!response.ok) throw new Error(`task_status failed for ${taskId}: ${response.error}`);
  const result = await readFullResult(registry, response.result);
  return result.task;
}

async function readFullResult(registry, result) {
  if (!result?.truncated || !result.handle) return result;
  let offset = 0;
  let content = "";
  for (let index = 0; index < 20; index += 1) {
    const response = await registry.execute({
      name: "tool_result_read",
      arguments: { handle: result.handle, offset, maxChars: 6000 },
      source: "local",
    });
    if (!response.ok) throw new Error(`tool_result_read failed: ${response.error}`);
    content += response.result.content ?? "";
    if (!response.result.hasMore) return JSON.parse(content);
    offset = response.result.nextOffset;
  }
  throw new Error(`tool_result_read exceeded chunk limit for handle ${result.handle}`);
}

function assertRealtimeIntent(testCase, intent) {
  if (!intent || typeof intent !== "object") throw new Error("Realtime did not return StandardIntent.");
  if (intent.originalText !== testCase.text) throw new Error(`originalText mismatch: ${intent.originalText}`);
  if (testCase.expectedClarify) {
    if (intent.routePreference === "clarify" || intent.complexity === "ambiguous" || (intent.missingInfo ?? []).length) return;
    throw new Error(`Expected Realtime to preserve clarification need, got ${JSON.stringify(summarizeIntent(intent))}`);
  }
  if (testCase.allowSimpleDirect && intent.complexity === "simple") return;
  if (intent.complexity !== "complex") throw new Error(`Expected complexity=complex, got ${intent.complexity}`);
  if (intent.routePreference && !["codex", "auto"].includes(intent.routePreference)) {
    throw new Error(`Expected routePreference=codex|auto, got ${intent.routePreference}`);
  }
}

function summarizeIntent(intent) {
  return {
    intent: intent.intent,
    complexity: intent.complexity,
    domain: intent.domain,
    action: intent.action,
    entities: intent.entities,
    confidence: intent.confidence,
    routePreference: intent.routePreference,
  };
}

function summarizeForError(value) {
  try {
    return JSON.stringify(value).slice(0, 2500);
  } catch {
    return String(value).slice(0, 2500);
  }
}

function coerceToolArguments(input) {
  if (typeof input === "string") {
    try {
      return coerceToolArguments(JSON.parse(input));
    } catch {
      return {};
    }
  }
  if (input && typeof input === "object" && !Array.isArray(input)) return input;
  return {};
}

function errorFromRealtimeEvent(event) {
  const raw = event?.error ?? event;
  if (raw instanceof Error) return raw;
  if (raw && typeof raw === "object") return new Error(String(raw.message ?? raw.error?.message ?? JSON.stringify(raw)));
  return new Error(String(raw));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
