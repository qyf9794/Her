import path from "node:path";
import type { WebPreferences } from "electron";

export const HER_APP_PROTOCOL = "her";
export const HER_APP_HOST = "app";
export const HER_APP_INDEX_URL = `${HER_APP_PROTOCOL}://${HER_APP_HOST}/index.html`;

export type RendererSecurityOptions = {
  useDevServer: boolean;
  rendererDevUrl?: string;
};

export type NavigationDecision = {
  action: "allow" | "external" | "block";
  reason: string;
};

const musicKitPopupHosts = new Set([
  "authorize.music.apple.com",
  "music.apple.com",
  "idmsa.apple.com",
  "appleid.apple.com",
]);

const trustedRendererPermissions = new Set(["media", "microphone"]);

export const normalizeRendererDevUrl = (rawUrl: string | undefined) => {
  if (!rawUrl) return undefined;
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "http:") return undefined;
    if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") return undefined;
    if (!url.port) return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
};

export const rendererRootPath = (isPackaged: boolean, appPath: string, mainDir: string) =>
  isPackaged
    ? path.join(appPath, "dist", "renderer")
    : path.resolve(mainDir, "..", "..", "..", "dist", "renderer");

export const rendererIndexPath = (isPackaged: boolean, appPath: string, mainDir: string) =>
  path.join(rendererRootPath(isPackaged, appPath, mainDir), "index.html");

export const resolveHerProtocolFilePath = (rawUrl: string, rendererRoot: string) => {
  try {
    const lowerRawUrl = rawUrl.toLowerCase();
    if (lowerRawUrl.includes("..") || lowerRawUrl.includes("%2e")) return null;

    const url = new URL(rawUrl);
    if (url.protocol !== `${HER_APP_PROTOCOL}:` || url.hostname !== HER_APP_HOST) return null;

    const pathname = decodeURIComponent(url.pathname || "/index.html");
    const relativePath = (pathname === "/" ? "/index.html" : pathname).replace(/^\/+/, "");
    const root = path.resolve(rendererRoot);
    const filePath = path.resolve(root, relativePath);
    if (filePath !== root && !filePath.startsWith(`${root}${path.sep}`)) return null;
    return filePath;
  } catch {
    return null;
  }
};

export const createSecureWebPreferences = (preload?: string): WebPreferences => ({
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  ...(preload ? { preload } : {}),
});

export const isTrustedRendererUrl = (rawUrl: string, options: RendererSecurityOptions) => {
  try {
    const url = new URL(rawUrl);
    const devOrigin = normalizeRendererDevUrl(options.rendererDevUrl);
    if (options.useDevServer && devOrigin) return url.origin === devOrigin;
    return url.protocol === `${HER_APP_PROTOCOL}:` && url.hostname === HER_APP_HOST;
  } catch {
    return false;
  }
};

export const isRendererCspTargetUrl = (rawUrl: string, options: RendererSecurityOptions) =>
  isTrustedRendererUrl(rawUrl, options);

export const isTrustedMusicKitPopupUrl = (rawUrl: string) => {
  try {
    const url = new URL(rawUrl);
    return url.protocol === "https:" && musicKitPopupHosts.has(url.hostname);
  } catch {
    return false;
  }
};

export const isSafeExternalUrl = (rawUrl: string) => {
  try {
    const url = new URL(rawUrl);
    return url.protocol === "https:" && Boolean(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
};

export const classifyNavigationUrl = (rawUrl: string, options: RendererSecurityOptions): NavigationDecision => {
  if (isTrustedRendererUrl(rawUrl, options)) return { action: "allow", reason: "trusted_renderer" };
  if (isSafeExternalUrl(rawUrl)) return { action: "external", reason: "safe_https_external" };
  return { action: "block", reason: "untrusted_navigation" };
};

export const shouldAllowPermissionRequest = (
  requestingUrl: string | undefined,
  permission: string,
  options: RendererSecurityOptions,
) => Boolean(requestingUrl && isTrustedRendererUrl(requestingUrl, options) && trustedRendererPermissions.has(permission));

export const createContentSecurityPolicy = (options: RendererSecurityOptions) => {
  const devOrigin = options.useDevServer ? normalizeRendererDevUrl(options.rendererDevUrl) : undefined;
  const devHostDirectives = devOrigin
    ? [devOrigin, devOrigin.replace("http://", "ws://")]
    : [];

  const directives: Record<string, string[]> = {
    "default-src": ["'self'"],
    "base-uri": ["'none'"],
    "object-src": ["'none'"],
    "frame-ancestors": ["'none'"],
    "form-action": ["'none'"],
    "script-src": [
      "'self'",
      "https://js-cdn.music.apple.com",
      ...(devOrigin ? ["'unsafe-eval'", devOrigin] : []),
    ],
    "style-src": ["'self'", "'unsafe-inline'", ...(devOrigin ? [devOrigin] : [])],
    "img-src": ["'self'", "data:", "blob:", "https:", "http://127.0.0.1:*"],
    "media-src": ["'self'", "data:", "blob:", "https:"],
    "connect-src": [
      "'self'",
      "http://127.0.0.1:*",
      "ws://127.0.0.1:*",
      "https://api.openai.com",
      "wss://api.openai.com",
      "https://js-cdn.music.apple.com",
      "https://amp-api.music.apple.com",
      "https://play.itunes.apple.com",
      ...devHostDirectives,
    ],
    "frame-src": [
      "https://authorize.music.apple.com",
      "https://music.apple.com",
      "https://idmsa.apple.com",
      "https://appleid.apple.com",
    ],
    "worker-src": ["'self'", "blob:"],
  };

  return Object.entries(directives)
    .map(([name, values]) => `${name} ${Array.from(new Set(values)).join(" ")}`)
    .join("; ");
};
