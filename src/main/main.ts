import path from "node:path";
import { app, BrowserWindow, ipcMain, shell, type Rectangle } from "electron";
import { config } from "./config";
import { startLocalServer } from "./server";

let mainWindow: BrowserWindow | null = null;
let restoreBounds: Rectangle | null = null;
let orbBounds: Rectangle | null = null;

const rendererDevUrl = process.env.HER_RENDERER_DEV_URL;
const shouldUseDevServer = Boolean(rendererDevUrl) && !app.isPackaged;

const setOrbOnlyWindowMode = (window: BrowserWindow, enabled: boolean) => {
  if (enabled) {
    if (!restoreBounds) restoreBounds = window.getBounds();
    const current = window.getBounds();
    const size = 180;
    const nextBounds = orbBounds ?? {
      x: current.x + Math.round((current.width - size) / 2),
      y: current.y + 82,
      width: size,
      height: size,
    };
    window.setMinimumSize(165, 165);
    window.setResizable(false);
    window.setAlwaysOnTop(true, "floating");
    window.setSkipTaskbar(true);
    window.setHasShadow(false);
    window.setBackgroundColor("#00000000");
    if (process.platform === "darwin") window.setWindowButtonVisibility(false);
    window.setBounds({ ...nextBounds, width: size, height: size }, true);
    return;
  }

  orbBounds = window.getBounds();
  window.setResizable(true);
  window.setMinimumSize(900, 650);
  window.setAlwaysOnTop(false);
  window.setSkipTaskbar(false);
  window.setHasShadow(true);
  window.setBackgroundColor("#5a5d60");
  if (process.platform === "darwin") window.setWindowButtonVisibility(true);
  if (restoreBounds) window.setBounds(restoreBounds, true);
  restoreBounds = null;
};

const createWindow = async () => {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 900,
    minHeight: 650,
    title: "Her Voice Agent",
    transparent: true,
    backgroundColor: "#00000000",
    titleBarStyle: "hiddenInset",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, "preload.js"),
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

ipcMain.handle("her-window:set-orb-only", (event, enabled: unknown) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window) return { ok: false };
  setOrbOnlyWindowMode(window, enabled === true);
  return { ok: true };
});

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
