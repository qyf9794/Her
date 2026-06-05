import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import dotenv from "dotenv";

const envLocalPath = path.join(process.cwd(), ".env.local");
const envPath = path.join(process.cwd(), ".env");

dotenv.config({ path: envLocalPath });
dotenv.config({ path: envPath });

const splitList = (value: string | undefined, fallback: string[]) =>
  (value ?? fallback.join(","))
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

const home = os.homedir();

const boundedNumber = (value: string | undefined, fallback: number, min: number, max: number) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
};

const booleanEnv = (value: string | undefined, fallback: boolean) => {
  if (typeof value === "undefined") return fallback;
  return /^(1|true|yes|on)$/i.test(value.trim());
};

const realtimeMode = process.env.HER_REALTIME_MODE === "economy" ? "economy" : "quality";
const splitArgs = (value: string | undefined, fallback: string[]) => {
  if (!value) return fallback;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) return parsed;
  } catch {
    // Fall back to shell-like whitespace splitting for simple local overrides.
  }
  return value.split(/\s+/).map((item) => item.trim()).filter(Boolean);
};

const expandHome = (value: string) => {
  if (value === "~") return home;
  if (value.startsWith("~/")) return path.join(home, value.slice(2));
  return value;
};

export const config = {
  openaiApiKey: process.env.OPENAI_API_KEY ?? "",
  realtimeMode,
  realtimeModel: process.env.HER_REALTIME_MODEL ?? (realtimeMode === "economy" ? "gpt-realtime-mini" : "gpt-realtime-2"),
  realtimeEconomyModel: process.env.HER_REALTIME_ECONOMY_MODEL ?? "gpt-realtime-mini",
  realtimeVoice: process.env.HER_REALTIME_VOICE ?? "marin",
  realtimePostInstructionsTokens: boundedNumber(process.env.HER_REALTIME_POST_INSTRUCTIONS_TOKENS, 6000, 1000, 20000),
  realtimeRetentionRatio: boundedNumber(process.env.HER_REALTIME_RETENTION_RATIO, 0.8, 0.1, 1),
  realtimeMaxOutputTokens: boundedNumber(process.env.HER_REALTIME_MAX_OUTPUT_TOKENS, 1200, 1, 4096),
  realtimeTranscriptionEnabled: booleanEnv(process.env.HER_REALTIME_TRANSCRIPTION_ENABLED, true),
  realtimeTranscriptionModel: process.env.HER_REALTIME_TRANSCRIPTION_MODEL ?? "gpt-4o-mini-transcribe",
  realtimeVadThreshold: boundedNumber(process.env.HER_REALTIME_VAD_THRESHOLD, 0.55, 0, 1),
  realtimeVadSilenceDurationMs: boundedNumber(process.env.HER_REALTIME_VAD_SILENCE_DURATION_MS, 700, 100, 3000),
  realtimeVadPrefixPaddingMs: boundedNumber(process.env.HER_REALTIME_VAD_PREFIX_PADDING_MS, 300, 0, 1000),
  toolQueueMaxCreatesPerMinute: boundedNumber(process.env.HER_TOOL_QUEUE_MAX_CREATES_PER_MINUTE, 20, 1, 120),
  toolQueueMinStartIntervalMs: boundedNumber(process.env.HER_TOOL_QUEUE_MIN_START_INTERVAL_MS, 1200, 0, 60000),
  toolQueueBackoffBaseMs: boundedNumber(process.env.HER_TOOL_QUEUE_BACKOFF_BASE_MS, 2000, 250, 60000),
  toolQueueBackoffMaxMs: boundedNumber(process.env.HER_TOOL_QUEUE_BACKOFF_MAX_MS, 30000, 1000, 300000),
  codexEnabled: booleanEnv(process.env.HER_CODEX_ENABLED, true),
  codexCommand: process.env.HER_CODEX_COMMAND ?? "codex",
  codexArgs: splitArgs(process.env.HER_CODEX_ARGS, ["app-server", "--listen", "stdio://"]),
  codexModel: process.env.HER_CODEX_MODEL ?? "",
  codexTurnTimeoutMs: boundedNumber(process.env.HER_CODEX_TURN_TIMEOUT_MS, 300000, 10000, 1800000),
  appleMusicCountry: process.env.HER_APPLE_MUSIC_COUNTRY ?? "us",
  allowedApps: splitList(process.env.HER_ALLOWED_APPS, [
    "Safari",
    "Google Chrome",
    "Mail",
    "Calendar",
    "Notes",
    "Music",
  ]),
  allowedDirectories: splitList(process.env.HER_ALLOWED_DIRECTORIES, [
    path.join(home, "Desktop"),
    path.join(home, "Documents"),
    path.join(home, "Downloads"),
  ]).map((item) => path.resolve(expandHome(item))),
  isolatedBrowserProfile: path.resolve(
    expandHome(process.env.HER_ISOLATED_BROWSER_PROFILE ?? "~/.her-voice-agent/chrome-profile"),
  ),
  browserDebugPort: Number(process.env.HER_BROWSER_DEBUG_PORT ?? "9223"),
  serverPort: Number(process.env.HER_SERVER_PORT ?? "3939"),
};

const readEnvValue = (filePath: string, envName: string) => {
  if (!fs.existsSync(filePath)) return "";
  const parsed = dotenv.parse(fs.readFileSync(filePath, "utf8"));
  return parsed[envName] ?? "";
};

export const readOpenaiApiKey = () =>
  process.env.OPENAI_API_KEY || readEnvValue(envLocalPath, "OPENAI_API_KEY") || readEnvValue(envPath, "OPENAI_API_KEY");

export const saveOpenaiApiKey = (apiKey: string) => {
  const trimmed = apiKey.trim();
  if (!/^sk-[A-Za-z0-9_-]{20,}$/.test(trimmed)) {
    throw new Error("Enter a valid OpenAI API key.");
  }

  const nextLine = `OPENAI_API_KEY=${trimmed}`;
  const existing = fs.existsSync(envLocalPath) ? fs.readFileSync(envLocalPath, "utf8") : "";
  const lines = existing.split(/\r?\n/);
  const existingIndex = lines.findIndex((line) => /^\s*OPENAI_API_KEY\s*=/.test(line));

  if (existingIndex >= 0) {
    lines[existingIndex] = nextLine;
  } else {
    if (existing && lines.at(-1) !== "") lines.push("");
    lines.push(nextLine);
  }

  fs.writeFileSync(envLocalPath, `${lines.filter((line, index) => index < lines.length - 1 || line !== "").join("\n")}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  process.env.OPENAI_API_KEY = trimmed;
  config.openaiApiKey = trimmed;
};

export const assertRuntimeConfig = () => {
  if (!readOpenaiApiKey()) {
    throw new Error("Missing OPENAI_API_KEY. Add it to .env.local before starting the assistant.");
  }
};
