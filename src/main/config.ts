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

const commonExecutableDirectories = [
  "/Applications/Codex.app/Contents/Resources",
  "/opt/homebrew/bin",
  "/usr/local/bin",
  path.join(home, ".local/bin"),
  path.join(home, ".npm-global/bin"),
  "/usr/bin",
  "/bin",
];

const isExecutableFile = (filePath: string) => {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
};

export const resolveCommandPath = (command: string, extraDirectories: string[] = []) => {
  const trimmed = command.trim();
  if (!trimmed) return trimmed;
  const expanded = expandHome(trimmed);
  if (expanded.includes(path.sep)) return expanded;

  const pathDirectories = (process.env.PATH ?? "")
    .split(path.delimiter)
    .map((item) => item.trim())
    .filter(Boolean);
  for (const directory of [...pathDirectories, ...extraDirectories]) {
    const candidate = path.join(expandHome(directory), expanded);
    if (isExecutableFile(candidate)) return candidate;
  }
  return expanded;
};

export const resolveCodexCommand = (command = process.env.HER_CODEX_COMMAND ?? "codex") =>
  resolveCommandPath(command, commonExecutableDirectories);

const resolveRealtimeVoice = (value: string | undefined): RealtimeVoice => {
  const normalized = value?.trim().toLowerCase();
  return normalized && isRealtimeVoice(normalized) ? normalized : realtimeDefaultVoice;
};

type UpdateChannel = "stable" | "beta" | "canary";

const resolveUpdateChannel = (value: string | undefined): UpdateChannel => {
  const normalized = value?.trim().toLowerCase();
  return normalized === "beta" || normalized === "canary" ? normalized : "stable";
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
  codexCommand: resolveCodexCommand(),
  codexArgs: splitArgs(process.env.HER_CODEX_ARGS, ["app-server", "--listen", "stdio://"]),
  codexModel: process.env.HER_CODEX_MODEL ?? "",
  codexTurnTimeoutMs: boundedNumber(process.env.HER_CODEX_TURN_TIMEOUT_MS, 300000, 10000, 1800000),
  codexNativeToolsFallback: booleanEnv(process.env.HER_CODEX_NATIVE_TOOLS_FALLBACK, true),
  updateChannel: resolveUpdateChannel(process.env.HER_UPDATE_CHANNEL),
  updateFeedUrl: process.env.HER_UPDATE_FEED_URL ?? "",
  appleMusicCountry: process.env.HER_APPLE_MUSIC_COUNTRY ?? "us",
  appleMusicDeveloperToken: process.env.HER_APPLE_MUSIC_DEVELOPER_TOKEN ?? "",
  appleMusicTeamId: process.env.APPLE_TEAM_ID || process.env.HER_APPLE_MUSIC_TEAM_ID || "",
  appleMusicKeyId: process.env.APPLE_MUSICKIT_KEY_ID || process.env.HER_APPLE_MUSIC_KEY_ID || "",
  appleMusicPrivateKeyPath: process.env.HER_APPLE_MUSIC_PRIVATE_KEY_PATH ?? "",
  spotifyAccessToken: process.env.HER_SPOTIFY_ACCESS_TOKEN ?? "",
  spotifyDeviceId: process.env.HER_SPOTIFY_DEVICE_ID ?? "",
  spotifyMarket: process.env.HER_SPOTIFY_MARKET ?? "US",
  youtubeApiKey: process.env.HER_YOUTUBE_API_KEY ?? "",
  xBearerToken: process.env.HER_X_BEARER_TOKEN ?? "",
  xUserAccessToken: process.env.HER_X_USER_ACCESS_TOKEN ?? process.env.HER_X_BEARER_TOKEN ?? "",
  xApiBaseUrl: process.env.HER_X_API_BASE_URL ?? "https://api.x.com",
  secUserAgent: process.env.HER_SEC_USER_AGENT ?? "HER local assistant qyf@example.com",
  blsApiKey: process.env.HER_BLS_API_KEY ?? "",
  alphaVantageApiKey: process.env.HER_ALPHA_VANTAGE_API_KEY ?? "",
  newsApiKey: process.env.HER_NEWS_API_KEY ?? "",
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

export type AppleMusicConfigInput = {
  keyName?: string;
  teamId?: string;
  keyId?: string;
  privateKeyPath?: string;
};

export const readAppleMusicConfig = () => {
  const keyName = process.env.HER_APPLE_MUSIC_KEY_NAME || readEnvValue(envLocalPath, "HER_APPLE_MUSIC_KEY_NAME") || readEnvValue(envPath, "HER_APPLE_MUSIC_KEY_NAME");
  const teamId = process.env.APPLE_TEAM_ID || process.env.HER_APPLE_MUSIC_TEAM_ID || readEnvValue(envLocalPath, "HER_APPLE_MUSIC_TEAM_ID") || readEnvValue(envPath, "HER_APPLE_MUSIC_TEAM_ID");
  const keyId = process.env.APPLE_MUSICKIT_KEY_ID || process.env.HER_APPLE_MUSIC_KEY_ID || readEnvValue(envLocalPath, "HER_APPLE_MUSIC_KEY_ID") || readEnvValue(envPath, "HER_APPLE_MUSIC_KEY_ID");
  const privateKeyPath = process.env.HER_APPLE_MUSIC_PRIVATE_KEY_PATH || readEnvValue(envLocalPath, "HER_APPLE_MUSIC_PRIVATE_KEY_PATH") || readEnvValue(envPath, "HER_APPLE_MUSIC_PRIVATE_KEY_PATH");
  return {
    keyName,
    teamId,
    keyId,
    privateKeyPath,
    configured: Boolean(teamId && keyId && privateKeyPath),
  };
};

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

export const saveAppleMusicConfig = (input: AppleMusicConfigInput) => {
  const keyName = input.keyName?.trim() ?? "";
  const teamId = input.teamId?.trim() ?? "";
  const keyId = input.keyId?.trim() ?? "";
  const privateKeyPath = input.privateKeyPath?.trim() ?? "";

  if (keyName && keyName.length > 120) throw new Error("Apple Music key name is too long.");
  if (!/^[A-Z0-9]{10}$/.test(teamId)) throw new Error("Enter a valid 10-character Apple Team ID.");
  if (!/^[A-Z0-9]{10}$/.test(keyId)) throw new Error("Enter a valid 10-character Apple Music Key ID.");
  if (!privateKeyPath || !path.isAbsolute(privateKeyPath)) throw new Error("Enter an absolute path to the Apple .p8 private key file.");
  if (path.extname(privateKeyPath).toLowerCase() !== ".p8") throw new Error("Apple Music private key path must point to a .p8 file.");
  if (!fs.existsSync(privateKeyPath) || !fs.statSync(privateKeyPath).isFile()) throw new Error("Apple Music .p8 private key file was not found.");

  writeEnvValue(envLocalPath, "HER_APPLE_MUSIC_KEY_NAME", keyName || undefined);
  writeEnvValue(envLocalPath, "HER_APPLE_MUSIC_TEAM_ID", teamId);
  writeEnvValue(envLocalPath, "HER_APPLE_MUSIC_KEY_ID", keyId);
  writeEnvValue(envLocalPath, "HER_APPLE_MUSIC_PRIVATE_KEY_PATH", privateKeyPath);

  if (keyName) process.env.HER_APPLE_MUSIC_KEY_NAME = keyName;
  else delete process.env.HER_APPLE_MUSIC_KEY_NAME;
  process.env.HER_APPLE_MUSIC_TEAM_ID = teamId;
  process.env.HER_APPLE_MUSIC_KEY_ID = keyId;
  process.env.HER_APPLE_MUSIC_PRIVATE_KEY_PATH = privateKeyPath;
  config.appleMusicTeamId = teamId;
  config.appleMusicKeyId = keyId;
  config.appleMusicPrivateKeyPath = privateKeyPath;

  return readAppleMusicConfig();
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
