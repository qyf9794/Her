import path from "node:path";
import { app, BrowserWindow, shell } from "electron";
import { config } from "./config";
import { startLocalServer } from "./server";

let mainWindow: BrowserWindow | null = null;

const rendererDevUrl = process.env.HER_RENDERER_DEV_URL;
const shouldUseDevServer = Boolean(rendererDevUrl) && !app.isPackaged;

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

  if (shouldUseDevServer && rendererDevUrl) {
    await mainWindow.loadURL(rendererDevUrl);
  } else {
    const rendererIndex = app.isPackaged
      ? path.join(app.getAppPath(), "dist", "renderer", "index.html")
      : path.resolve(__dirname, "..", "..", "..", "dist", "renderer", "index.html");
    await mainWindow.loadFile(rendererIndex);
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
