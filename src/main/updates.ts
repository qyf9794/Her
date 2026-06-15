import { app, autoUpdater } from "electron";
import { config } from "./config";

export type UpdateChannel = "stable" | "beta" | "canary";

export type UpdateStatus = {
  enabled: boolean;
  channel: UpdateChannel;
  feedUrl?: string;
  lastEvent?: string;
  lastError?: string;
};

const status: UpdateStatus = {
  enabled: false,
  channel: config.updateChannel,
};

export const configureAutoUpdates = () => {
  status.channel = config.updateChannel;
  status.enabled = false;
  status.feedUrl = undefined;
  status.lastError = undefined;

  if (!app.isPackaged) {
    status.lastEvent = "disabled-development";
    return status;
  }

  if (!config.updateFeedUrl) {
    status.lastEvent = "disabled-no-feed-url";
    return status;
  }

  const feedUrl = updateFeedUrlForChannel(config.updateFeedUrl, config.updateChannel, process.platform, app.getVersion());
  if (!feedUrl) {
    status.lastEvent = "disabled-invalid-feed-url";
    status.lastError = "Update feed URL must use HTTPS.";
    return status;
  }

  status.enabled = true;
  status.feedUrl = feedUrl;

  autoUpdater.setFeedURL({ url: feedUrl });
  autoUpdater.on("checking-for-update", () => {
    status.lastEvent = "checking-for-update";
    status.lastError = undefined;
  });
  autoUpdater.on("update-available", () => {
    status.lastEvent = "update-available";
  });
  autoUpdater.on("update-not-available", () => {
    status.lastEvent = "update-not-available";
  });
  autoUpdater.on("update-downloaded", () => {
    status.lastEvent = "update-downloaded";
  });
  autoUpdater.on("error", (error) => {
    status.lastEvent = "error";
    status.lastError = error.message;
  });

  setTimeout(() => {
    autoUpdater.checkForUpdates();
  }, 10000);

  return status;
};

export const getUpdateStatus = () => ({ ...status });

export const updateFeedUrlForChannel = (
  baseUrl: string,
  channel: UpdateChannel,
  platform: string,
  version: string,
) => {
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== "https:") return undefined;
    url.searchParams.set("channel", channel);
    url.searchParams.set("platform", platform);
    url.searchParams.set("version", version);
    return url.toString();
  } catch {
    return undefined;
  }
};
