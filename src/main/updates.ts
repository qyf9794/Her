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
  if (!app.isPackaged || !config.updateFeedUrl) return status;

  const feedUrl = updateFeedUrlForChannel(config.updateFeedUrl, config.updateChannel);
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

const updateFeedUrlForChannel = (baseUrl: string, channel: UpdateChannel) => {
  const url = new URL(baseUrl);
  url.searchParams.set("channel", channel);
  url.searchParams.set("platform", process.platform);
  url.searchParams.set("version", app.getVersion());
  return url.toString();
};
