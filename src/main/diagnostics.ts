import fs from "node:fs";
import path from "node:path";

export type LocalExportResult<T> = {
  path: string;
  filename: string;
  bytes: number;
  payload: T;
};

export type DiagnosticsExportInput = {
  appVersion: string;
  isPackaged: boolean;
  userDataDir: string;
  serverPort: number;
  openaiConfigured: boolean;
  realtimeVoice: string;
  updateStatus: unknown;
  settings: unknown;
  memoryStatus: unknown;
  recentTasks: unknown;
  recentArtifacts: unknown;
};

export type BetaFeedbackInput = {
  message: string;
  diagnostics: unknown;
};

const secretKeyPattern = /(api[-_ ]?key|token|secret|password|cookie|authorization|bearer|private[-_ ]?key|credential|local[-_ ]?api)/i;
const openAiKeyPattern = /sk-[A-Za-z0-9_-]{8,}/g;
const bearerPattern = /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const jwtPattern = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;
const cookieValuePattern = /\b(cookie|session|sid)=([^;\s]{4,})/gi;
const maxStringLength = 1200;

export const redactDiagnosticValue = (value: unknown, key = ""): unknown => {
  if (secretKeyPattern.test(key)) return "[REDACTED]";

  if (typeof value === "string") {
    const redacted = value
      .replace(openAiKeyPattern, "[REDACTED_OPENAI_KEY]")
      .replace(bearerPattern, "Bearer [REDACTED]")
      .replace(jwtPattern, "[REDACTED_JWT]")
      .replace(cookieValuePattern, "$1=[REDACTED]");
    return redacted.length > maxStringLength ? `${redacted.slice(0, maxStringLength)}...[TRUNCATED]` : redacted;
  }

  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redactDiagnosticValue(item, key));
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([entryKey, entryValue]) => [
      entryKey,
      redactDiagnosticValue(entryValue, entryKey),
    ]),
  );
};

export const buildDiagnosticsExport = (input: DiagnosticsExportInput) =>
  redactDiagnosticValue({
    schemaVersion: 1,
    kind: "her_diagnostics",
    exportedAt: new Date().toISOString(),
    privacy:
      "Local-only diagnostic export. Review before sharing. API keys, bearer tokens, cookies, passwords, and local API tokens are redacted.",
    app: {
      version: input.appVersion,
      isPackaged: input.isPackaged,
      platform: process.platform,
      arch: process.arch,
      node: process.versions.node,
      electron: process.versions.electron ?? "unknown",
    },
    runtime: {
      serverPort: input.serverPort,
      openaiConfigured: input.openaiConfigured,
      realtimeVoice: input.realtimeVoice,
      updates: input.updateStatus,
    },
    setup: {
      settings: input.settings,
      memory: input.memoryStatus,
      userDataDir: input.userDataDir,
      localApiToken: "[REDACTED]",
    },
    recent: {
      tasks: input.recentTasks,
      artifacts: input.recentArtifacts,
    },
  });

export const buildBetaFeedbackExport = (input: BetaFeedbackInput) =>
  redactDiagnosticValue({
    schemaVersion: 1,
    kind: "her_beta_feedback",
    exportedAt: new Date().toISOString(),
    privacy:
      "Local-only feedback export. Review before sharing. The free-text message and diagnostics are redacted by default.",
    message: input.message,
    diagnostics: input.diagnostics,
  });

export const writeLocalExport = <T>(userDataDir: string, prefix: string, payload: T): LocalExportResult<T> => {
  const directory = path.join(userDataDir, "exports");
  fs.mkdirSync(directory, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `${prefix}-${timestamp}.json`;
  const filePath = path.join(directory, filename);
  const json = `${JSON.stringify(payload, null, 2)}\n`;
  fs.writeFileSync(filePath, json, { encoding: "utf8", mode: 0o600 });
  return { path: filePath, filename, bytes: Buffer.byteLength(json), payload };
};
