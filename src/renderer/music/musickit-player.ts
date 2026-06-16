import { getJson } from "../api/local-client";

type MusicKitInstance = {
  authorize: () => Promise<string>;
  isAuthorized?: boolean;
  musicUserToken?: string;
  setQueue: (options: Record<string, unknown>) => Promise<unknown>;
  play: () => Promise<unknown>;
  pause?: () => Promise<unknown>;
  stop?: () => Promise<unknown>;
};

type MusicKitGlobal = {
  configure: (options: {
    developerToken: string;
    app: { name: string; build: string };
  }) => Promise<MusicKitInstance> | MusicKitInstance;
  getInstance: () => MusicKitInstance | undefined;
};

declare global {
  interface Window {
    MusicKit?: MusicKitGlobal;
  }
}

let loadPromise: Promise<void> | undefined;
let instancePromise: Promise<MusicKitInstance> | undefined;
let authorizedInSession = false;

export type MusicKitStatus = {
  configured: boolean;
  authorized: boolean;
  playbackSupported: boolean;
  detail?: string;
};

export const getMusicKitStatus = async (): Promise<MusicKitStatus> => {
  try {
    const instance = await getMusicKitInstance();
    return {
      configured: true,
      authorized: isAuthorized(instance),
      playbackSupported: canPlayProtectedAppleMusic(),
    };
  } catch (error) {
    return {
      configured: false,
      authorized: false,
      playbackSupported: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
};

export const authorizeMusicKit = async () => {
  const instance = await getMusicKitInstance();
  let token = "";
  try {
    token = await instance.authorize();
  } catch (error) {
    authorizedInSession = readInstanceAuthorized(instance);
    if (!authorizedInSession) throw error;
  }
  authorizedInSession = authorizedInSession || Boolean(token) || readInstanceAuthorized(instance);
  return {
    configured: true,
    authorized: isAuthorized(instance),
    playbackSupported: canPlayProtectedAppleMusic(),
  };
};

export const playAppleMusicSong = async (songId: string) => {
  const instance = await getMusicKitInstance();
  if (!isAuthorized(instance)) {
    return {
      status: "needs_authorization",
      note: "Authorize Apple Music before streaming catalog songs.",
    };
  }
  if (!canPlayProtectedAppleMusic()) {
    return {
      status: "electron_playback_unsupported",
      songId,
      note: "Apple Music authorization is available, but this Electron runtime does not expose protected media playback. Use the native Music app fallback.",
    };
  }

  await instance.setQueue({ song: songId, startPlaying: true });
  await instance.play();
  return {
    status: "playing_requested",
    songId,
    note: "Requested Apple Music playback through MusicKit.",
  };
};

export const pauseAppleMusic = async () => {
  const instance = await getMusicKitInstance();
  if (typeof instance.pause === "function") await instance.pause();
  else if (typeof instance.stop === "function") await instance.stop();
  else throw new Error("MusicKit pause/stop is unavailable.");
  return { status: "paused" };
};

export const resumeAppleMusic = async () => {
  const instance = await getMusicKitInstance();
  await instance.play();
  return { status: "playing_requested" };
};

const getMusicKitInstance = async () => {
  if (instancePromise) return instancePromise;
  instancePromise = configureMusicKit().catch((error) => {
    instancePromise = undefined;
    throw error;
  });
  return instancePromise;
};

const configureMusicKit = async () => {
  await loadMusicKitScript();
  const MusicKit = window.MusicKit;
  if (!MusicKit) throw new Error("MusicKit JS did not load.");
  const existing = MusicKit.getInstance();
  if (existing) return existing;

  const response = await getJson<{ developerToken: string }>("/api/music/developer-token");
  return MusicKit.configure({
    developerToken: response.developerToken,
    app: {
      name: "HER",
      build: "0.1.0",
    },
  });
};

const loadMusicKitScript = async () => {
  if (window.MusicKit) return;
  if (loadPromise) return loadPromise;

  loadPromise = new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://js-cdn.music.apple.com/musickit/v3/musickit.js";
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Failed to load MusicKit JS."));
    document.head.appendChild(script);
  });
  return loadPromise;
};

const isAuthorized = (instance: MusicKitInstance) =>
  authorizedInSession || readInstanceAuthorized(instance);

const readInstanceAuthorized = (instance: MusicKitInstance) =>
  instance.isAuthorized === true || Boolean(instance.musicUserToken) || hasStoredMusicUserToken();

const hasStoredMusicUserToken = () => {
  try {
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index) ?? "";
      if (!/(music|musickit|amp)/i.test(key) || !/(user|media-user|music-user)/i.test(key) || !/token/i.test(key)) {
        continue;
      }
      const value = window.localStorage.getItem(key);
      if (value && value.length > 20) return true;
    }
  } catch {
    return false;
  }
  return false;
};

const canPlayProtectedAppleMusic = () =>
  typeof navigator.requestMediaKeySystemAccess === "function";
