import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  HER_APP_INDEX_URL,
  classifyNavigationUrl,
  createContentSecurityPolicy,
  createSecureWebPreferences,
  isRendererCspTargetUrl,
  isSafeExternalUrl,
  isTrustedMusicKitPopupUrl,
  isTrustedRendererUrl,
  normalizeRendererDevUrl,
  rendererIndexPath,
  resolveHerProtocolFilePath,
  shouldAllowPermissionRequest,
} from "../../src/main/electron-security";

vi.mock("electron", () => ({
  app: { isPackaged: false, getVersion: () => "0.1.0" },
  autoUpdater: {
    setFeedURL: vi.fn(),
    on: vi.fn(),
    checkForUpdates: vi.fn(),
  },
}));

describe("Electron production security", () => {
  const prodOptions = { useDevServer: false };
  const devOptions = { useDevServer: true, rendererDevUrl: "http://127.0.0.1:5174" };

  it("uses a custom production renderer URL and resolves it inside the renderer root", () => {
    expect(HER_APP_INDEX_URL).toBe("her://app/index.html");
    expect(rendererIndexPath(true, "/Applications/Her.app/Contents/Resources/app.asar", "/ignored")).toContain(
      path.join("dist", "renderer", "index.html"),
    );

    const root = path.join(path.sep, "tmp", "her-renderer");
    expect(resolveHerProtocolFilePath("her://app/index.html", root)).toBe(path.join(root, "index.html"));
    expect(resolveHerProtocolFilePath("her://app/assets/index.js", root)).toBe(path.join(root, "assets", "index.js"));
    expect(resolveHerProtocolFilePath("file:///tmp/index.html", root)).toBeNull();
    expect(resolveHerProtocolFilePath("her://evil/index.html", root)).toBeNull();
    expect(resolveHerProtocolFilePath("her://app/assets/%2e%2e/%2e%2e/secret.txt", root)).toBeNull();
  });

  it("keeps renderer web preferences isolated from Node", () => {
    expect(createSecureWebPreferences("/tmp/preload.js")).toMatchObject({
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: "/tmp/preload.js",
    });
    expect(createSecureWebPreferences()).toMatchObject({
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    });
  });

  it("trusts only Her custom protocol in production and Vite origins in development", () => {
    expect(isTrustedRendererUrl("her://app/index.html", prodOptions)).toBe(true);
    expect(isTrustedRendererUrl("file:///tmp/index.html", prodOptions)).toBe(false);
    expect(isTrustedRendererUrl("https://example.com", prodOptions)).toBe(false);
    expect(isTrustedRendererUrl("http://127.0.0.1:5174", devOptions)).toBe(true);
    expect(isTrustedRendererUrl("http://localhost:5174", devOptions)).toBe(false);
    expect(normalizeRendererDevUrl("http://127.0.0.1:5174/path")).toBe("http://127.0.0.1:5174");
    expect(normalizeRendererDevUrl("https://127.0.0.1:5174")).toBeUndefined();
  });

  it("builds strict production CSP and Vite-compatible development CSP", () => {
    const prodCsp = createContentSecurityPolicy(prodOptions);
    expect(prodCsp).toContain("default-src 'self'");
    expect(prodCsp).toContain("object-src 'none'");
    expect(prodCsp).toContain("frame-ancestors 'none'");
    expect(prodCsp).toContain("https://api.openai.com");
    expect(prodCsp).not.toContain("'unsafe-eval'");

    const devCsp = createContentSecurityPolicy(devOptions);
    expect(devCsp).toContain("http://127.0.0.1:5174");
    expect(devCsp).toContain("ws://127.0.0.1:5174");
    expect(devCsp).toContain("'unsafe-eval'");
    expect(isRendererCspTargetUrl("her://app/index.html", prodOptions)).toBe(true);
    expect(isRendererCspTargetUrl("https://example.com", prodOptions)).toBe(false);
  });

  it("blocks unsafe navigation and opens only safe HTTPS externally", () => {
    expect(classifyNavigationUrl("her://app/index.html", prodOptions)).toMatchObject({ action: "allow" });
    expect(classifyNavigationUrl("https://example.com/docs", prodOptions)).toMatchObject({ action: "external" });
    expect(classifyNavigationUrl("javascript:alert(1)", prodOptions)).toMatchObject({ action: "block" });
    expect(classifyNavigationUrl("file:///tmp/index.html", prodOptions)).toMatchObject({ action: "block" });
    expect(classifyNavigationUrl("ftp://example.com/file", prodOptions)).toMatchObject({ action: "block" });

    expect(isSafeExternalUrl("https://example.com/path")).toBe(true);
    expect(isSafeExternalUrl("https://user:pass@example.com/path")).toBe(false);
    expect(isSafeExternalUrl("http://example.com/path")).toBe(false);
    expect(isSafeExternalUrl("file:///tmp/index.html")).toBe(false);
  });

  it("allows MusicKit popups and denies sensitive permissions from untrusted origins", () => {
    expect(isTrustedMusicKitPopupUrl("about:blank")).toBe(true);
    expect(isTrustedMusicKitPopupUrl("https://authorize.music.apple.com/auth")).toBe(true);
    expect(isTrustedMusicKitPopupUrl("https://evil.example/auth")).toBe(false);

    expect(shouldAllowPermissionRequest("her://app/index.html", "media", prodOptions)).toBe(true);
    expect(shouldAllowPermissionRequest("her://app/index.html", "microphone", prodOptions)).toBe(true);
    expect(shouldAllowPermissionRequest("https://example.com", "media", prodOptions)).toBe(false);
    expect(shouldAllowPermissionRequest("file:///tmp/index.html", "media", prodOptions)).toBe(false);
    expect(shouldAllowPermissionRequest("her://app/index.html", "geolocation", prodOptions)).toBe(false);
  });
});

describe("update feed skeleton", () => {
  it("accepts only HTTPS update feed URLs", async () => {
    const { updateFeedUrlForChannel } = await import("../../src/main/updates");
    expect(updateFeedUrlForChannel("https://updates.example.com/her", "beta", "darwin", "0.1.0")).toBe(
      "https://updates.example.com/her?channel=beta&platform=darwin&version=0.1.0",
    );
    expect(updateFeedUrlForChannel("http://updates.example.com/her", "stable", "darwin", "0.1.0")).toBeUndefined();
    expect(updateFeedUrlForChannel("not-a-url", "stable", "darwin", "0.1.0")).toBeUndefined();
  });
});
