import { spawn } from "node:child_process";

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

const run = (command: string, args: string[]) =>
  new Promise<string>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.trim() || `${command} exited with code ${code}`));
    });
  });

const appleScriptString = (value: string) => JSON.stringify(value);

export class VideoControl {
  async play(service: VideoService, query: string) {
    if (service === "youtube") return this.playYouTube(query);
    return this.playAppleTv(query);
  }

  private async playYouTube(query: string) {
    const direct = normalizeYouTubeUrl(query);
    const resolved = direct ?? (await findYouTubeVideo(query));
    if (!resolved) {
      const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
      await run("open", [searchUrl]);
      return {
        status: "opened_search",
        service: "youtube",
        query,
        url: searchUrl,
        note: "Could not resolve a specific YouTube video from search results, so opened YouTube search.",
      };
    }

    await run("open", [resolved.url]);
    return {
      status: "opened_video",
      service: "youtube",
      query,
      title: resolved.title,
      url: resolved.url,
      note: "Opened the resolved YouTube watch URL. YouTube autoplay can still be blocked by browser policy, account prompts, ads, or consent screens.",
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
        note: "Could not resolve a specific Apple TV catalog item, so opened TV search.",
      };
    }

    const result = await openAppleTvUrl(resolved.trackViewUrl);
    return {
      status: result.startedPlayback ? "playing" : "opened_video",
      service: "apple_tv",
      query,
      title: resolved.trackName ?? resolved.collectionName,
      artist: resolved.artistName,
      kind: resolved.kind,
      url: resolved.trackViewUrl,
      note: result.startedPlayback
        ? "Opened the Apple TV item and sent TV a play command."
        : "Opened the Apple TV item. TV may require sign-in, subscription, purchase, or macOS Automation permission before playback starts.",
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
    if (!response.ok) return null;

    const id = firstYouTubeVideoId(html);
    if (!id) return null;
    return { url: youtubeWatchUrl(id), title: titleForYouTubeId(html, id) };
  } catch {
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

const isHttpUrl = (value: string) => {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "com.apple.tv:";
  } catch {
    return false;
  }
};

const findAppleTvVideo = async (query: string): Promise<AppleTvSearchResult | null> => {
  const [movie, episode] = await Promise.all([searchItunes(query, "movie", "movie"), searchItunes(query, "tvShow", "tvEpisode")]);
  if (movie) return { ...movie, source: "itunes_search" };
  if (episode) return { ...episode, source: "itunes_search" };
  return findAppleTvSearchResult(query);
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
        return "playing"
      on error errMsg number errNo
        return "error|" & errNo & "|" & errMsg
      end try
    end tell
  `;
  const output = await run("osascript", ["-e", script]);
  if (output === "playing") return { startedPlayback: true };

  await run("open", ["-a", "TV", url]);
  return { startedPlayback: false };
};
