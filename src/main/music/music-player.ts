import { spawn } from "node:child_process";
import type { AppleMusicCatalogSong } from "./apple-music-api";

export type MusicPlaybackSnapshot = {
  state?: string;
  title?: string;
  artist?: string;
};

export const run = (command: string, args: string[], timeoutMs = 8000) =>
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

export class MacMusicPlayer {
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

  async playLocalLibrarySong(searchText: string) {
    for (const localSearchText of localMusicSearchTerms(searchText)) {
      const output = await run("osascript", ["-e", localMusicSearchScript(localSearchText)], 15000);
      if (output.startsWith("played|")) {
        const [, title, artist] = output.split("|");
        return {
          status: "playing",
          title,
          artist: artist || undefined,
          source: "local_music_library",
          query: localSearchText,
        };
      }
    }
    return undefined;
  }

  async openSearch(searchText: string) {
    const searchUrl = `https://music.apple.com/search?term=${encodeURIComponent(searchText)}`;
    await run("open", ["-a", "Music", searchUrl]);
    return {
      status: "opened_search",
      query: searchText,
      url: searchUrl,
      note: "Opened Apple Music search results in Music so you can choose the song.",
    };
  }

  async playCatalogSong(song: AppleMusicCatalogSong) {
    if (!song.url) {
      return {
        status: "not_found",
        source: song.source,
        title: song.title,
        artist: song.artist,
        note: "Apple Music catalog search found a song but did not provide a playable catalog URL.",
      };
    }

    const script = `
      tell application "Music"
        activate
        try
          open location ${appleScriptString(song.url)}
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
    if (isExpectedTrackPlaying(snapshot, song)) {
      return {
        status: "playing",
        reasonCode: "playing_confirmed",
        title: song.title,
        artist: song.artist,
        album: song.album,
        url: song.url,
        source: song.source,
        playerState: snapshot.state,
        currentTrack: { title: snapshot.title, artist: snapshot.artist },
        note: "Music is playing the requested catalog track.",
      };
    }

    await run("open", ["-a", "Music", song.url]);
    return {
      status: "opened_track",
      reasonCode: snapshot.state === "playing" ? "different_track_playing" : "opened_catalog_page_not_playing",
      title: song.title,
      artist: song.artist,
      album: song.album,
      url: song.url,
      source: song.source,
      playerState: snapshot.state,
      currentTrack: snapshot.title ? { title: snapshot.title, artist: snapshot.artist } : undefined,
      note: "Opened the Apple Music catalog track in Music, but playback was not confirmed. Please click Play if the track page is visible.",
    };
  }
}

export const parsePlaybackSnapshot = (output: string): MusicPlaybackSnapshot => {
  if (output.startsWith("error|")) return {};
  const [state, title, artist] = output.split("|");
  return { state, title: title || undefined, artist: artist || undefined };
};

const appleScriptString = (value: string) => JSON.stringify(value);

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

const isExpectedTrackPlaying = (snapshot: MusicPlaybackSnapshot, expected: AppleMusicCatalogSong) => {
  if (snapshot.state !== "playing") return false;
  const currentTitle = normalizeMatchText(snapshot.title);
  const expectedTitle = normalizeMatchText(expected.title);
  const currentArtist = normalizeMatchText(snapshot.artist);
  const expectedArtist = normalizeMatchText(expected.artist);
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
