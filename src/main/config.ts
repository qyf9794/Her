import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import dotenv from "dotenv";
import { isRealtimeVoice, realtimeDefaultVoice, type RealtimeVoice } from "../shared/realtime-config";

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

const resolveRealtimeVoice = (value: string | undefined): RealtimeVoice => {
  const normalized = value?.trim().toLowerCase();
  return normalized && isRealtimeVoice(normalized) ? normalized : realtimeDefaultVoice;
};

export const config = {
  openaiApiKey: process.env.OPENAI_API_KEY ?? "",
  realtimeMode,
  realtimeModel: process.env.HER_REALTIME_MODEL ?? (realtimeMode === "economy" ? "gpt-realtime-mini" : "gpt-realtime-2"),
  realtimeEconomyModel: process.env.HER_REALTIME_ECONOMY_MODEL ?? "gpt-realtime-mini",
  realtimeVoice: resolveRealtimeVoice(process.env.HER_REALTIME_VOICE),
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
  toolQueueTaskTimeoutMs: boundedNumber(process.env.HER_TOOL_QUEUE_TASK_TIMEOUT_MS, 30000, 1000, 300000),
  codexEnabled: booleanEnv(process.env.HER_CODEX_ENABLED, true),
  codexCommand: process.env.HER_CODEX_COMMAND ?? "codex",
  codexArgs: splitArgs(process.env.HER_CODEX_ARGS, ["app-server", "--listen", "stdio://"]),
  codexModel: process.env.HER_CODEX_MODEL ?? "",
  codexTurnTimeoutMs: boundedNumber(process.env.HER_CODEX_TURN_TIMEOUT_MS, 300000, 10000, 1800000),
  codexNativeToolsFallback: booleanEnv(process.env.HER_CODEX_NATIVE_TOOLS_FALLBACK, true),
  appleMusicCountry: process.env.HER_APPLE_MUSIC_COUNTRY ?? "us",
  spotifyAccessToken: process.env.HER_SPOTIFY_ACCESS_TOKEN ?? "",
  spotifyDeviceId: process.env.HER_SPOTIFY_DEVICE_ID ?? "",
  spotifyMarket: process.env.HER_SPOTIFY_MARKET ?? "",
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

export const readCodexModel = () =>
  process.env.HER_CODEX_MODEL || readEnvValue(envLocalPath, "HER_CODEX_MODEL") || readEnvValue(envPath, "HER_CODEX_MODEL");

export const readRealtimeVoice = () =>
  resolveRealtimeVoice(process.env.HER_REALTIME_VOICE || readEnvValue(envLocalPath, "HER_REALTIME_VOICE") || readEnvValue(envPath, "HER_REALTIME_VOICE"));

export const saveOpenaiApiKey = (apiKey: string) => {
  const trimmed = apiKey.trim();
  if (!/^sk-[A-Za-z0-9_-]{20,}$/.test(trimmed)) {
    throw new Error("Enter a valid OpenAI API key.");
  }

  writeEnvValue(envLocalPath, "OPENAI_API_KEY", trimmed);
  process.env.OPENAI_API_KEY = trimmed;
  config.openaiApiKey = trimmed;
};

export const saveCodexModel = (model: string) => {
  const trimmed = model.trim();
  if (trimmed && !/^[A-Za-z0-9._:/-]{1,120}$/.test(trimmed)) {
    throw new Error("Enter a valid model id.");
  }

  writeEnvValue(envLocalPath, "HER_CODEX_MODEL", trimmed || undefined);
  if (trimmed) process.env.HER_CODEX_MODEL = trimmed;
  else delete process.env.HER_CODEX_MODEL;
  config.codexModel = trimmed;
  return trimmed;
};

export const saveRealtimeVoice = (voice: string) => {
  const normalized = voice.trim().toLowerCase();
  if (!isRealtimeVoice(normalized)) {
    throw new Error("Choose a supported Realtime voice.");
  }

  writeEnvValue(envLocalPath, "HER_REALTIME_VOICE", normalized);
  process.env.HER_REALTIME_VOICE = normalized;
  config.realtimeVoice = normalized;
  return normalized;
};

const writeEnvValue = (filePath: string, envName: string, value: string | undefined) => {
  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
  const lines = existing.split(/\r?\n/);
  const envPattern = new RegExp(`^\\s*${envName}\\s*=`);
  const existingIndex = lines.findIndex((line) => envPattern.test(line));
  const nextLine = typeof value === "string" ? `${envName}=${value}` : undefined;

  if (existingIndex >= 0 && nextLine) {
    lines[existingIndex] = nextLine;
  } else if (existingIndex >= 0) {
    lines.splice(existingIndex, 1);
  } else if (nextLine) {
    if (existing && lines.at(-1) !== "") lines.push("");
    lines.push(nextLine);
  }

  fs.writeFileSync(filePath, `${lines.filter((line, index) => index < lines.length - 1 || line !== "").join("\n")}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
};

export const assertRuntimeConfig = () => {
  if (!readOpenaiApiKey()) {
    throw new Error("Missing OPENAI_API_KEY. Add it to .env.local before starting the assistant.");
  }
};
