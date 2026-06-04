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
  async openIsolatedUrl(rawUrl: string) {
    const url = this.assertAllowedUrl(rawUrl);
    await fs.mkdir(config.isolatedBrowserProfile, { recursive: true });
    spawn(
      "open",
      [
        "-na",
        "Google Chrome",
        "--args",
        `--user-data-dir=${config.isolatedBrowserProfile}`,
        `--remote-debugging-port=${config.browserDebugPort}`,
        "--no-first-run",
        "--no-default-browser-check",
        url.toString(),
      ],
      { detached: true, stdio: "ignore" },
    ).unref();
    return {
      opened: url.toString(),
      profile: config.isolatedBrowserProfile,
      note: "Opened in isolated Chrome profile.",
    };
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
      webSocketDebuggerUrl?: string;
    }>;
    const page = pages.find((item) => item.type === "page" && item.webSocketDebuggerUrl);
    if (!page?.webSocketDebuggerUrl) {
      throw new Error("No isolated Chrome page found. Open one with browser_isolated_open_url first.");
    }
    return new CdpClient(page.webSocketDebuggerUrl);
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
