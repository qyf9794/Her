import { config } from "../config";

export type AppleMusicCatalogSong = {
  id?: string;
  title?: string;
  artist?: string;
  album?: string;
  url?: string;
  source: "apple_music_api" | "itunes_search_fallback";
};

type AppleMusicSearchResponse = {
  results?: {
    songs?: {
      data?: Array<{
        id?: string;
        attributes?: {
          name?: string;
          artistName?: string;
          albumName?: string;
          url?: string;
        };
      }>;
    };
  };
};

type ItunesSearchResult = {
  trackName?: string;
  artistName?: string;
  collectionName?: string;
  trackViewUrl?: string;
};

const catalogCache = new Map<string, { createdAt: number; value: AppleMusicCatalogSong | null }>();
const CATALOG_CACHE_TTL_MS = 60_000;

export class AppleMusicCatalogClient {
  async findSong(searchText: string): Promise<AppleMusicCatalogSong | null> {
    const normalized = searchText.replace(/\s+/g, " ").trim();
    if (!normalized) return null;

    const cacheKey = `${config.appleMusicCountry}:${normalized.toLowerCase()}`;
    const cached = catalogCache.get(cacheKey);
    if (cached && Date.now() - cached.createdAt < CATALOG_CACHE_TTL_MS) return cached.value;

    const value = (await this.findWithAppleMusicApi(normalized)) ?? (await this.findWithItunesSearch(normalized));
    catalogCache.set(cacheKey, { createdAt: Date.now(), value });
    return value;
  }

  private async findWithAppleMusicApi(searchText: string): Promise<AppleMusicCatalogSong | null> {
    if (!config.appleMusicDeveloperToken) return null;

    const url = new URL(`https://api.music.apple.com/v1/catalog/${config.appleMusicCountry}/search`);
    url.searchParams.set("term", searchText);
    url.searchParams.set("types", "songs");
    url.searchParams.set("limit", "1");

    try {
      const response = await fetch(url, {
        headers: {
          authorization: `Bearer ${config.appleMusicDeveloperToken}`,
          accept: "application/json",
        },
        signal: AbortSignal.timeout(5000),
      });
      const payload = (await response.json().catch(() => ({}))) as AppleMusicSearchResponse;
      if (!response.ok) return null;
      const song = payload.results?.songs?.data?.[0];
      if (!song?.attributes) return null;
      return {
        id: song.id,
        title: song.attributes.name,
        artist: song.attributes.artistName,
        album: song.attributes.albumName,
        url: song.attributes.url,
        source: "apple_music_api",
      };
    } catch {
      return null;
    }
  }

  private async findWithItunesSearch(searchText: string): Promise<AppleMusicCatalogSong | null> {
    const url = new URL("https://itunes.apple.com/search");
    url.searchParams.set("media", "music");
    url.searchParams.set("entity", "song");
    url.searchParams.set("limit", "1");
    url.searchParams.set("country", config.appleMusicCountry);
    url.searchParams.set("term", searchText);

    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
      const payload = (await response.json().catch(() => ({}))) as { results?: ItunesSearchResult[] };
      if (!response.ok) return null;
      const song = payload.results?.[0];
      if (!song) return null;
      return {
        title: song.trackName,
        artist: song.artistName,
        album: song.collectionName,
        url: song.trackViewUrl,
        source: "itunes_search_fallback",
      };
    } catch {
      return null;
    }
  }
}
