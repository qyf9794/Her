import { config } from "../config";
import { AppleMusicCatalogClient } from "../music/apple-music-api";
import { MacMusicPlayer, run } from "../music/music-player";

type SpotifyTrack = {
  id: string;
  uri: string;
  name: string;
  external_urls?: { spotify?: string };
  artists?: Array<{ name?: string }>;
  album?: { name?: string };
};

export class MusicControl {
  private readonly appleMusic = new AppleMusicCatalogClient();
  private readonly player = new MacMusicPlayer();

  async open() {
    return this.player.open();
  }

  async playbackState() {
    return this.player.playbackState();
  }

  async playSong(query: string, artist?: string, mode: "play" | "search" = "play") {
    const searchText = [query, artist].filter(Boolean).join(" ");
    if (mode === "search") {
      return this.player.openSearch(searchText);
    }

    const localMatch = await this.player.playLocalLibrarySong(searchText);
    if (localMatch) return localMatch;

    const catalogTrack = await this.appleMusic.findSong(searchText);
    if (catalogTrack) return this.player.playCatalogSong(catalogTrack);

    return this.player.openSearch(searchText);
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
