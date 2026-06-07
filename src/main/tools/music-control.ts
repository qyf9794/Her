import { spawn } from "node:child_process";
import { config } from "../config";

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

type AppleMusicSearchResult = {
  trackName?: string;
  artistName?: string;
  trackViewUrl?: string;
};

type SpotifyTrack = {
  id: string;
  uri: string;
  name: string;
  external_urls?: { spotify?: string };
  artists?: Array<{ name?: string }>;
  album?: { name?: string };
};

type MusicPlaybackSnapshot = {
  state?: string;
  title?: string;
  artist?: string;
};

const catalogCache = new Map<string, { createdAt: number; value: AppleMusicSearchResult | null }>();
const CATALOG_CACHE_TTL_MS = 60_000;

export class MusicControl {
  async open() {
    await run("open", ["-a", "Music"]);
    return { opened: "Music" };
  }

  async playbackState() {
    const output = await run("osascript", ["-e", musicPlaybackStateScript()], 10000);
    const snapshot = parsePlaybackSnapshot(output);
    return {
      app: "Music",
      running: snapshot.state !== "not_running",
      state: snapshot.state,
      currentTrack: snapshot.title ? { title: snapshot.title, artist: snapshot.artist } : undefined,
    };
  }

  async playSong(query: string, artist?: string, mode: "play" | "search" = "play") {
    const searchText = [query, artist].filter(Boolean).join(" ");
    if (mode === "search") {
      const searchUrl = `https://music.apple.com/search?term=${encodeURIComponent(searchText)}`;
      await run("open", ["-a", "Music", searchUrl]);
      return {
        status: "opened_search",
        query: searchText,
        url: searchUrl,
        note: "Opened Apple Music search results so you can choose the song.",
      };
    }

    let output = "not_found";
    for (const localSearchText of localMusicSearchTerms(searchText)) {
      output = await run("osascript", ["-e", localMusicSearchScript(localSearchText)], 15000);
      if (output.startsWith("played|")) {
        const [, title, trackArtist] = output.split("|");
        return {
          status: "playing",
          title,
          artist: trackArtist || undefined,
          source: "local_music_library",
          query: localSearchText,
        };
      }
    }

    const catalogTrack = await findAppleMusicTrack(searchText);
    if (catalogTrack?.trackViewUrl) {
      const result = await playAppleMusicUrl(catalogTrack.trackViewUrl, catalogTrack);
      return {
        status: result.startedPlayback ? "playing" : "opened_track",
        reasonCode: result.startedPlayback ? "playing_confirmed" : result.reasonCode,
        title: catalogTrack.trackName,
        artist: catalogTrack.artistName,
        url: catalogTrack.trackViewUrl,
        source: "apple_music_catalog",
        playerState: result.snapshot.state,
        currentTrack: result.snapshot.title
          ? { title: result.snapshot.title, artist: result.snapshot.artist }
          : undefined,
        note: result.startedPlayback
          ? "Music is playing the requested catalog track."
          : "Opened the Apple Music catalog track, but playback was not confirmed. Please click Play in Music if the track page is visible.",
      };
    }

    const searchUrl = `https://music.apple.com/search?term=${encodeURIComponent(searchText)}`;
    await run("open", ["-a", "Music", searchUrl]);
    return {
      status: "opened_search",
      query: searchText,
      url: searchUrl,
      note:
        output.startsWith("error|")
          ? "Could not search local Music library via AppleScript, so opened Apple Music search."
          : "No local library match found, so opened Apple Music search.",
    };
  }

  async searchSpotify(query: string, artist?: string, limit = 5) {
    const searchText = [query, artist].filter(Boolean).join(" ");
    if (!config.spotifyAccessToken) return missingSpotifyConfig(["HER_SPOTIFY_ACCESS_TOKEN"]);
    const tracks = await spotifySearchTracks(searchText, limit);
    return {
      status: "ok",
      service: "spotify",
      query: searchText,
      tracks: tracks.map(formatSpotifyTrack),
      note: "Searched with Spotify's official Web API.",
    };
  }

  async playSpotifyTrack(query: string, artist?: string, deviceId?: string) {
    const searchText = [query, artist].filter(Boolean).join(" ");
    if (!config.spotifyAccessToken) return missingSpotifyConfig(["HER_SPOTIFY_ACCESS_TOKEN"]);
    const [track] = await spotifySearchTracks(searchText, 1);
    if (!track) {
      return {
        status: "not_found",
        service: "spotify",
        query: searchText,
        note: "Spotify search returned no playable track.",
      };
    }

    const targetDevice = deviceId || config.spotifyDeviceId || (await firstSpotifyDeviceId());
    if (!targetDevice) {
      return {
        status: "needs_active_device",
        service: "spotify",
        query: searchText,
        track: formatSpotifyTrack(track),
        missing: ["active Spotify device or HER_SPOTIFY_DEVICE_ID"],
        note: "Open Spotify on one device, start any playback once, or set HER_SPOTIFY_DEVICE_ID. Spotify Web API playback also requires a Premium account.",
      };
    }

    const url = new URL("https://api.spotify.com/v1/me/player/play");
    url.searchParams.set("device_id", targetDevice);
    await spotifyFetch(url, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ uris: [track.uri] }),
    });
    return {
      status: "playing_requested",
      service: "spotify",
      query: searchText,
      deviceId: targetDevice,
      track: formatSpotifyTrack(track),
      note: "Sent Spotify's official Start/Resume Playback request. Playback depends on account, device, and Premium eligibility.",
    };
  }

  async spotifyPlaybackState() {
    if (!config.spotifyAccessToken) return missingSpotifyConfig(["HER_SPOTIFY_ACCESS_TOKEN"]);
    const payload = await spotifyFetch(new URL("https://api.spotify.com/v1/me/player"), { method: "GET" });
    return {
      status: "ok",
      service: "spotify",
      playback: payload,
      note: "Read playback state with Spotify's official Web API.",
    };
  }

  async openNetease(query?: string, targetUrl?: string) {
    const url = targetUrl && isHttpUrl(targetUrl)
      ? targetUrl
      : query?.trim()
        ? `https://music.163.com/#/search/m/?s=${encodeURIComponent(query.trim())}`
        : "https://music.163.com/";
    const openedApp = await openNeteaseApp().then(() => true).catch(() => false);
    if (!openedApp) await run("open", [url]);
    return {
      status: "opened",
      service: "netease_cloud_music",
      query,
      url,
      target: openedApp ? "app" : "web",
      note: openedApp
        ? "Opened NetEase Cloud Music app. Direct playback is not claimed."
        : "NetEase Cloud Music app was not available, so opened the official web page. Direct playback is not claimed.",
    };
  }

  async openQqMusic(query?: string, target: "app" | "web" = "app") {
    const normalizedQuery = query?.trim();
    const searchUrl = normalizedQuery
      ? `https://y.qq.com/n/ryqq/search?w=${encodeURIComponent(normalizedQuery)}`
      : "https://y.qq.com/n/ryqq/";

    if (target === "app") {
      const openedApp = await openQqMusicApp().then(() => true).catch(() => false);
      if (!openedApp) await run("open", [searchUrl]);
      return {
        status: "opened",
        service: "qq_music",
        target,
        query: normalizedQuery,
        url: searchUrl,
        openedTarget: openedApp ? "app" : "web",
        note: openedApp
          ? "Opened QQ Music client. Direct playback is not claimed."
          : "QQ Music client was not available, so opened QQ Music web. Direct playback is not claimed.",
      };
    }

    await run("open", [searchUrl]);
    return {
      status: normalizedQuery ? "opened_search" : "opened",
      service: "qq_music",
      target,
      query: normalizedQuery,
      url: searchUrl,
      note: "Opened QQ Music official web page only. Direct playback is not claimed.",
    };
  }
}

const localMusicSearchScript = (searchText: string) => `
  tell application "Music"
    activate
    try
      set foundTracks to search library playlist 1 for ${appleScriptString(searchText)} only songs
      if (count of foundTracks) > 0 then
        set selectedTrack to item 1 of foundTracks
        play selectedTrack
        set trackName to name of selectedTrack
        set trackArtist to artist of selectedTrack
        return "played|" & trackName & "|" & trackArtist
      else
        return "not_found"
      end if
    on error errMsg number errNo
      return "error|" & errNo & "|" & errMsg
    end try
  end tell
`;

const localMusicSearchTerms = (searchText: string) => {
  const normalized = searchText.replace(/\s+/g, " ").trim();
  const terms = [normalized];
  const withoutGenericSongSuffix = normalized.replace(/(歌曲|曲)$/u, "").trim();
  if (withoutGenericSongSuffix && withoutGenericSongSuffix !== normalized) terms.push(withoutGenericSongSuffix);
  return [...new Set(terms)];
};

const findAppleMusicTrack = async (searchText: string): Promise<AppleMusicSearchResult | null> => {
  const cacheKey = `${config.appleMusicCountry}:${searchText.toLowerCase()}`;
  const cached = catalogCache.get(cacheKey);
  if (cached && Date.now() - cached.createdAt < CATALOG_CACHE_TTL_MS) return cached.value;

  const url = new URL("https://itunes.apple.com/search");
  url.searchParams.set("media", "music");
  url.searchParams.set("entity", "song");
  url.searchParams.set("limit", "1");
  url.searchParams.set("country", config.appleMusicCountry);
  url.searchParams.set("term", searchText);

  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    const payload = (await response.json().catch(() => ({}))) as { results?: AppleMusicSearchResult[] };
    const value = response.ok ? (payload.results?.[0] ?? null) : null;
    catalogCache.set(cacheKey, { createdAt: Date.now(), value });
    return value;
  } catch {
    catalogCache.set(cacheKey, { createdAt: Date.now(), value: null });
    return null;
  }
};

const playAppleMusicUrl = async (trackUrl: string, expected: AppleMusicSearchResult) => {
  const script = `
    tell application "Music"
      activate
      try
        open location ${appleScriptString(trackUrl)}
        delay 2
        play
        delay 1
        set playerState to player state as text
        set trackName to ""
        set trackArtist to ""
        try
          set trackName to name of current track
          set trackArtist to artist of current track
        end try
        return playerState & "|" & trackName & "|" & trackArtist
      on error errMsg number errNo
        return "error|" & errNo & "|" & errMsg
      end try
    end tell
  `;
  const output = await run("osascript", ["-e", script], 15000);
  const snapshot = parsePlaybackSnapshot(output);
  if (isExpectedTrackPlaying(snapshot, expected)) return { startedPlayback: true, snapshot };

  await run("open", ["-a", "Music", trackUrl]);
  return {
    startedPlayback: false,
    snapshot,
    reasonCode: snapshot.state === "playing" ? "different_track_playing" : "opened_catalog_page_not_playing",
  };
};

const parsePlaybackSnapshot = (output: string): MusicPlaybackSnapshot => {
  if (output.startsWith("error|")) return {};
  const [state, title, artist] = output.split("|");
  return { state, title: title || undefined, artist: artist || undefined };
};

const isExpectedTrackPlaying = (snapshot: MusicPlaybackSnapshot, expected: AppleMusicSearchResult) => {
  if (snapshot.state !== "playing") return false;
  const currentTitle = normalizeMatchText(snapshot.title);
  const expectedTitle = normalizeMatchText(expected.trackName);
  const currentArtist = normalizeMatchText(snapshot.artist);
  const expectedArtist = normalizeMatchText(expected.artistName);
  return Boolean(
    currentTitle &&
      expectedTitle &&
      currentTitle === expectedTitle &&
      (!expectedArtist || !currentArtist || currentArtist.includes(expectedArtist) || expectedArtist.includes(currentArtist)),
  );
};

const normalizeMatchText = (value: string | undefined) =>
  (value ?? "")
    .toLocaleLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "")
    .trim();

const missingSpotifyConfig = (missing: string[]) => ({
  status: "missing_config",
  service: "spotify",
  missing,
  note: "Spotify official API support needs an OAuth access token with user-read-playback-state, user-modify-playback-state, and streaming scopes.",
});

const spotifySearchTracks = async (searchText: string, limit: number) => {
  const url = new URL("https://api.spotify.com/v1/search");
  url.searchParams.set("q", searchText);
  url.searchParams.set("type", "track");
  url.searchParams.set("limit", String(Math.max(1, Math.min(10, limit))));
  if (config.spotifyMarket) url.searchParams.set("market", config.spotifyMarket);
  const payload = (await spotifyFetch(url, { method: "GET" })) as { tracks?: { items?: SpotifyTrack[] } };
  return payload.tracks?.items ?? [];
};

const firstSpotifyDeviceId = async () => {
  const payload = (await spotifyFetch(new URL("https://api.spotify.com/v1/me/player/devices"), { method: "GET" }).catch(() => ({}))) as {
    devices?: Array<{ id?: string; is_active?: boolean }>;
  };
  return payload.devices?.find((device) => device.is_active && device.id)?.id ?? payload.devices?.find((device) => device.id)?.id;
};

const spotifyFetch = async (url: URL, init: RequestInit) => {
  const response = await fetch(url, {
    ...init,
    headers: {
      authorization: `Bearer ${config.spotifyAccessToken}`,
      accept: "application/json",
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(10000),
  });
  if (response.status === 204) return {};
  const payload = (await response.json().catch(() => ({}))) as unknown;
  if (!response.ok) {
    throw new Error(`Spotify API request failed with ${response.status}: ${JSON.stringify(payload).slice(0, 500)}`);
  }
  return payload;
};

const formatSpotifyTrack = (track: SpotifyTrack) => ({
  id: track.id,
  uri: track.uri,
  title: track.name,
  artist: track.artists?.map((artist) => artist.name).filter(Boolean).join(", "),
  album: track.album?.name,
  url: track.external_urls?.spotify,
});

const isHttpUrl = (value: string) => {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
};

const openQqMusicApp = async () => {
  await openFirstMusicApp(["QQMusic", "QQ音乐"]);
};

const openNeteaseApp = async () => {
  await openFirstMusicApp(["NeteaseMusic", "网易云音乐"]);
};

const openFirstMusicApp = async (appNames: string[]) => {
  let lastError: unknown;
  for (const appName of appNames) {
    try {
      await run("open", ["-a", appName]);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`Could not open ${appNames.join(" or ")}.`);
};

const musicPlaybackStateScript = () => `
  tell application "System Events"
    set isRunning to exists process "Music"
  end tell
  if not isRunning then return "not_running||"
  tell application "Music"
    try
      set playerState to player state as text
      set trackName to ""
      set trackArtist to ""
      try
        set trackName to name of current track
        set trackArtist to artist of current track
      end try
      return playerState & "|" & trackName & "|" & trackArtist
    on error errMsg number errNo
      return "error|" & errNo & "|" & errMsg
    end try
  end tell
`;
