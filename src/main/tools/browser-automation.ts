import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import WebSocket from "ws";
import { config } from "../config";

type CdpResponse = {
  id?: number;
  result?: unknown;
  error?: { message?: string };
};

type RuntimeEvaluateResult = {
  result?: {
    value?: unknown;
    description?: string;
  };
};

export class BrowserAutomation {
  private isolatedChromePid?: number;
  private lastOpenedUrl?: string;

  async openIsolatedUrl(rawUrl: string) {
    const url = this.assertAllowedUrl(rawUrl);
    const targetUrl = url.toString();
    await fs.mkdir(config.isolatedBrowserProfile, { recursive: true });
    const existingProcessId = await this.findIsolatedChromePid().catch(() => undefined);
    if (existingProcessId) {
      await this.navigateFirstPage(targetUrl);
      this.lastOpenedUrl = targetUrl;
      return {
        opened: targetUrl,
        profile: config.isolatedBrowserProfile,
        processId: existingProcessId,
        note: "Opened in isolated Chrome profile.",
      };
    }

    this.lastOpenedUrl = targetUrl;
    const chromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    const args = [
      `--user-data-dir=${config.isolatedBrowserProfile}`,
      `--remote-debugging-port=${config.browserDebugPort}`,
      "--no-first-run",
      "--no-default-browser-check",
      targetUrl,
    ];
    try {
      await fs.access(chromePath);
      const child = spawn(chromePath, args, { detached: true, stdio: "ignore" });
      this.isolatedChromePid = child.pid;
      child.unref();
    } catch {
      spawn(
        "open",
        [
          "-na",
          "Google Chrome",
          "--args",
          ...args,
        ],
        { detached: true, stdio: "ignore" },
      ).unref();
      this.isolatedChromePid = undefined;
    }
    return {
      opened: targetUrl,
      profile: config.isolatedBrowserProfile,
      processId: this.isolatedChromePid,
      note: "Opened in isolated Chrome profile.",
    };
  }

  async focusIsolatedWindow() {
    const processId = await this.findIsolatedChromePid();
    await this.isolatedChromeWindowAction(
      processId,
      `
        set frontmost of targetProc to true
        perform action "AXRaise" of targetWindow
      `,
    );
    return { focused: true, processId };
  }

  async moveResizeIsolatedWindow(x: number, y: number, width: number, height: number) {
    const processId = await this.findIsolatedChromePid();
    await this.isolatedChromeWindowAction(
      processId,
      `
        set frontmost of targetProc to true
        set position of targetWindow to {${Math.round(x)}, ${Math.round(y)}}
        set size of targetWindow to {${Math.round(width)}, ${Math.round(height)}}
        perform action "AXRaise" of targetWindow
      `,
    );
    return { moved: true, processId, x, y, width, height };
  }

  private async findIsolatedChromePid() {
    if (this.isolatedChromePid && processExists(this.isolatedChromePid)) return this.isolatedChromePid;
    const profilePattern = escapeRegex(`--user-data-dir=${config.isolatedBrowserProfile}`);
    const output = await run("pgrep", ["-f", profilePattern], undefined, 3000).catch(() => "");
    const processId = output
      .split(/\s+/)
      .map((value) => Number(value))
      .find((value) => Number.isInteger(value) && value > 0);
    if (!processId) {
      throw new Error("No isolated Chrome process found. Open one with browser_isolated_open_url first.");
    }
    this.isolatedChromePid = processId;
    return processId;
  }

  private async isolatedChromeWindowAction(processId: number, action: string) {
    const script = `
      tell application "System Events"
        if not (exists first application process whose unix id is ${processId}) then error "Isolated Chrome process is not available: ${processId}"
        set targetProc to first application process whose unix id is ${processId}

        tell targetProc
          repeat 10 times
            if (count of windows) > 0 then exit repeat
            delay 0.1
          end repeat

          if (count of windows) = 0 then error "No controllable isolated Chrome windows found."

          try
            set targetWindow to first window whose subrole is "AXStandardWindow"
          on error
            set targetWindow to window 1
          end try

          ${action}
        end tell
      end tell
    `;
    await run("osascript", ["-e", script]);
  }

  async fillForm(fields: Array<{ selector: string; value: string }>) {
    const client = await this.connect();
    try {
      const expression = `(() => {
        const fields = ${JSON.stringify(fields)};
        const results = [];
        for (const field of fields) {
          const el = document.querySelector(field.selector);
          if (!el) {
            results.push({ selector: field.selector, ok: false, error: "not found" });
            continue;
          }
          el.focus();
          el.value = field.value;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          results.push({ selector: field.selector, ok: true });
        }
        return results;
      })()`;
      return unwrapEvaluateResult(await client.call("Runtime.evaluate", { expression, returnByValue: true }));
    } finally {
      client.close();
    }
  }

  async click(selector: string, purpose: string) {
    const client = await this.connect();
    try {
      const expression = `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return { ok: false, error: "not found" };
        el.click();
        return { ok: true, purpose: ${JSON.stringify(purpose)} };
      })()`;
      return unwrapEvaluateResult(await client.call("Runtime.evaluate", { expression, returnByValue: true }));
    } finally {
      client.close();
    }
  }

  async readVideoState() {
    const client = await this.connect();
    try {
      const expression = `(() => {
        const video = document.querySelector("video");
        return {
          url: location.href,
          title: document.title,
          hasVideo: Boolean(video),
          paused: video ? video.paused : null,
          currentTime: video ? Math.round(video.currentTime * 10) / 10 : null,
          duration: video && Number.isFinite(video.duration) ? Math.round(video.duration * 10) / 10 : null,
          readyState: video ? video.readyState : null,
          muted: video ? video.muted : null,
          volume: video ? Math.round(video.volume * 100) / 100 : null,
        };
      })()`;
      return unwrapEvaluateResult(await client.call("Runtime.evaluate", { expression, returnByValue: true }));
    } finally {
      client.close();
    }
  }

  async readPage(maxChars: number) {
    const client = await this.connect();
    try {
      const expression = `(() => {
        const visibleText = (document.body?.innerText || "")
          .replace(/\\s+/g, " ")
          .trim();
        const links = Array.from(document.querySelectorAll("a[href]"))
          .slice(0, 20)
          .map((link) => ({
            text: (link.innerText || link.getAttribute("aria-label") || "").replace(/\\s+/g, " ").trim().slice(0, 120),
            href: link.href,
          }))
          .filter((link) => link.text || link.href);
        const forms = Array.from(document.querySelectorAll("input, textarea, select"))
          .slice(0, 30)
          .map((field) => ({
            tag: field.tagName.toLowerCase(),
            type: field.getAttribute("type") || "",
            name: field.getAttribute("name") || "",
            id: field.id || "",
            placeholder: field.getAttribute("placeholder") || "",
            ariaLabel: field.getAttribute("aria-label") || "",
          }));
        return {
          url: location.href,
          title: document.title,
          textLength: visibleText.length,
          text: visibleText.slice(0, ${Math.max(200, Math.min(10000, maxChars))}),
          links,
          forms,
        };
      })()`;
      return unwrapEvaluateResult(await client.call("Runtime.evaluate", { expression, returnByValue: true }));
    } finally {
      client.close();
    }
  }

  async playVideo() {
    return this.controlVideo("play");
  }

  async controlVideo(action: "play" | "pause" | "toggle" | "state") {
    const client = await this.connect();
    try {
      const expression = `(() => {
        const video = document.querySelector("video");
        if (!video) return { ok: false, error: "video_not_found", url: location.href, title: document.title };
        const snapshot = () => ({
          ok: true,
          action: ${JSON.stringify(action)},
          url: location.href,
          title: document.title,
          paused: video.paused,
          currentTime: Math.round(video.currentTime * 10) / 10,
          duration: Number.isFinite(video.duration) ? Math.round(video.duration * 10) / 10 : null,
          readyState: video.readyState,
          muted: video.muted,
          volume: Math.round(video.volume * 100) / 100,
        });
        if (${JSON.stringify(action)} === "state") return snapshot();
        if (${JSON.stringify(action)} === "pause") {
          video.pause();
          return snapshot();
        }
        if (${JSON.stringify(action)} === "toggle" && !video.paused) {
          video.pause();
          return snapshot();
        }
        return Promise.resolve(video.play())
          .then(() => ({
            ok: true,
            action: ${JSON.stringify(action)},
            url: location.href,
            title: document.title,
            paused: video.paused,
            currentTime: Math.round(video.currentTime * 10) / 10,
            duration: Number.isFinite(video.duration) ? Math.round(video.duration * 10) / 10 : null,
            readyState: video.readyState,
            muted: video.muted,
            volume: Math.round(video.volume * 100) / 100,
          }))
          .catch((error) => ({
            ok: false,
            action: ${JSON.stringify(action)},
            error: error && error.name ? error.name : "play_failed",
            message: error && error.message ? error.message : String(error),
            url: location.href,
            title: document.title,
            paused: video.paused,
            currentTime: Math.round(video.currentTime * 10) / 10,
            duration: Number.isFinite(video.duration) ? Math.round(video.duration * 10) / 10 : null,
            readyState: video.readyState,
            muted: video.muted,
            volume: Math.round(video.volume * 100) / 100,
          }));
      })()`;
      return unwrapEvaluateResult(await client.call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }));
    } finally {
      client.close();
    }
  }

  private assertAllowedUrl(rawUrl: string) {
    const url = new URL(rawUrl);
    if (!["http:", "https:"].includes(url.protocol)) throw new Error(`URL protocol is not allowed: ${url.protocol}`);
    return url;
  }

  private async connect() {
    const pages = (await fetch(`http://127.0.0.1:${config.browserDebugPort}/json/list`, {
      signal: AbortSignal.timeout(3000),
    }).then((res) => res.json())) as Array<{
      type: string;
      url?: string;
      webSocketDebuggerUrl?: string;
    }>;
    const controllablePages = pages.filter((item) => item.type === "page" && item.webSocketDebuggerUrl);
    const expectedUrl = this.lastOpenedUrl;
    const page = expectedUrl
      ? controllablePages.find((item) => sameBrowserTarget(item.url, expectedUrl)) ?? controllablePages[0]
      : controllablePages[0];
    if (!page?.webSocketDebuggerUrl) {
      throw new Error("No isolated Chrome page found. Open one with browser_isolated_open_url first.");
    }
    return new CdpClient(page.webSocketDebuggerUrl);
  }

  private async navigateFirstPage(url: string) {
    const pages = (await fetch(`http://127.0.0.1:${config.browserDebugPort}/json/list`, {
      signal: AbortSignal.timeout(3000),
    }).then((res) => res.json())) as Array<{
      type: string;
      webSocketDebuggerUrl?: string;
    }>;
    const page = pages.find((item) => item.type === "page" && item.webSocketDebuggerUrl);
    if (!page?.webSocketDebuggerUrl) throw new Error("No isolated Chrome page found for navigation.");
    const client = new CdpClient(page.webSocketDebuggerUrl);
    try {
      await client.call("Page.navigate", { url });
    } finally {
      client.close();
    }
  }
}

class CdpClient {
  private ws: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private ready: Promise<void>;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ready = new Promise((resolve, reject) => {
      this.ws.once("open", () => resolve());
      this.ws.once("error", reject);
    });
    this.ws.on("message", (data) => {
      const message = JSON.parse(data.toString()) as CdpResponse;
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message ?? "CDP command failed"));
      else pending.resolve(message.result);
    });
  }

  async call(method: string, params: Record<string, unknown>) {
    await this.ready;
    const id = this.nextId;
    this.nextId += 1;
    const result = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.ws.send(JSON.stringify({ id, method, params }));
    return withTimeout(result, 5000, `CDP ${method} timed out.`);
  }

  close() {
    this.ws.close();
  }
}

const unwrapEvaluateResult = (value: unknown) => {
  const result = value as RuntimeEvaluateResult;
  return result.result && "value" in result.result ? result.result.value : result;
};

const run = (command: string, args: string[], input?: string, timeoutMs = 8000) =>
  new Promise<string>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${command} timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.trim() || `${command} exited with code ${code}`));
    });
    child.stdin.end(input);
  });

const processExists = (processId: number) => {
  try {
    process.kill(processId, 0);
    return true;
  } catch {
    return false;
  }
};

const sameBrowserTarget = (candidate: string | undefined, expected: string) => {
  if (!candidate) return false;
  const normalizedCandidate = normalizeTargetUrl(candidate);
  const normalizedExpected = normalizeTargetUrl(expected);
  return (
    normalizedCandidate === normalizedExpected ||
    normalizedCandidate.startsWith(normalizedExpected) ||
    normalizedExpected.startsWith(normalizedCandidate)
  );
};

const normalizeTargetUrl = (value: string) => {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return value.replace(/\/$/, "");
  }
};

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const withTimeout = <T>(promise: Promise<T>, timeoutMs: number, message: string) =>
  new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise
      .then((value) => {
        clearTimeout(timeout);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timeout);
        reject(error);
      });
  });
