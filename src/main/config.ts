import path from "node:path";
import os from "node:os";
import dotenv from "dotenv";

dotenv.config({ path: path.join(process.cwd(), ".env.local") });
dotenv.config({ path: path.join(process.cwd(), ".env") });

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

export const assertRuntimeConfig = () => {
  if (!config.openaiApiKey) {
    throw new Error("Missing OPENAI_API_KEY. Add it to .env.local before starting the assistant.");
  }
};
