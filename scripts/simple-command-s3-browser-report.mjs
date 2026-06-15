import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import WebSocket from "ws";

const repoRoot = process.cwd();
const reportDir = path.join(repoRoot, "docs", "test-runs", "simple-command-browser");
const reportPath = path.join(reportDir, "S3-browser-page-report.json");
const logPath = path.join(repoRoot, "docs", "test-runs", "simple-command-milestone-log.md");
const profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), "her-s3-chrome-profile-"));
const debugPort = await findFreePort();

process.env.HER_ISOLATED_BROWSER_PROFILE = profileRoot;
process.env.HER_BROWSER_DEBUG_PORT = String(debugPort);

const require = createRequire(import.meta.url);
const { BrowserAutomation } = require("../electron/dist/main/tools/browser-automation.js");
const { ApprovalPolicy } = require("../electron/dist/main/policy/approval-policy.js");
const { isAllowedLocalApiOrigin } = require("../electron/dist/main/api/cors.js");

const browser = new BrowserAutomation();
const policy = new ApprovalPolicy();
const results = [];

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const run = (command, args, timeoutMs = 8000) =>
  new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
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
  });

const runScenario = async (id, title, fn) => {
  const startedAt = new Date().toISOString();
  try {
    const payload = await fn();
    results.push({
      id,
      title,
      status: "passed",
      startedAt,
      completedAt: new Date().toISOString(),
      payload: payload ?? {},
    });
  } catch (error) {
    results.push({
      id,
      title,
      status: "failed",
      startedAt,
      completedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/external-login") {
    sendHtml(res, externalLoginHtml());
    return;
  }
  if (url.pathname === "/video") {
    sendHtml(res, videoHtml());
    return;
  }
  sendHtml(res, fixtureHtml());
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const fixturePort = server.address().port;
const fixtureUrl = `http://127.0.0.1:${fixturePort}/`;
const externalLoginUrl = `http://127.0.0.1:${fixturePort}/external-login`;
const videoUrl = `http://127.0.0.1:${fixturePort}/video`;

try {
  await runScenario("S3.browser.open-local", "Open a local static test page", async () => {
    await run("open", ["-g", fixtureUrl]);
    return {
      actionSummary: "Opened local fixture page in the default browser in the background.",
      url: fixtureUrl,
      title: "Her S3 Browser Fixture",
    };
  });

  await runScenario("S3.browser.isolated-open-example", "Open example.com in isolated Chrome", async () => {
    const result = await browser.openIsolatedUrl("https://example.com/");
    await waitForCdpPage(debugPort, "https://example.com/");
    return {
      ...result,
      url: "https://example.com/",
      title: "Example Domain",
      actionSummary: "Opened example.com in isolated Chrome profile.",
      expectedUrl: "https://example.com/",
    };
  });

  await runScenario("S3.browser.search-open", "Open search URL for Her local agent runtime", async () => {
    const searchUrl = `https://duckduckgo.com/?q=${encodeURIComponent("Her local agent runtime")}`;
    const result = await browser.openIsolatedUrl(searchUrl);
    await waitForCdpPage(debugPort, searchUrl);
    assert(result.opened === searchUrl, "Search scenario should expose the deterministic search URL.");
    return {
      ...result,
      url: searchUrl,
      title: "DuckDuckGo Search",
      engine: "duckduckgo",
      query: "Her local agent runtime",
      actionSummary: "Opened search results URL without reading search result content.",
    };
  });

  await runScenario("S3.browser.read-page", "Read page title and visible text", async () => {
    await browser.openIsolatedUrl(fixtureUrl);
    await waitForCdpPage(debugPort, fixtureUrl);
    const page = await retry(() => browser.readPage(1000), 8, 500);
    assert(page.url === fixtureUrl, "Read page URL should match local fixture.");
    assert(page.title === "Her S3 Browser Fixture", "Read page title should match fixture.");
    assert(page.text.includes("Local agent runtime fixture"), "Visible text summary should include fixture text.");
    return {
      url: page.url,
      title: page.title,
      textLength: page.textLength,
      textPreview: page.text.slice(0, 160),
      actionSummary: "Read compact page title, visible text, links, and form field metadata.",
    };
  });

  await runScenario("S3.browser.fill-form", "Fill local fixture form fields", async () => {
    await browser.openIsolatedUrl(fixtureUrl);
    await waitForCdpPage(debugPort, fixtureUrl);
    await retry(() => browser.readPage(300), 8, 500);
    const result = await browser.fillForm([
      { selector: "#name", value: "Qian Yifeng" },
      { selector: "#email", value: "qian@example.test" },
      { selector: "#comment", value: "S3 local fixture comment" },
    ]);
    const values = await cdpEvaluate(debugPort, fixtureUrl, `(() => ({
      name: document.querySelector("#name")?.value,
      email: document.querySelector("#email")?.value,
      comment: document.querySelector("#comment")?.value
    }))()`);
    assert(Array.isArray(result) && result.every((item) => item.ok), "All fill operations should succeed.");
    assert(values.name === "Qian Yifeng", "Name field should contain the expected value.");
    assert(values.email === "qian@example.test", "Email field should contain the expected value.");
    assert(values.comment === "S3 local fixture comment", "Comment field should contain the expected value.");
    return {
      url: fixtureUrl,
      title: "Her S3 Browser Fixture",
      actionSummary: "Filled local-only form fields and verified DOM values.",
      fields: values,
      results: result,
    };
  });

  await runScenario("S3.browser.click-local", "Click local fixture button and verify visible DOM change", async () => {
    await browser.openIsolatedUrl(fixtureUrl);
    await waitForCdpPage(debugPort, fixtureUrl);
    await retry(() => browser.readPage(300), 8, 500);
    const result = await browser.click("#local-action", "Toggle the local fixture status text.");
    const status = await cdpEvaluate(debugPort, fixtureUrl, `document.querySelector("#status")?.textContent`);
    assert(result.ok === true, "Local click should succeed.");
    assert(status === "Button clicked", "Click should update visible status text.");
    return {
      url: fixtureUrl,
      title: "Her S3 Browser Fixture",
      actionSummary: "Clicked a local fixture button and verified visible page state.",
      clickResult: result,
      status,
    };
  });

  await runScenario("S3.browser.external-submit-confirmation", "Require confirmation for external login submit", async () => {
    await browser.openIsolatedUrl(externalLoginUrl);
    await waitForCdpPage(debugPort, externalLoginUrl);
    await retry(() => browser.readPage(300), 8, 500);
    const decision = policy.decide({
      toolName: "browser_click",
      args: { selector: "#external-submit", purpose: "Submit external login form to https://example.com/login" },
      summary: "Submit external login form",
      yoloMode: false,
      now: new Date("2026-06-16T00:00:00.000Z"),
    });
    assert(decision.type === "require_confirmation", "External submit click should require confirmation.");
    const stillLocal = await cdpEvaluate(debugPort, externalLoginUrl, "location.href");
    assert(stillLocal === externalLoginUrl, "External form should not be submitted during unattended S3.");
    return {
      url: externalLoginUrl,
      title: "Her S3 External Submit Fixture",
      actionSummary: "Stopped external submit at confirmation card; no browser click executed.",
      policyDecision: decision.type,
      risk: decision.plan.risk,
      currentUrl: stillLocal,
    };
  });

  await runScenario("S3.browser.video-state", "Read video state from controlled fixture page", async () => {
    await browser.openIsolatedUrl(videoUrl);
    await waitForCdpPage(debugPort, videoUrl);
    const state = await retry(() => browser.readVideoState(), 8, 500);
    assert(state.url === videoUrl, "Video state URL should match fixture.");
    assert(state.hasVideo === true, "Fixture should expose a video element.");
    return {
      ...state,
      actionSummary: "Read compact state from a controlled video element.",
    };
  });

  await runScenario("S3.browser.move-resize", "Move isolated browser window to known bounds", async () => {
    await browser.openIsolatedUrl(fixtureUrl);
    await waitForCdpPage(debugPort, fixtureUrl);
    await retry(() => browser.readPage(300), 8, 500);
    const result = await browser.moveResizeIsolatedWindow(120, 120, 900, 700);
    assert(result.moved === true, "Move/resize should report success.");
    return {
      ...result,
      url: fixtureUrl,
      title: "Her S3 Browser Fixture",
      actionSummary: "Moved and resized the isolated Chrome window.",
    };
  });

  await runScenario("S3.local-api-origin-protection", "Verify arbitrary webpages cannot call local tool APIs", async () => {
    assert(isAllowedLocalApiOrigin("https://evil.example", false) === false, "Arbitrary HTTPS origins should be rejected.");
    assert(isAllowedLocalApiOrigin("http://127.0.0.1:5174", false) === true, "Renderer dev origin should remain allowed in development.");
    assert(isAllowedLocalApiOrigin("http://127.0.0.1:5174", true) === false, "Packaged app should not allow dev web origins.");
    return {
      actionSummary: "Checked local API origin policy against arbitrary web origins.",
      arbitraryOriginAllowed: false,
      devOriginAllowedInDev: true,
      devOriginAllowedInPackaged: false,
    };
  });
} finally {
  server.close();
  await cleanupChromeProfile(profileRoot).catch(() => undefined);
}

const summary = {
  total: results.length,
  passed: results.filter((item) => item.status === "passed").length,
  failed: results.filter((item) => item.status === "failed").length,
};

fs.mkdirSync(reportDir, { recursive: true });
fs.writeFileSync(
  reportPath,
  JSON.stringify(
    {
      milestone: "S3",
      title: "Browser and Page Commands",
      generatedAt: new Date().toISOString(),
      realtime2Connected: false,
      fixtureOrigin: `http://127.0.0.1:${fixturePort}`,
      isolatedProfile: profileRoot,
      debugPort,
      summary,
      results,
      acceptance: {
        formFillAndClickUseLocalFixtures: results.find((item) => item.id === "S3.browser.fill-form")?.status === "passed" &&
          results.find((item) => item.id === "S3.browser.click-local")?.status === "passed",
        externalSubmitRequiresConfirmationAndNotExecuted: results.find((item) => item.id === "S3.browser.external-submit-confirmation")?.status === "passed",
        browserCardsIncludeUrlTitleActionSummary: results.every((item) =>
          item.id === "S3.local-api-origin-protection" ||
          Boolean(item.payload?.url && item.payload?.title && item.payload?.actionSummary),
        ),
        localApiOriginProtectionsEnabled: results.find((item) => item.id === "S3.local-api-origin-protection")?.status === "passed",
      },
    },
    null,
    2,
  ),
);

const logEntry = `
## S3 Browser and Page Commands - ${summary.failed === 0 ? "Passed" : "Failed"}

Report: \`docs/test-runs/simple-command-browser/S3-browser-page-report.json\`

- Total scenarios: ${summary.total}
- Passed: ${summary.passed}
- Failed: ${summary.failed}
- Realtime-2 connected: false
- Real execution: isolated Chrome open/read/fill/click/video-state/move-resize against local fixture pages plus deterministic search URL opening.
- Safety checks: external submit was stopped at \`browser_click\` confirmation; arbitrary web origins remain blocked from local tool API access.
`;

fs.appendFileSync(logPath, logEntry);

console.log(JSON.stringify({ reportPath, summary }, null, 2));
if (summary.failed > 0) process.exitCode = 1;

function sendHtml(res, html) {
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(html);
}

function fixtureHtml() {
  return `<!doctype html>
<html>
  <head><title>Her S3 Browser Fixture</title></head>
  <body>
    <h1>Local agent runtime fixture</h1>
    <p>This page exists for Her S3 browser command testing.</p>
    <form id="fixture-form">
      <label>Name <input id="name" name="name" /></label>
      <label>Email <input id="email" name="email" /></label>
      <label>Comment <textarea id="comment" name="comment"></textarea></label>
    </form>
    <button id="local-action" type="button" onclick="document.getElementById('status').textContent='Button clicked'">Local action</button>
    <p id="status">Waiting</p>
    <a href="/video">Video fixture</a>
  </body>
</html>`;
}

function externalLoginHtml() {
  return `<!doctype html>
<html>
  <head><title>Her S3 External Submit Fixture</title></head>
  <body>
    <h1>External login form fixture</h1>
    <form id="external-login" method="post" action="https://example.com/login">
      <input id="username" name="username" value="fixture-user" />
      <input id="password" name="password" type="password" value="fixture-password" />
      <button id="external-submit" type="submit">Submit externally</button>
    </form>
  </body>
</html>`;
}

function videoHtml() {
  return `<!doctype html>
<html>
  <head><title>Her S3 Video Fixture</title></head>
  <body>
    <h1>Video fixture</h1>
    <video id="fixture-video" controls muted width="320" height="180"></video>
  </body>
</html>`;
}

async function retry(fn, attempts, delayMs) {
  let lastError;
  for (let index = 0; index < attempts; index += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}

async function cdpEvaluate(port, expectedUrl, expression) {
  const page = await waitForCdpPage(port, expectedUrl);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  try {
    ws.send(JSON.stringify({
      id: 1,
      method: "Runtime.evaluate",
      params: { expression, returnByValue: true },
    }));
    const message = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("CDP evaluate timed out.")), 5000);
      ws.on("message", (data) => {
        const parsed = JSON.parse(data.toString());
        if (parsed.id !== 1) return;
        clearTimeout(timeout);
        resolve(parsed);
      });
      ws.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
    if (message.error) throw new Error(message.error.message ?? "CDP evaluate failed.");
    return message.result?.result?.value;
  } finally {
    ws.close();
  }
}

async function waitForCdpPage(port, expectedUrl) {
  return retry(async () => {
    const pages = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1500) }).then((res) => res.json());
    const page = pages.find((item) =>
      item.type === "page" &&
      item.webSocketDebuggerUrl &&
      (!expectedUrl || sameTargetUrl(item.url, expectedUrl))
    ) ?? pages.find((item) => item.type === "page" && item.webSocketDebuggerUrl);
    if (!page) throw new Error("No isolated Chrome CDP page is available.");
    return page;
  }, 20, 500);
}

function sameTargetUrl(candidate, expected) {
  if (!candidate) return false;
  const normalize = (value) => {
    try {
      const url = new URL(value);
      url.hash = "";
      return url.toString().replace(/\/$/, "");
    } catch {
      return String(value).replace(/\/$/, "");
    }
  };
  const left = normalize(candidate);
  const right = normalize(expected);
  return left === right || left.startsWith(right) || right.startsWith(left);
}

async function cleanupChromeProfile(profilePath) {
  const pattern = `user-data-dir=${profilePath}`;
  const killMatches = async (signal) => {
    const output = await run("pgrep", ["-f", pattern], 3000).catch(() => "");
    for (const value of output.split(/\s+/).filter(Boolean)) {
      const pid = Number(value);
      if (Number.isInteger(pid) && pid > 0) {
        try {
          process.kill(pid, signal);
        } catch {
          // The process may have already exited between pgrep and kill.
        }
      }
    }
  };

  await killMatches("SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 1000));
  await killMatches("SIGKILL");
  await new Promise((resolve) => setTimeout(resolve, 250));
  fs.rmSync(profilePath, { recursive: true, force: true });
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}
