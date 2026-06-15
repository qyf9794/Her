#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const root = path.resolve(new URL("..", import.meta.url).pathname);
const distSystemControlPath = path.join(root, "electron", "dist", "main", "tools", "system-control.js");
const outputDir = path.join(root, "docs", "test-runs", "simple-command-desktop");
const outputPath = path.join(outputDir, "S1-desktop-window-report.json");

const testPrefix = "Her S1";
const tolerancePx = 36;

const run = (command, args, input, timeoutMs = 10000) =>
  new Promise((resolve, reject) => {
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

const appleScript = (script, timeoutMs = 10000) => run("osascript", [], script, timeoutMs);

const main = async () => {
  if (!fs.existsSync(distSystemControlPath)) {
    throw new Error("Missing compiled SystemControl. Run `tsc -p electron/tsconfig.json` before S1.");
  }

  const { SystemControl } = require(distSystemControlPath);
  const system = new SystemControl();
  const report = {
    schemaVersion: 1,
    milestone: "S1",
    title: "Desktop App and Window Real Simulation",
    generatedAt: new Date().toISOString(),
    realtime2Connected: false,
    testApp: "TextEdit",
    protectedApps: ["Electron", "HER", "Her Voice Agent", "Codex", "System Settings"],
    summary: { total: 0, passed: 0, failed: 0, skipped: 0, blocked: 0 },
    scenarios: [],
  };

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "her-s1-desktop-"));
  let createdTextEditWindows = false;

  const record = async (id, name, runScenario) => {
    const startedAt = new Date().toISOString();
    try {
      const result = await runScenario();
      const status = result.status ?? (result.passed ? "passed" : "failed");
      report.scenarios.push({
        id,
        name,
        status,
        startedAt,
        finishedAt: new Date().toISOString(),
        ...result,
      });
    } catch (error) {
      report.scenarios.push({
        id,
        name,
        status: "failed",
        startedAt,
        finishedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  try {
    await record("S1.preflight.accessibility", "Verify System Events can inspect windows", async () => {
      const frontmostApp = await frontmostProcess();
      const visibleApps = await visibleApplicationProcesses();
      return {
        passed: Boolean(frontmostApp && visibleApps.length),
        expected: "System Events returns frontmost and visible application process data.",
        actual: { frontmostApp, visibleAppCount: visibleApps.length, visibleApps: visibleApps.slice(0, 12) },
      };
    });

    await record("S1.protection.codex-skipped", "Verify Codex is in protected window script list", async () => {
      const source = fs.readFileSync(path.join(root, "src", "main", "tools", "system-control.ts"), "utf8");
      const protectedEverywhere = [...source.matchAll(/set skippedApps to \{([^}]+)\}/g)]
        .map((match) => match[1])
        .every((list) => list.includes('"Codex"'));
      return {
        passed: protectedEverywhere,
        expected: "All batch window scripts skip Codex.",
        actual: { protectedEverywhere },
      };
    });

    const existingTextEditWindows = await textEditWindowCount();
    if (existingTextEditWindows > 0) {
      await record("S1.preflight.textedit-clean", "Ensure TextEdit has no pre-existing user windows", async () => ({
        status: "blocked",
        expected: "TextEdit has 0 existing windows so the test can safely own and clean up TextEdit.",
        actual: { existingTextEditWindows },
        blocker: "TextEdit already has user windows. S1 will not risk closing or rearranging them.",
      }));
    } else {
      await record("S1.app.open-focus", "Open and focus TextEdit", async () => {
        await system.openApp("TextEdit");
        await system.focusApp("TextEdit");
        const frontmostApp = await frontmostProcess();
        return {
          passed: frontmostApp === "TextEdit",
          expected: "TextEdit becomes the frontmost app.",
          actual: { frontmostApp },
        };
      });

      await createTextEditFixtureWindows(tempRoot, 10);
      createdTextEditWindows = true;

      await record("S1.window.list", "List visible TextEdit test windows", async () => {
        const windows = (await system.listWindows(["TextEdit"])).filter((item) => item.appName === "TextEdit");
        const testWindows = windows.filter((item) => item.title.includes(testPrefix));
        return {
          passed: testWindows.length >= 10,
          expected: "At least 10 disposable TextEdit windows are visible and listed.",
          actual: { listedTextEditWindows: windows.length, listedTestWindows: testWindows.length, sampleTitles: testWindows.slice(0, 5).map((item) => item.title) },
        };
      });

      await record("S1.window.move-resize", "Move and resize the front TextEdit window", async () => {
        await system.focusApp("TextEdit");
        await system.moveResizeWindow("TextEdit", 80, 80, 800, 600);
        const windows = (await system.listWindows(["TextEdit"])).filter((item) => item.appName === "TextEdit");
        const matched = windows.some((item) =>
          Math.abs(item.x - 80) <= tolerancePx &&
          Math.abs(item.y - 80) <= tolerancePx &&
          Math.abs(item.width - 800) <= tolerancePx &&
          Math.abs(item.height - 600) <= tolerancePx
        );
        return {
          passed: matched,
          expected: `A TextEdit window is moved near 80,80 and resized near 800x600 within ${tolerancePx}px.`,
          actual: { matched, windows: windows.map(compactWindow).slice(0, 10) },
        };
      });

      await record("S1.window.auto-arrange-10", "Arrange 10 disposable TextEdit windows into a grid", async () => {
        const result = await system.autoArrangeWindows(["TextEdit"]);
        return {
          passed: result.verified && result.targetWindows >= 10 && result.windowsArranged === result.targetWindows,
          expected: "All disposable TextEdit windows are arranged, with target and arranged counts equal.",
          actual: result,
        };
      });

      await record("S1.window.minimize-unrelated", "Keep one named test window and minimize unrelated TextEdit windows", async () => {
        const result = await system.minimizeUnrelatedWindows({
          appNames: ["TextEdit"],
          keepAppNames: [],
          keepTitleKeywords: [`${testPrefix} Keep`],
          preserveFrontmost: false,
        });
        return {
          passed: result.windowsPreserved >= 1 && result.windowsMinimized >= 1,
          expected: "The keep window is preserved and at least one unrelated TextEdit test window is minimized.",
          actual: result,
        };
      });

      await record("S1.desktop.show", "Trigger Show Desktop without closing apps", async () => {
        const result = await system.showDesktop();
        return {
          passed: result.attempted === true,
          expected: "macOS Show Desktop shortcut is sent; no app is quit or closed.",
          actual: result,
        };
      });
    }

    await record("S1.excluded.close-all", "Do not execute close-all windows in unattended S1", async () => ({
      status: "skipped",
      expected: "window_close_all is represented only as a high-risk confirmation/denial in unattended S1.",
      actual: {
        reason: "Closing all windows can affect user context. It requires explicit user confirmation in an interactive run.",
      },
    }));
  } finally {
    if (createdTextEditWindows) {
      await cleanupTextEdit(tempRoot).catch((error) => {
        report.scenarios.push({
          id: "S1.cleanup.textedit",
          name: "Cleanup disposable TextEdit windows",
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  report.summary = summarize(report.scenarios);
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  console.log(`report=${path.relative(root, outputPath)}`);
  console.log(`total=${report.summary.total}`);
  console.log(`passed=${report.summary.passed}`);
  console.log(`failed=${report.summary.failed}`);
  console.log(`skipped=${report.summary.skipped}`);
  console.log(`blocked=${report.summary.blocked}`);
  if (report.summary.failed > 0 || report.summary.blocked > 0) process.exitCode = 1;
};

const summarize = (scenarios) => {
  const summary = { total: scenarios.length, passed: 0, failed: 0, skipped: 0, blocked: 0 };
  for (const scenario of scenarios) {
    if (scenario.status === "passed") summary.passed += 1;
    else if (scenario.status === "skipped") summary.skipped += 1;
    else if (scenario.status === "blocked") summary.blocked += 1;
    else summary.failed += 1;
  }
  return summary;
};

const compactWindow = (item) => ({
  title: item.title,
  x: item.x,
  y: item.y,
  width: item.width,
  height: item.height,
});

const frontmostProcess = () => appleScript(`
tell application "System Events"
  repeat with proc in application processes
    try
      if frontmost of proc is true then return name of proc as text
    end try
  end repeat
  return ""
end tell
`);

const visibleApplicationProcesses = async () => {
  const output = await appleScript(`
tell application "System Events"
  set output to ""
  repeat with proc in (application processes whose background only is false)
    try
      set output to output & (name of proc as text) & linefeed
    end try
  end repeat
  return output
end tell
`);
  return output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
};

const textEditWindowCount = async () => {
  const output = await appleScript(`
tell application "System Events"
  if exists process "TextEdit" then
    return count of windows of process "TextEdit"
  else
    return 0
  end if
end tell
`);
  return Number(output) || 0;
};

const createTextEditFixtureWindows = async (tempRoot, count) => {
  const script = `
set tempRoot to ${JSON.stringify(tempRoot)}
tell application "TextEdit"
  activate
  repeat with indexValue from 0 to ${count - 1}
    set labelText to "Other " & text -2 thru -1 of ("0" & (indexValue as text))
    if indexValue is 0 then set labelText to "Keep"
    set targetPath to tempRoot & "/${testPrefix} " & labelText & ".rtf"
    set docRef to make new document with properties {text:"${testPrefix} " & labelText}
    save docRef in POSIX file targetPath
  end repeat
end tell
`;
  await appleScript(script, 20000);
  await waitForTextEditWindows(count, 12000);
};

const waitForTextEditWindows = async (expected, timeoutMs) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const count = await textEditWindowCount();
    if (count >= expected) return;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  const count = await textEditWindowCount();
  throw new Error(`Expected ${expected} TextEdit windows, got ${count}.`);
};

const cleanupTextEdit = async () => {
  await appleScript(`
tell application "TextEdit"
  try
    close every document saving no
  end try
  try
    quit saving no
  end try
end tell
`, 10000);
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
