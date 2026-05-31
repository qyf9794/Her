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

const expandHome = (value: string) => {
  if (value === "~") return home;
  if (value.startsWith("~/")) return path.join(home, value.slice(2));
  return value;
};

export const config = {
  openaiApiKey: process.env.OPENAI_API_KEY ?? "",
  realtimeModel: process.env.HER_REALTIME_MODEL ?? "gpt-realtime-2",
  realtimeVoice: process.env.HER_REALTIME_VOICE ?? "marin",
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
