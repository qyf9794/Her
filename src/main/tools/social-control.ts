import { spawn } from "node:child_process";
import { config } from "../config";
import { BrowserAutomation } from "./browser-automation";

type SocialOpenService = "x" | "xiaohongshu";
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

  async searchX(query: string, limit = 10) {
    if (!config.xBearerToken) {
      return {
        status: "missing_config",
        service: "x",
        missing: ["HER_X_BEARER_TOKEN"],
        note: "X read/search needs an official X API bearer token.",
      };
    }

    const url = new URL(`${config.xApiBaseUrl}/2/tweets/search/recent`);
    url.searchParams.set("query", query);
    url.searchParams.set("max_results", String(Math.max(10, Math.min(100, limit))));
    url.searchParams.set("tweet.fields", "author_id,created_at,public_metrics,lang");
    url.searchParams.set("expansions", "author_id");
    url.searchParams.set("user.fields", "username,name,verified");

    const payload = await fetchJson(url, config.xBearerToken);
    return {
      status: "ok",
      service: "x",
      query,
      result: payload,
      note: "Read using the official X API v2 recent search endpoint.",
    };
  }

  async postX(text: string, replyToTweetId?: string) {
    if (!config.xUserAccessToken) {
      return {
        status: "missing_config",
        service: "x",
        missing: ["HER_X_USER_ACCESS_TOKEN"],
        note: "X posting needs a user-context OAuth token with write permission.",
      };
    }

    const body: Record<string, unknown> = { text };
    if (replyToTweetId) body.reply = { in_reply_to_tweet_id: replyToTweetId };
    const payload = await fetchJson(new URL(`${config.xApiBaseUrl}/2/tweets`), config.xUserAccessToken, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return {
      status: "posted",
      service: "x",
      result: payload,
      note: "Created through the official X API v2 create Post endpoint.",
    };
  }

  async open(service: SocialOpenService, kind: SocialOpenKind, target?: string, isolated = true) {
    if (service === "xiaohongshu") assertXiaohongshuOpenAllowed(kind, target);
    const url = socialUrl(service, kind, target);
    if (isolated) await this.browser.openIsolatedUrl(url);
    else await run("open", [url]);
    return {
      status: "opened",
      service,
      kind,
      target,
      url,
      browser: isolated ? "isolated_chrome" : "default_browser",
      note:
        service === "xiaohongshu"
          ? "Opened only. HER does not automate Xiaohongshu publishing or sensitive account actions."
          : "Opened the social page for viewing.",
    };
  }
}

const fetchJson = async (url: URL, token: string, init: RequestInit = {}) => {
  const response = await fetch(url, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json",
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(10000),
  });
  const payload = (await response.json().catch(() => ({}))) as unknown;
  if (!response.ok) {
    throw new Error(`X API request failed with ${response.status}: ${JSON.stringify(payload).slice(0, 500)}`);
  }
  return payload;
};

const socialUrl = (service: SocialOpenService, kind: SocialOpenKind, target?: string) => {
  const value = (target ?? "").trim();
  if (value && isHttpUrl(value)) return value;

  if (service === "x") {
    if (kind === "search") return `https://x.com/search?q=${encodeURIComponent(value)}&src=typed_query`;
    if (kind === "profile") return `https://x.com/${encodeURIComponent(value.replace(/^@/, ""))}`;
    return "https://x.com/home";
  }

  if (kind === "search") return `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(value)}`;
  if ((kind === "note" || kind === "share") && value) return `https://www.xiaohongshu.com/explore/${encodeURIComponent(value)}`;
  return "https://www.xiaohongshu.com/explore";
};

const assertXiaohongshuOpenAllowed = (kind: SocialOpenKind, target?: string) => {
  if (!["search", "note", "share"].includes(kind)) {
    throw new Error("Xiaohongshu supports only opening search, note, or share pages.");
  }

  const value = (target ?? "").trim();
  if (!value || !isHttpUrl(value)) return;

  const url = new URL(value);
  const host = url.hostname.replace(/^www\./, "");
  const isXiaohongshuHost = host === "xiaohongshu.com" || host.endsWith(".xiaohongshu.com");
  const isXhsShortHost = host === "xhslink.com" || host.endsWith(".xhslink.com");
  const isSearchPage = isXiaohongshuHost && url.pathname.startsWith("/search_result");
  const isNotePage = isXiaohongshuHost && url.pathname.startsWith("/explore/");
  const isSharePage = isXhsShortHost;

  if (kind === "search" && !isSearchPage) {
    throw new Error("Xiaohongshu search opens only xiaohongshu.com/search_result pages.");
  }
  if ((kind === "note" || kind === "share") && !isNotePage && !isSharePage) {
    throw new Error("Xiaohongshu note/share opens only xiaohongshu.com/explore or xhslink.com pages.");
  }
};

const isHttpUrl = (value: string) => {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
};
