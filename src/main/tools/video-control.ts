import { spawn } from "node:child_process";
import { BrowserAutomation } from "./browser-automation";

type VideoService = "youtube" | "apple_tv";

type ItunesVideoResult = {
  trackName?: string;
  artistName?: string;
  collectionName?: string;
  trackViewUrl?: string;
  previewUrl?: string;
  kind?: string;
};

type AppleTvSearchResult = ItunesVideoResult & {
  source?: "itunes_search" | "apple_tv_search";
};

type YouTubeSearchResult = { url: string; title?: string };
type AppleTvPlaybackSnapshot = {
  state?: string;
  title?: string;
};

const VIDEO_CACHE_TTL_MS = 60_000;
const youtubeCache = new Map<string, { createdAt: number; value: YouTubeSearchResult | null }>();
const appleTvCache = new Map<string, { createdAt: number; value: AppleTvSearchResult | null }>();

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

const appleScriptString = (value: string) => JSON.stringify(value);

export class VideoControl {
  constructor(private browser = new BrowserAutomation()) {}

  async play(service: VideoService, query: string) {
    if (service === "youtube") return this.playYouTube(query);
    return this.playAppleTv(query);
  }

  async appleTvPlaybackState() {
    return readAppleTvPlaybackState();
  }

  private async playYouTube(query: string) {
    const direct = normalizeYouTubeUrl(query);
    const resolved = direct ?? (await findYouTubeVideo(query));
    if (!resolved) {
      const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
      await this.browser.openIsolatedUrl(searchUrl);
      return {
        status: "opened_search",
        service: "youtube",
        query,
        url: searchUrl,
        resolved: false,
        retryRecommended: false,
        browser: "isolated_chrome",
        note: "Could not resolve a specific YouTube video from search results, so opened YouTube search in isolated Chrome.",
      };
    }

    await this.browser.openIsolatedUrl(resolved.url);
    await delay(1800);
    const playResult = await this.browser.playVideo().catch((error) => ({
      ok: false,
      error: "cdp_play_failed",
      message: error instanceof Error ? error.message : String(error),
    }));
    const videoState = await this.browser.readVideoState().catch((error) => ({
      error: "cdp_state_failed",
      message: error instanceof Error ? error.message : String(error),
    }));
    return {
      status: typeof playResult === "object" && playResult && "ok" in playResult && playResult.ok ? "playing" : "opened_video",
      service: "youtube",
      query,
      title: resolved.title,
      url: resolved.url,
      browser: "isolated_chrome",
      playResult,
      videoState,
      note: "Opened the resolved YouTube watch URL in isolated Chrome and attempted to start playback through CDP. Playback can still be blocked by browser policy, account prompts, ads, or consent screens.",
    };
  }

  private async playAppleTv(query: string) {
    const direct = isHttpUrl(query) ? query : undefined;
    const resolved = direct ? { trackViewUrl: direct } : await findAppleTvVideo(query);
    if (!resolved?.trackViewUrl) {
      const searchUrl = `https://tv.apple.com/search?term=${encodeURIComponent(query)}`;
      await run("open", ["-a", "TV", searchUrl]);
      return {
        status: "opened_search",
        service: "apple_tv",
        query,
        url: searchUrl,
        resolved: false,
        retryRecommended: false,
        note: "Could not resolve a specific Apple TV catalog item, so opened TV search.",
      };
    }

    const result = await openAppleTvUrl(resolved.trackViewUrl);
    return {
      status: "opened_video",
      service: "apple_tv",
      query,
      title: resolved.trackName ?? resolved.collectionName,
      artist: resolved.artistName,
      kind: resolved.kind,
      url: resolved.trackViewUrl,
      playbackConfirmed: false,
      playerState: result.snapshot.state,
      currentItem: result.snapshot.title ? { title: result.snapshot.title } : undefined,
      reasonCode: result.reasonCode,
      note: "Opened the Apple TV item and sent TV a play command, but Apple TV playback cannot be reliably verified through AppleScript. TV may require sign-in, subscription, purchase, or macOS Automation permission.",
    };
  }
}

const normalizeYouTubeUrl = (input: string): { url: string; title?: string } | null => {
  try {
    const url = new URL(input);
    const host = url.hostname.replace(/^www\./, "");
    let videoId = "";
    if (host === "youtu.be") videoId = url.pathname.split("/").filter(Boolean)[0] ?? "";
    if (host.endsWith("youtube.com")) videoId = url.searchParams.get("v") ?? "";
    if (!isYouTubeVideoId(videoId)) return null;
    return { url: youtubeWatchUrl(videoId) };
  } catch {
    return null;
  }
};

const findYouTubeVideo = async (query: string) => {
  const cached = youtubeCache.get(query.toLowerCase());
  if (cached && Date.now() - cached.createdAt < VIDEO_CACHE_TTL_MS) return cached.value;
  const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
  try {
    const response = await fetch(url, {
      headers: {
        "accept-language": "en-US,en;q=0.9",
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      },
      signal: AbortSignal.timeout(8000),
    });
    const html = await response.text();
    if (!response.ok) {
      youtubeCache.set(query.toLowerCase(), { createdAt: Date.now(), value: null });
      return null;
    }

    const id = firstYouTubeVideoId(html);
    if (!id) {
      youtubeCache.set(query.toLowerCase(), { createdAt: Date.now(), value: null });
      return null;
    }
    const value = { url: youtubeWatchUrl(id), title: titleForYouTubeId(html, id) };
    youtubeCache.set(query.toLowerCase(), { createdAt: Date.now(), value });
    return value;
  } catch {
    youtubeCache.set(query.toLowerCase(), { createdAt: Date.now(), value: null });
    return null;
  }
};

const firstYouTubeVideoId = (html: string) => {
  const seen = new Set<string>();
  for (const match of html.matchAll(/"videoId":"([a-zA-Z0-9_-]{11})"/g)) {
    const id = match[1];
    if (seen.has(id)) continue;
    seen.add(id);
    return id;
  }
  for (const match of html.matchAll(/watch\?v=([a-zA-Z0-9_-]{11})/g)) {
    const id = match[1];
    if (seen.has(id)) continue;
    seen.add(id);
    return id;
  }
  return "";
};

const titleForYouTubeId = (html: string, videoId: string) => {
  const index = html.indexOf(`"videoId":"${videoId}"`);
  if (index < 0) return undefined;
  const slice = html.slice(index, index + 4000);
  const match = /"title":\{"runs":\[\{"text":"([^"]+)"/.exec(slice) ?? /"title":\{"simpleText":"([^"]+)"/.exec(slice);
  return match?.[1] ? decodeJsonString(match[1]) : undefined;
};

const decodeJsonString = (value: string) => {
  try {
    return JSON.parse(`"${value.replace(/"/g, '\\"')}"`) as string;
  } catch {
    return value;
  }
};

const youtubeWatchUrl = (videoId: string) => `https://www.youtube.com/watch?v=${videoId}&autoplay=1`;

const isYouTubeVideoId = (value: string) => /^[a-zA-Z0-9_-]{11}$/.test(value);

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const isHttpUrl = (value: string) => {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "com.apple.tv:";
  } catch {
    return false;
  }
};

const findAppleTvVideo = async (query: string): Promise<AppleTvSearchResult | null> => {
  const cached = appleTvCache.get(query.toLowerCase());
  if (cached && Date.now() - cached.createdAt < VIDEO_CACHE_TTL_MS) return cached.value;
  const [movie, episode] = await Promise.all([searchItunes(query, "movie", "movie"), searchItunes(query, "tvShow", "tvEpisode")]);
  const value = movie
    ? { ...movie, source: "itunes_search" as const }
    : episode
      ? { ...episode, source: "itunes_search" as const }
      : await findAppleTvSearchResult(query);
  appleTvCache.set(query.toLowerCase(), { createdAt: Date.now(), value });
  return value;
};

const searchItunes = async (term: string, media: string, entity: string): Promise<ItunesVideoResult | null> => {
  const url = new URL("https://itunes.apple.com/search");
  url.searchParams.set("media", media);
  url.searchParams.set("entity", entity);
  url.searchParams.set("limit", "1");
  url.searchParams.set("term", term);

  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    const payload = (await response.json().catch(() => ({}))) as { results?: ItunesVideoResult[] };
    return response.ok ? (payload.results?.[0] ?? null) : null;
  } catch {
    return null;
  }
};

const findAppleTvSearchResult = async (query: string): Promise<AppleTvSearchResult | null> => {
  const searchUrl = `https://tv.apple.com/search?term=${encodeURIComponent(query)}`;
  try {
    const response = await fetch(searchUrl, {
      headers: {
        "accept-language": "en-US,en;q=0.9",
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      },
      signal: AbortSignal.timeout(8000),
    });
    const html = await response.text();
    if (!response.ok) return null;

    const direct = firstAppleTvUrl(html);
    if (!direct) return null;
    return {
      trackViewUrl: direct,
      trackName: titleFromAppleTvUrl(direct),
      source: "apple_tv_search",
    };
  } catch {
    return null;
  }
};

const firstAppleTvUrl = (html: string) => {
  const absolute = /https:\/\/tv\.apple\.com\/[a-z]{2}\/(?:show|movie|episode)\/[^"'<\\]+/.exec(html);
  if (absolute?.[0]) return cleanupAppleTvUrl(absolute[0]);

  const relative = /\/[a-z]{2}\/(?:show|movie|episode)\/[^"'<\\]+/.exec(html);
  return relative?.[0] ? cleanupAppleTvUrl(`https://tv.apple.com${relative[0]}`) : "";
};

const cleanupAppleTvUrl = (url: string) => url.replace(/\\u002F/g, "/").replace(/&amp;/g, "&");

const titleFromAppleTvUrl = (url: string) => {
  try {
    const parts = new URL(url).pathname.split("/").filter(Boolean);
    const slug = parts[2] ?? "";
    return slug
      .split("-")
      .filter(Boolean)
      .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
      .join(" ");
  } catch {
    return undefined;
  }
};

const openAppleTvUrl = async (url: string) => {
  const script = `
    tell application "TV"
      activate
      try
        open location ${appleScriptString(url)}
        delay 2
        play
        delay 1
        set playerState to ""
        set itemTitle to ""
        try
          set playerState to player state as text
        end try
        try
          set itemTitle to name of current track
        end try
        return playerState & "|" & itemTitle
      on error errMsg number errNo
        return "error|" & errNo & "|" & errMsg
      end try
    end tell
  `;
  const output = await run("osascript", ["-e", script]);
  const snapshot = parseAppleTvPlaybackSnapshot(output);
  await run("open", ["-a", "TV", url]);
  return {
    snapshot,
    reasonCode: snapshot.state === "playing" ? "apple_tv_state_playing_unverified" : "apple_tv_playback_unverified",
  };
};

const readAppleTvPlaybackState = async () => {
  const output = await run("osascript", ["-e", appleTvPlaybackStateScript()], 5000);
  const snapshot = parseAppleTvPlaybackSnapshot(output);
  return {
    app: "TV",
    running: snapshot.state !== "not_running",
    state: snapshot.state,
    currentItem: snapshot.title ? { title: snapshot.title } : undefined,
    note: "Apple TV exposes only limited AppleScript state; a playing state may not prove the requested catalog item is playing.",
  };
};

const parseAppleTvPlaybackSnapshot = (output: string): AppleTvPlaybackSnapshot => {
  if (output.startsWith("error|")) return { state: "error" };
  const [state, title] = output.split("|");
  return { state: state || undefined, title: title || undefined };
};

const appleTvPlaybackStateScript = () => `
  tell application "System Events"
    set isRunning to exists process "TV"
  end tell
  if not isRunning then return "not_running|"
  tell application "TV"
    try
      set playerState to ""
      set itemTitle to ""
      try
        set playerState to player state as text
      end try
      try
        set itemTitle to name of current track
      end try
      return playerState & "|" & itemTitle
    on error errMsg number errNo
      return "error|" & errNo & "|" & errMsg
    end try
  end tell
`;
