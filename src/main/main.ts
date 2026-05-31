import path from "node:path";
import { app, BrowserWindow, shell } from "electron";
import { config } from "./config";
import { startLocalServer } from "./server";

let mainWindow: BrowserWindow | null = null;

const isDev = process.env.NODE_ENV !== "production" && !app.isPackaged;

const createWindow = async () => {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 900,
    minHeight: 650,
    title: "Her Voice Agent",
    backgroundColor: "#111315",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  if (isDev) {
    await mainWindow.loadURL(process.env.HER_RENDERER_DEV_URL ?? "http://127.0.0.1:5174");
  } else {
    await mainWindow.loadFile(path.join(app.getAppPath(), "dist", "renderer", "index.html"));
  }
};

app.whenReady().then(async () => {
  await startLocalServer(config.serverPort, app.getPath("userData"));
  await createWindow();

  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) await createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
