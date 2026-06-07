import { spawn } from "node:child_process";
import { BrowserAutomation } from "./browser-automation";

type SocialService = "x" | "xiaohongshu";
type SocialOpenKind = "home" | "search" | "profile" | "note" | "share";

const run = (command: string, args: string[], timeoutMs = 8000) =>
  new Promise<string>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${command} timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.trim() || `${command} exited with code ${code}`));
    });
  });

export class SocialControl {
  constructor(private browser = new BrowserAutomation()) {}

  async searchX(query: string, limit: number) {
    const bearerToken = process.env.HER_X_BEARER_TOKEN;
    if (!bearerToken) return missingConfig("x", ["HER_X_BEARER_TOKEN"]);

    const url = new URL("https://api.x.com/2/tweets/search/recent");
    url.searchParams.set("query", query);
    url.searchParams.set("max_results", String(Math.max(10, Math.min(100, limit))));
    url.searchParams.set("tweet.fields", "created_at,author_id,public_metrics");
    const payload = await fetchJson(url, {
      headers: { authorization: `Bearer ${bearerToken}` },
    });
    return {
      status: "ok",
      service: "x",
      query,
      results: payload,
      note: "Searched recent posts with the official X API.",
    };
  }

  async postX(text: string, replyToTweetId?: string) {
    const accessToken = process.env.HER_X_ACCESS_TOKEN;
    if (!accessToken) return missingConfig("x", ["HER_X_ACCESS_TOKEN"]);

    const body = {
      text,
      ...(replyToTweetId ? { reply: { in_reply_to_tweet_id: replyToTweetId } } : {}),
    };
    const payload = await fetchJson(new URL("https://api.x.com/2/tweets"), {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    return {
      status: "posted",
      service: "x",
      id: readPostedTweetId(payload),
      note: "Created the post with the official X API.",
    };
  }

  async open(service: SocialService, kind: SocialOpenKind, target?: string, isolated = true) {
    const url = socialUrl(service, kind, target);
    if (isolated) {
      const result = await this.browser.openIsolatedUrl(url);
      return { status: "opened", service, kind, target, url, browser: "isolated_chrome", result };
    }
    await run("open", [url]);
    return { status: "opened", service, kind, target, url };
  }
}

const fetchJson = async (url: URL, init: RequestInit = {}) => {
  const response = await fetch(url, {
    ...init,
    headers: {
      accept: "application/json",
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(10000),
  });
  const payload = (await response.json().catch(() => ({}))) as unknown;
  if (!response.ok) {
    throw new Error(`Social API request failed with ${response.status}: ${JSON.stringify(payload).slice(0, 500)}`);
  }
  return payload;
};

const socialUrl = (service: SocialService, kind: SocialOpenKind, target?: string) => {
  const trimmed = target?.trim() ?? "";
  if (trimmed && isHttpUrl(trimmed)) return trimmed;

  if (service === "x") {
    if (kind === "home") return "https://x.com/home";
    if (kind === "profile" && trimmed) return `https://x.com/${encodeURIComponent(trimmed.replace(/^@/, ""))}`;
    return `https://x.com/search?q=${encodeURIComponent(trimmed)}&src=typed_query`;
  }

  if ((kind === "note" || kind === "share") && trimmed) return `https://www.xiaohongshu.com/explore/${encodeURIComponent(trimmed)}`;
  return `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(trimmed)}`;
};

const isHttpUrl = (value: string) => {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
};

const readPostedTweetId = (payload: unknown) =>
  typeof payload === "object" && payload && "data" in payload
    ? (payload as { data?: { id?: string } }).data?.id
    : undefined;

const missingConfig = (service: string, missing: string[]) => ({
  status: "missing_config",
  service,
  missing,
  note: "Configure the required environment variable in the main process before using this official API adapter.",
});
