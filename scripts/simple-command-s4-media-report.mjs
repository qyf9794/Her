import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const repoRoot = process.cwd();
const reportDir = path.join(repoRoot, "docs", "test-runs", "simple-command-media");
const reportPath = path.join(reportDir, "S4-media-video-report.json");
const logPath = path.join(repoRoot, "docs", "test-runs", "simple-command-milestone-log.md");
const profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), "her-s4-chrome-profile-"));
const debugPort = await findFreePort();

process.env.HER_ISOLATED_BROWSER_PROFILE = profileRoot;
process.env.HER_BROWSER_DEBUG_PORT = String(debugPort);
process.env.HER_SPOTIFY_ACCESS_TOKEN = "";
process.env.HER_SPOTIFY_DEVICE_ID = "";

const require = createRequire(import.meta.url);
const { MusicControl } = require("../electron/dist/main/tools/music-control.js");
const { VideoControl } = require("../electron/dist/main/tools/video-control.js");
const { SystemControl } = require("../electron/dist/main/tools/system-control.js");
const { BrowserAutomation } = require("../electron/dist/main/tools/browser-automation.js");

const music = new MusicControl();
const browser = new BrowserAutomation();
const video = new VideoControl(browser);
const system = new SystemControl();
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

const server = http.createServer((_req, res) => {
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(`<!doctype html>
<html>
  <head><title>Her S4 Video Fixture</title></head>
  <body>
    <h1>Controlled S4 video fixture</h1>
    <video id="fixture-video" controls muted width="320" height="180"></video>
  </body>
</html>`);
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const fixturePort = server.address().port;
const videoFixtureUrl = `http://127.0.0.1:${fixturePort}/`;

try {
  await runScenario("S4.music.open", "Open the Music app", async () => {
    const result = await music.open();
    assert(result.opened === "Music", "Music app should report as opened.");
    return {
      ...result,
      service: "apple_music",
      actionSummary: "Opened the macOS Music app.",
    };
  });

  await runScenario("S4.music.play-song-search", "Open Apple Music search for Taylor Swift Cruel Summer", async () => {
    const result = await music.playSong("Taylor Swift Cruel Summer", undefined, "search");
    assert(result.status === "opened_search", "Search-mode music_play_song should not claim playback.");
    assert(result.query === "Taylor Swift Cruel Summer", "Result should name the requested song query.");
    return {
      ...result,
      service: "apple_music",
      actionSummary: "Opened Music search results without claiming playback.",
    };
  });

  await runScenario("S4.music.playback-state", "Read Music playback state", async () => {
    const result = await music.playbackState();
    assert(result.app === "Music", "Playback state should identify Music.");
    return {
      ...result,
      service: "apple_music",
      actionSummary: result.running ? "Read Music playback state." : "Music playback state is unavailable because Music is not running.",
    };
  });

  await runScenario("S4.spotify.search-missing-config", "Return missing Spotify config for search", async () => {
    const result = await music.searchSpotify("Cruel Summer", "Taylor Swift", 3);
    assert(result.status === "missing_config", "Spotify search should report missing config in the S4 fixture environment.");
    return {
      ...result,
      actionSummary: "Reported missing Spotify API configuration instead of fake search success.",
    };
  });

  await runScenario("S4.spotify.play-missing-config", "Return missing Spotify config for playback", async () => {
    const result = await music.playSpotifyTrack("Cruel Summer", "Taylor Swift");
    assert(result.status === "missing_config", "Spotify playback should report missing config in the S4 fixture environment.");
    return {
      ...result,
      actionSummary: "Reported missing Spotify API configuration instead of fake playback success.",
    };
  });

  await runScenario("S4.spotify.state-missing-config", "Return missing Spotify config for playback state", async () => {
    const result = await music.spotifyPlaybackState();
    assert(result.status === "missing_config", "Spotify state should report missing config in the S4 fixture environment.");
    return {
      ...result,
      actionSummary: "Reported missing Spotify API configuration instead of fake playback state.",
    };
  });

  await runScenario("S4.netease.open-search", "Open NetEase Cloud Music search", async () => {
    const result = await music.openNetease("晴天 周杰伦");
    assert(result.status === "opened", "NetEase command should open app or official web search.");
    assert(result.query === "晴天 周杰伦", "NetEase result should preserve the query.");
    assert(String(result.note).includes("Direct playback is not claimed"), "NetEase result must not claim direct playback.");
    return {
      ...result,
      actionSummary: "Opened NetEase Cloud Music app or official search page without claiming playback.",
    };
  });

  await runScenario("S4.qq.open-web-search", "Open QQ Music web search", async () => {
    const result = await music.openQqMusic("晴天 周杰伦", "web");
    assert(result.status === "opened_search", "QQ Music web command should open a search page.");
    assert(result.query === "晴天 周杰伦", "QQ Music result should preserve the query.");
    assert(String(result.note).includes("Direct playback is not claimed"), "QQ Music result must not claim direct playback.");
    return {
      ...result,
      actionSummary: "Opened QQ Music official search page without claiming playback.",
    };
  });

  await runScenario("S4.media-key.no-visible-target", "Do not send media key without a visible target app", async () => {
    const result = await system.mediaKeyControl("play_pause", "Her S4 Missing Player");
    assert(result.status === "unavailable", "Missing media target should return unavailable.");
    assert(result.attempted === false, "Missing media target should not send a playback key.");
    return {
      ...result,
      actionSummary: "Returned unavailable instead of sending play/pause to an unknown target.",
    };
  });

  await runScenario("S4.video.youtube-search", "Open YouTube search in isolated Chrome", async () => {
    const result = await video.play("youtube", "lofi hip hop radio", "search");
    await waitForCdpPage(debugPort, result.url);
    assert(result.status === "opened_search", "YouTube search mode should open search results.");
    assert(result.browser === "isolated_chrome", "YouTube should use isolated Chrome.");
    return {
      ...result,
      actionSummary: "Opened YouTube search in isolated Chrome without claiming playback.",
    };
  });

  await runScenario("S4.video.controlled-state", "Read video state from controlled test page", async () => {
    await browser.openIsolatedUrl(videoFixtureUrl);
    await waitForCdpPage(debugPort, videoFixtureUrl);
    const result = await video.controlActiveVideo("state");
    assert(result.ok === true, "Controlled fixture should expose a video element.");
    assert(result.url === videoFixtureUrl, "Video state URL should match the local fixture.");
    return {
      ...result,
      actionSummary: "Read video playback state from a controlled local fixture.",
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

const report = {
  milestone: "S4",
  title: "Music, Media, and Video",
  generatedAt: new Date().toISOString(),
  realtime2Connected: false,
  fixtureOrigin: `http://127.0.0.1:${fixturePort}`,
  debugPort,
  summary,
  results,
  acceptance: {
    playbackCommandsNameTargetServiceQueryFallback:
      results.find((item) => item.id === "S4.music.play-song-search")?.status === "passed" &&
      results.find((item) => item.id === "S4.spotify.play-missing-config")?.status === "passed" &&
      results.find((item) => item.id === "S4.video.youtube-search")?.status === "passed",
    missingSetupDoesNotProduceFakeSuccess:
      results.find((item) => item.id === "S4.spotify.search-missing-config")?.status === "passed" &&
      results.find((item) => item.id === "S4.spotify.play-missing-config")?.status === "passed" &&
      results.find((item) => item.id === "S4.spotify.state-missing-config")?.status === "passed",
    mediaKeyRequiresVisibleTarget:
      results.find((item) => item.id === "S4.media-key.no-visible-target")?.status === "passed",
    noMusicKitPrivateKeyMaterialInReport: true,
    controlledVideoStateWorks:
      results.find((item) => item.id === "S4.video.controlled-state")?.status === "passed",
  },
};

const serializedReport = JSON.stringify(report, null, 2);
report.acceptance.noMusicKitPrivateKeyMaterialInReport =
  !serializedReport.includes("BEGIN PRIVATE KEY") &&
  !serializedReport.includes("END PRIVATE KEY") &&
  !serializedReport.includes("MusicKit Key");

fs.mkdirSync(reportDir, { recursive: true });
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

const logEntry = `
## S4 Music, Media, and Video - ${summary.failed === 0 ? "Passed" : "Failed"}

Report: \`docs/test-runs/simple-command-media/S4-media-video-report.json\`

- Total scenarios: ${summary.total}
- Passed: ${summary.passed}
- Failed: ${summary.failed}
- Realtime-2 connected: false
- Real execution: Music app open/search/state, Spotify missing-config handling, NetEase and QQ Music search opening, media-key safety preflight, YouTube isolated search, and controlled local video state.
- Safety checks: Spotify tokens were blanked for fixture testing; media keys were not sent without a visible target app; MusicKit private key material was not read into the report.
`;

fs.appendFileSync(logPath, logEntry);

console.log(JSON.stringify({ reportPath, summary }, null, 2));
if (summary.failed > 0) process.exitCode = 1;

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
