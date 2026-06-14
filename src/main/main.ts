import path from "node:path";
import { app, BrowserWindow, ipcMain, shell, type Rectangle } from "electron";
import { config } from "./config";
import { startLocalServer, type LocalServer } from "./server";

let mainWindow: BrowserWindow | null = null;
let localServer: LocalServer | null = null;
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
    if (isTrustedMusicKitPopupUrl(url)) {
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          width: 520,
          height: 720,
          title: "Apple Music Authorization",
          parent: mainWindow ?? undefined,
          modal: false,
          webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
          },
        },
      };
    }

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

ipcMain.handle("her-local-api:request", async (event, request: unknown) => {
  if (!localServer) throw new Error("Local API server is not ready.");
  const senderUrl = event.senderFrame?.url;
  if (!senderUrl || !isTrustedRendererUrl(senderUrl)) throw new Error("Untrusted renderer local API caller.");
  return localApiRequest(localServer, request);
});

app.whenReady().then(async () => {
  localServer = await startLocalServer(config.serverPort, app.getPath("userData"), app.isPackaged);
  await createWindow();

  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) await createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

const isTrustedRendererUrl = (rawUrl: string) => {
  try {
    const url = new URL(rawUrl);
    if (shouldUseDevServer && rendererDevUrl) {
      const devUrl = new URL(rendererDevUrl);
      return url.origin === devUrl.origin;
    }
    return url.protocol === "file:";
  } catch {
    return false;
  }
};

const isTrustedMusicKitPopupUrl = (rawUrl: string) => {
  try {
    const url = new URL(rawUrl);
    return url.protocol === "https:" && musicKitPopupHosts.has(url.hostname);
  } catch {
    return false;
  }
};

const musicKitPopupHosts = new Set([
  "authorize.music.apple.com",
  "music.apple.com",
  "idmsa.apple.com",
  "appleid.apple.com",
]);

type LocalApiBridgeRequest = {
  method?: unknown;
  path?: unknown;
  body?: unknown;
};

const localApiRequest = async (server: LocalServer, rawRequest: unknown) => {
  const request = rawRequest as LocalApiBridgeRequest;
  const method = typeof request.method === "string" ? request.method.toUpperCase() : "GET";
  if (method !== "GET" && method !== "POST") throw new Error("Unsupported local API method.");
  if (typeof request.path !== "string" || !request.path.startsWith("/") || request.path.startsWith("//")) {
    throw new Error("Invalid local API path.");
  }

  const baseUrl = `http://127.0.0.1:${server.port}`;
  const url = new URL(request.path, baseUrl);
  if (url.origin !== baseUrl) throw new Error("Invalid local API target.");

  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${server.localApiToken}`,
      ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
    },
    ...(method === "POST" ? { body: JSON.stringify(request.body ?? {}) } : {}),
  });

  const text = await response.text();
  const payload = text ? parseLocalApiPayload(text) : {};
  return { ok: response.ok, status: response.status, payload };
};

const parseLocalApiPayload = (text: string) => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { error: text };
  }
};
