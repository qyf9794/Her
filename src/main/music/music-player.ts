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
    return withMediaDisplay(
      { status: "opened", opened: "Music" },
      mediaDisplay({
        title: "Music 已打开",
        subtitle: "Apple Music",
        status: "opened",
        note: "Music app 已请求打开。播放状态请使用 music_playback_state 或歌曲播放命令确认。",
      }),
    );
  }

  async playbackState() {
    const output = await run("osascript", ["-e", musicPlaybackStateScript()], 10000);
    const snapshot = parsePlaybackSnapshot(output);
    return {
      app: "Music",
      running: snapshot.state !== "not_running",
      state: snapshot.state,
      currentTrack: snapshot.title ? { title: snapshot.title, artist: snapshot.artist } : undefined,
      display: mediaDisplay({
        title: snapshot.title ? "Music 当前播放状态" : "Music 播放状态",
        subtitle: snapshot.state,
        status: snapshot.state,
        itemTitle: snapshot.title,
        itemSubtitle: snapshot.artist,
        note: snapshot.state === "playing" ? "Music 报告正在播放。" : "Music 当前没有确认播放中的歌曲。",
      }),
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
          display: mediaDisplay({
            title: "已开始播放",
            subtitle: "本地 Music 资料库",
            status: "playing",
            itemTitle: title,
            itemSubtitle: artist || undefined,
            note: "Music 已确认播放这首本地资料库歌曲。",
          }),
        };
      }
    }
    return undefined;
  }

  async openSearch(searchText: string) {
    const searchUrl = `https://music.apple.com/search?term=${encodeURIComponent(searchText)}`;
    await run("open", ["-a", "Music", searchUrl]);
    return withMediaDisplay(
      {
      status: "opened_search",
      query: searchText,
      url: searchUrl,
      note: "Opened Apple Music search results in Music so you can choose the song.",
      },
      mediaDisplay({
        title: "已打开 Apple Music 搜索",
        subtitle: searchText,
        status: "opened_search",
        itemTitle: searchText,
        itemUrl: searchUrl,
        note: "已打开搜索页，但没有确认开始播放。",
      }),
    );
  }

  async playCatalogSong(song: AppleMusicCatalogSong) {
    if (!song.url) {
      return {
        status: "not_found",
        source: song.source,
        title: song.title,
        artist: song.artist,
        note: "Apple Music catalog search found a song but did not provide a playable catalog URL.",
        display: mediaDisplay({
          title: "未找到可播放链接",
          subtitle: song.source,
          status: "not_found",
          itemTitle: song.title,
          itemSubtitle: song.artist,
          note: "Apple Music 找到歌曲信息，但没有返回可打开的歌曲链接。",
        }),
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
        id: song.id,
        artworkUrl: song.artworkUrl,
        url: song.url,
        source: song.source,
        playerState: snapshot.state,
        currentTrack: { title: snapshot.title, artist: snapshot.artist },
        note: "Music is playing the requested catalog track.",
        display: mediaDisplay({
          title: "已开始播放",
          subtitle: "Apple Music",
          status: "playing",
          itemTitle: song.title,
          itemSubtitle: song.artist,
          itemUrl: song.url,
          note: "Music 已确认正在播放请求的歌曲。",
        }),
      };
    }

    await run("open", ["-a", "Music", song.url]);
    return {
      status: "opened_track",
      reasonCode: snapshot.state === "playing" ? "different_track_playing" : "opened_catalog_page_not_playing",
      title: song.title,
      artist: song.artist,
      album: song.album,
      id: song.id,
      artworkUrl: song.artworkUrl,
      url: song.url,
      source: song.source,
      playerState: snapshot.state,
      currentTrack: snapshot.title ? { title: snapshot.title, artist: snapshot.artist } : undefined,
      note: "Opened the Apple Music catalog track in Music, but playback was not confirmed. Please click Play if the track page is visible.",
      display: mediaDisplay({
        title: "已打开歌曲页，未确认播放",
        subtitle: song.artist,
        status: "opened_track",
        itemTitle: song.title,
        itemSubtitle: song.album,
        itemUrl: song.url,
        note: "Music 已打开歌曲页，但当前播放状态没有匹配到这首歌。需要在 Music 中点播放或重新授权。",
      }),
    };
  }
}

type MediaDisplayInput = {
  title: string;
  subtitle?: string;
  status?: string;
  itemTitle?: string;
  itemSubtitle?: string;
  itemUrl?: string;
  note?: string;
};

const withMediaDisplay = <T extends Record<string, unknown>>(result: T, display: ReturnType<typeof mediaDisplay>) => ({
  ...result,
  display,
});

const mediaDisplay = (input: MediaDisplayInput) => ({
  title: input.title,
  subtitle: input.subtitle,
  kind: "media",
  generatedAt: new Date().toISOString(),
  source: "Music",
  metrics: input.status ? [{ label: "状态", value: input.status }] : undefined,
  items: [
    {
      title: input.itemTitle ?? input.title,
      subtitle: input.itemSubtitle,
      url: input.itemUrl,
    },
  ],
  note: input.note,
});

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
  const titleMatches = Boolean(
    currentTitle &&
      expectedTitle &&
      (currentTitle === expectedTitle || currentTitle.includes(expectedTitle) || expectedTitle.includes(currentTitle)),
  );
  return Boolean(
    titleMatches &&
      (!expectedArtist || !currentArtist || currentArtist.includes(expectedArtist) || expectedArtist.includes(currentArtist) || isKnownArtistAlias(currentArtist, expectedArtist)),
  );
};

const normalizeMatchText = (value: string | undefined) =>
  normalizeChineseVariants(value ?? "")
    .toLocaleLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "")
    .trim();

const normalizeChineseVariants = (value: string) =>
  value
    .replace(/經/g, "经")
    .replace(/歷/g, "历");

const isKnownArtistAlias = (left: string, right: string) => {
  const aliases = [
    ["王菲", "fayewong"],
  ];
  return aliases.some(([a, b]) => (left === a && right === b) || (left === b && right === a));
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
