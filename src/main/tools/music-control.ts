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

  async playSong(query: string, artist?: string) {
    const searchText = [query, artist].filter(Boolean).join(" ");
    const script = `
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

    const output = await run("osascript", ["-e", script]);
    if (output.startsWith("played|")) {
      const [, title, trackArtist] = output.split("|");
      return { status: "playing", title, artist: trackArtist || undefined, source: "local_music_library" };
    }

    const catalogTrack = await findAppleMusicTrack(searchText);
    if (catalogTrack?.trackViewUrl) {
      const result = await playAppleMusicUrl(catalogTrack.trackViewUrl, catalogTrack);
      return {
        status: result.startedPlayback ? "playing" : "opened_track",
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
}

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
  const output = await run("osascript", ["-e", script], 6000);
  const snapshot = parsePlaybackSnapshot(output);
  if (isExpectedTrackPlaying(snapshot, expected)) return { startedPlayback: true, snapshot };

  await run("open", ["-a", "Music", trackUrl]);
  return { startedPlayback: false, snapshot };
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
