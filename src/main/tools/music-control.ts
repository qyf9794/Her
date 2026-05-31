import { spawn } from "node:child_process";

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

type AppleMusicSearchResult = {
  trackName?: string;
  artistName?: string;
  trackViewUrl?: string;
};

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
      const result = await playAppleMusicUrl(catalogTrack.trackViewUrl);
      return {
        status: result.startedPlayback ? "playing" : "opened_track",
        title: catalogTrack.trackName,
        artist: catalogTrack.artistName,
        url: catalogTrack.trackViewUrl,
        source: "apple_music_catalog",
        note: result.startedPlayback
          ? "Opened the Apple Music catalog track and sent Music a play command."
          : "Opened the Apple Music catalog track. Music may require subscription, sign-in, or macOS Automation permission before playback starts.",
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
  const url = new URL("https://itunes.apple.com/search");
  url.searchParams.set("media", "music");
  url.searchParams.set("entity", "song");
  url.searchParams.set("limit", "1");
  url.searchParams.set("term", searchText);

  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    const payload = (await response.json().catch(() => ({}))) as { results?: AppleMusicSearchResult[] };
    return response.ok ? (payload.results?.[0] ?? null) : null;
  } catch {
    return null;
  }
};

const playAppleMusicUrl = async (trackUrl: string) => {
  const script = `
    tell application "Music"
      activate
      try
        open location ${appleScriptString(trackUrl)}
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

  await run("open", ["-a", "Music", trackUrl]);
  return { startedPlayback: false };
};
