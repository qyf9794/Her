#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const fixturesPath = path.join(root, "tests", "fixtures", "commands", "all.json");
const outputDir = path.join(root, "docs", "test-runs", "simple-command-intent-cards");
const outputPath = path.join(outputDir, "S0-intent-card-report.json");

const highRiskKinds = new Set(["external_send", "browser_submit", "system_change", "shell", "coding_agent"]);
const secretPatterns = [
  /sk-[A-Za-z0-9_-]{6,}/g,
  /\b(api[_ -]?key|token|secret|password|cookie|authorization|bearer)\b\s*(?:是|=|:)?\s*["']?[^"',\s}]+/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];
const unredactedSecretPatterns = [
  /sk-[A-Za-z0-9_-]{6,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/,
  /\bpassword\s+(?!\[redacted\])\S+/i,
  /\bapi[_ -]?key\s*(?:是|=|:)\s*(?!\[redacted\])\S+/i,
  /\bbearer\s+(?!\[redacted\])[A-Za-z0-9._-]{8,}/i,
];

export const buildIntentCardReport = (options = {}) => {
  const fixtures = JSON.parse(fs.readFileSync(options.fixturesPath ?? fixturesPath, "utf8"));
  const cards = fixtures.map(toIntentCardResult);
  const summary = summarize(cards);
  const report = {
    schemaVersion: 1,
    milestone: "S0",
    title: "Simple Command Intent Card Harness",
    generatedAt: new Date().toISOString(),
    realtime2Connected: false,
    executedRealTools: false,
    summary,
    cards,
  };
  return {
    report,
    validation: validateReport(report),
  };
};

export const writeIntentCardReport = (report, targetPath = outputPath) => {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return targetPath;
};

export const validateReport = (report) => {
  const errors = [];
  if (report.milestone !== "S0") errors.push("report milestone must be S0");
  if (report.realtime2Connected !== false) errors.push("S0 must not connect Realtime-2");
  if (report.executedRealTools !== false) errors.push("S0 must not execute real tools");
  if (!Array.isArray(report.cards) || report.cards.length === 0) errors.push("report must contain cards");

  for (const result of report.cards ?? []) {
    const card = result.card;
    const prefix = result.id ?? "unknown";
    if (!card.utterance) errors.push(`${prefix}: utterance is required`);
    if (!card.domain) errors.push(`${prefix}: domain is required`);
    if (!card.intent) errors.push(`${prefix}: intent is required`);
    if (!card.complexity) errors.push(`${prefix}: complexity is required`);
    if (!card.risk) errors.push(`${prefix}: risk is required`);
    if (!card.expectedUserVisibleResult) errors.push(`${prefix}: expectedUserVisibleResult is required`);
    if (card.cardType === "executable" && !card.toolName) errors.push(`${prefix}: executable card requires toolName`);
    if (card.cardType === "clarification" && (!card.clarificationQuestion || !card.missingInfo.length)) {
      errors.push(`${prefix}: clarification card requires question and missingInfo`);
    }
    if (card.cardType === "denial" && !card.denialReason) errors.push(`${prefix}: denial card requires denialReason`);
    if (highRiskKinds.has(card.risk) && card.requiresConfirmation !== true && card.cardType !== "denial") {
      errors.push(`${prefix}: high-risk card must require confirmation or deny`);
    }
    if (containsSecret(JSON.stringify(card))) errors.push(`${prefix}: card contains unredacted secret-like content`);
  }

  return {
    ok: errors.length === 0,
    errors,
  };
};

const toIntentCardResult = (fixture) => {
  const cardType = inferCardType(fixture);
  const toolName = fixture.expected?.tool ?? firstExpectedTool(fixture);
  const risk = fixture.expected?.risk ?? inferRisk(toolName, fixture);
  const requiresConfirmation = Boolean(fixture.expected?.requiresConfirmation || highRiskKinds.has(risk));
  const card = {
    id: fixture.id,
    utterance: redact(String(fixture.utterance ?? "")),
    domain: normalizeDomain(fixture.category),
    intent: inferIntent(fixture, toolName, cardType),
    complexity: inferComplexity(fixture),
    cardType,
    toolName: cardType === "executable" ? toolName : toolName ?? null,
    toolArguments: redactValue(fixture.expected?.args ?? {}),
    candidateTools: candidateTools(fixture, toolName),
    missingInfo: cardType === "clarification" ? inferMissingInfo(fixture) : [],
    clarificationQuestion: cardType === "clarification" ? clarificationQuestionFor(fixture) : null,
    denialReason: cardType === "denial" ? denialReasonFor(fixture) : null,
    confidence: inferConfidence(fixture),
    risk,
    requiresConfirmation,
    policyPreview: policyPreview(cardType, requiresConfirmation, fixture),
    preconditions: preconditionsFor(fixture.category, cardType),
    expectedUserVisibleResult: visibleResultFor(fixture, toolName, cardType),
    expectedUserAudibleResult: audibleResultFor(fixture, toolName),
    postconditions: postconditionsFor(fixture.category, cardType),
    cleanup: cleanupFor(fixture.category, cardType),
    executionMode: executionModeFor(cardType, risk, requiresConfirmation),
  };
  const errors = validateReport({ milestone: "S0", realtime2Connected: false, executedRealTools: false, cards: [{ id: fixture.id, card }] }).errors;
  return {
    id: fixture.id,
    category: fixture.category,
    strictness: fixture.strictness,
    status: errors.length ? "failed" : "passed",
    errors,
    card,
  };
};

const inferCardType = (fixture) => {
  if (fixture.expected?.expectedPolicy === "deny" || fixture.strictness === "negative") return "denial";
  if (fixture.expected?.requiresClarification || fixture.strictness === "clarification" || fixture.expected?.tool === null) return "clarification";
  if (!fixture.expected?.tool && !fixture.expected?.expectedTools?.length && !fixture.expected?.toolSequence?.length) return "unsupported";
  return "executable";
};

const normalizeDomain = (category) => {
  if (category === "file" || category === "document") return "files";
  if (category === "comms") return "productivity";
  if (category === "coding") return "task";
  if (category === "negative") return "safety";
  return category || "unknown";
};

const inferIntent = (fixture, toolName, cardType) => {
  if (cardType === "clarification") return `${normalizeDomain(fixture.category)}.clarify`;
  if (cardType === "denial") return `${normalizeDomain(fixture.category)}.deny`;
  if (cardType === "unsupported") return `${normalizeDomain(fixture.category)}.unsupported`;
  return String(toolName ?? "unknown").replace(/_/g, ".");
};

const inferComplexity = (fixture) => {
  if (fixture.expected?.expectedTools?.length > 1 || fixture.expected?.toolSequence?.length > 1) return "compound";
  if (fixture.category === "coding") return "complex";
  return "simple";
};

const firstExpectedTool = (fixture) =>
  fixture.expected?.expectedTools?.[0] ?? fixture.expected?.toolSequence?.[0] ?? fixture.accept?.toolAnyOf?.[0] ?? null;

const inferRisk = (toolName, fixture) => {
  if (fixture.category === "coding") return "coding_agent";
  if (/shell/i.test(String(toolName))) return "shell";
  if (/send|publish|post|phone_call/i.test(String(toolName))) return "external_send";
  if (/click|submit|fill_form/i.test(String(toolName))) return "browser_submit";
  if (/system|window|desktop|calendar_create|file_(create|rename|move|copy|trash)|document_prepare_edit/i.test(String(toolName))) {
    return "system_change";
  }
  if (/read|search|list|status|lookup/i.test(String(toolName))) return "read";
  return "local_open";
};

const candidateTools = (fixture, toolName) =>
  [...new Set([toolName, ...(fixture.expected?.expectedTools ?? []), ...(fixture.expected?.toolSequence ?? []), ...(fixture.accept?.toolAnyOf ?? [])].filter(Boolean))];

const inferMissingInfo = (fixture) => {
  const text = fixture.utterance ?? "";
  if (/那个|它|他|她/.test(text)) return ["target"];
  if (/发/.test(text)) return ["recipient", "channel"];
  if (/提交|点击/.test(text)) return ["safe_target", "confirmation"];
  return ["target"];
};

const clarificationQuestionFor = (fixture) => {
  const missing = inferMissingInfo(fixture);
  if (missing.includes("recipient")) return "Who should Her send this to, and through which channel?";
  if (missing.includes("safe_target")) return "Which safe local target should Her click or submit, and do you want to approve that action?";
  if (missing.includes("target")) return "Which exact item, app, file, window, or message should Her use?";
  return "What extra information should Her use before planning this action?";
};

const denialReasonFor = (fixture) => {
  const text = fixture.utterance ?? "";
  if (/api key|password|secret|token|p8|private key/i.test(text)) {
    return "Her will not store, reveal, or route credential contents through intent cards or logs.";
  }
  if (/rm -rf|根目录|删除整个|\/etc\/passwd/.test(text)) {
    return "The request targets a destructive or disallowed filesystem or shell operation.";
  }
  if (/关闭所有窗口|文档里的指令/.test(text)) {
    return "Her treats document instructions as untrusted content and will not execute unsafe window commands from them.";
  }
  if (/音量调到\s*200/.test(text)) {
    return "The requested value is outside the safe accepted range.";
  }
  return "The request is unsafe or outside the allowed S0 dry-run policy.";
};

const inferConfidence = (fixture) => {
  if (fixture.strictness === "strict") return 0.92;
  if (fixture.strictness === "flexible") return 0.78;
  if (fixture.strictness === "clarification") return 0.45;
  return 0.2;
};

const policyPreview = (cardType, requiresConfirmation, fixture) => {
  if (cardType === "denial") {
    return {
      decision: "deny",
      reason: "The request is unsafe, ambiguous, or would expose sensitive information.",
    };
  }
  if (cardType === "clarification") {
    return {
      decision: "clarify",
      reason: "Her needs more information before planning an action.",
    };
  }
  if (requiresConfirmation) {
    return {
      decision: "require_confirmation",
      reason: "The command may change local state or contact an external destination.",
    };
  }
  return {
    decision: fixture.expected?.expectedPolicy ?? "allow",
    reason: "The command is low risk in S0 dry-run mode.",
  };
};

const visibleResultFor = (fixture, toolName, cardType) => {
  if (cardType === "denial") return "User sees a denial card with the blocked risk and no side effect.";
  if (cardType === "clarification") return "User sees one concrete clarification question before any tool execution.";
  if (cardType === "unsupported") return "User sees an unsupported-intent card with a safe next step.";
  if (fixture.category === "desktop") return "User sees the target app, window plan, or desktop layout preview described in the card.";
  if (fixture.category === "file" || fixture.category === "document") return "User sees a file/document result card with source, target, and redacted content boundaries.";
  if (fixture.category === "browser") return "User sees the target URL, page title, form/click target, or external-submit confirmation.";
  if (fixture.category === "media") return "User sees the media app, song query, playback target, or setup requirement.";
  if (fixture.category === "system") return "User sees the system setting, shell confirmation, or state readback plan.";
  if (fixture.category === "comms") return "User sees a searchable result, local draft, calendar event preview, or send confirmation.";
  if (fixture.category === "task" || fixture.category === "coding") return "User sees task status, task plan, or coding-agent confirmation.";
  return `User sees an intent card for ${toolName ?? "the command"}.`;
};

const audibleResultFor = (fixture, toolName) => {
  if (fixture.category === "media" && /music_open|music_play/.test(String(toolName))) return "Optional short spoken confirmation when speech feedback is enabled.";
  if (toolName === "system_speak") return "The requested phrase is audible.";
  return null;
};

const preconditionsFor = (category, cardType) => {
  if (cardType !== "executable") return ["No real tool execution in S0."];
  if (category === "desktop") return ["Protect Her and Codex windows.", "Use disposable test windows for layout scenarios."];
  if (category === "file" || category === "document") return ["Use disposable files or read-only fixture files.", "Do not include real secrets in fixtures."];
  if (category === "browser") return ["Use local fixture pages for fill and click scenarios."];
  if (category === "media") return ["Apple Music and player integrations may require local setup before real playback tests."];
  return ["S0 dry-run only; no side effects."];
};

const postconditionsFor = (category, cardType) => {
  if (cardType !== "executable") return ["No side effects occurred."];
  if (category === "desktop") return ["Her and Codex remain open.", "Window changes are only previewed in S0."];
  if (category === "file" || category === "document") return ["No filesystem changes occur in S0."];
  if (category === "browser") return ["No external form submit occurs in S0."];
  return ["Intent card generated without Realtime-2 or real tool execution."];
};

const cleanupFor = (category, cardType) => {
  if (cardType !== "executable") return [];
  if (category === "desktop") return ["Close disposable test windows in later real-simulation milestones."];
  if (category === "file" || category === "document") return ["Remove disposable test files in later real-simulation milestones."];
  if (category === "comms") return ["Delete [Her Test] drafts/events/reminders in later real-simulation milestones."];
  return [];
};

const executionModeFor = (cardType, risk, requiresConfirmation) => {
  if (cardType === "denial") return "denial_only";
  if (cardType === "clarification") return "dry_run";
  if (cardType === "unsupported") return "unsupported";
  if (requiresConfirmation || highRiskKinds.has(risk)) return "confirmation_only";
  return "dry_run";
};

const summarize = (cards) => {
  const byStatus = countBy(cards, (item) => item.status);
  const byCategory = countBy(cards, (item) => item.category);
  const byCardType = countBy(cards, (item) => item.card.cardType);
  const byRisk = countBy(cards, (item) => item.card.risk);
  return {
    total: cards.length,
    passed: byStatus.passed ?? 0,
    failed: byStatus.failed ?? 0,
    byCategory,
    byCardType,
    byRisk,
  };
};

const countBy = (items, selector) =>
  items.reduce((counts, item) => {
    const key = selector(item) ?? "unknown";
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});

const redactValue = (value) => JSON.parse(redact(JSON.stringify(value)));

const redact = (value) => {
  let next = value;
  for (const pattern of secretPatterns) next = next.replace(pattern, (match) => {
    const key = match.split(/\s|=|:|是/)[0] || "secret";
    return `${key} [redacted]`;
  });
  return next;
};

const containsSecret = (value) => unredactedSecretPatterns.some((pattern) => pattern.test(value));

const main = () => {
  const { report, validation } = buildIntentCardReport();
  const targetPath = writeIntentCardReport(report);
  console.log(`report=${path.relative(root, targetPath)}`);
  console.log(`total=${report.summary.total}`);
  console.log(`passed=${report.summary.passed}`);
  console.log(`failed=${report.summary.failed}`);
  if (!validation.ok) {
    console.error(validation.errors.join("\n"));
    process.exitCode = 1;
  }
};

if (process.argv[1] && import.meta.url === pathToFileURL(fileURLToPath(import.meta.url)).href && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
