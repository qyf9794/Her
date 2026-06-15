import path from "node:path";
import { pathToFileURL } from "node:url";
import { app, BrowserWindow, ipcMain, net, protocol, session, shell, type Rectangle } from "electron";
import { config } from "./config";
import {
  HER_APP_INDEX_URL,
  HER_APP_PROTOCOL,
  classifyNavigationUrl,
  createContentSecurityPolicy,
  createSecureWebPreferences,
  isRendererCspTargetUrl,
  isSafeExternalUrl,
  isTrustedMusicKitPopupUrl,
  isTrustedRendererUrl,
  normalizeRendererDevUrl,
  rendererRootPath,
  resolveHerProtocolFilePath,
  shouldAllowPermissionRequest,
  type RendererSecurityOptions,
} from "./electron-security";
import { startLocalServer, type LocalServer } from "./server";
import { configureAutoUpdates } from "./updates";

let mainWindow: BrowserWindow | null = null;
let localServer: LocalServer | null = null;
let restoreBounds: Rectangle | null = null;
let orbBounds: Rectangle | null = null;

protocol.registerSchemesAsPrivileged([
  {
    scheme: HER_APP_PROTOCOL,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
    },
  },
]);

const rendererDevUrl = normalizeRendererDevUrl(process.env.HER_RENDERER_DEV_URL);
const shouldUseDevServer = Boolean(rendererDevUrl) && !app.isPackaged;
const rendererSecurity: RendererSecurityOptions = {
  useDevServer: shouldUseDevServer,
  rendererDevUrl,
};

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
    webPreferences: createSecureWebPreferences(path.join(__dirname, "preload.js")),
  });

  mainWindow.webContents.on("will-navigate", (event, url) => {
    const decision = classifyNavigationUrl(url, rendererSecurity);
    if (decision.action === "allow") return;

    event.preventDefault();
    if (decision.action === "external") void shell.openExternal(url).catch(() => undefined);
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
          webPreferences: createSecureWebPreferences(),
        },
      };
    }

    if (isSafeExternalUrl(url)) void shell.openExternal(url).catch(() => undefined);
    return { action: "deny" };
  });

  if (shouldUseDevServer && rendererDevUrl) {
    await mainWindow.loadURL(rendererDevUrl);
  } else {
    await mainWindow.loadURL(HER_APP_INDEX_URL);
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
  if (!senderUrl || !isTrustedRendererUrl(senderUrl, rendererSecurity)) throw new Error("Untrusted renderer local API caller.");
  return localApiRequest(localServer, request);
});

app.whenReady().then(async () => {
  registerHerAppProtocol();
  configureSessionSecurity();
  localServer = await startLocalServer(config.serverPort, app.getPath("userData"), app.isPackaged);
  configureAutoUpdates();
  await createWindow();

  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) await createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

const registerHerAppProtocol = () => {
  const rendererRoot = rendererRootPath(app.isPackaged, app.getAppPath(), __dirname);
  protocol.handle(HER_APP_PROTOCOL, (request) => {
    const filePath = resolveHerProtocolFilePath(request.url, rendererRoot);
    if (!filePath) return new Response("Not found.", { status: 404 });
    return net.fetch(pathToFileURL(filePath).toString());
  });
};

const configureSessionSecurity = () => {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    if (!isRendererCspTargetUrl(details.url, rendererSecurity)) {
      callback({ responseHeaders: details.responseHeaders });
      return;
    }

    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [createContentSecurityPolicy(rendererSecurity)],
      },
    });
  });

  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    callback(shouldAllowPermissionRequest(details.requestingUrl ?? webContents.getURL(), permission, rendererSecurity));
  });
};

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
