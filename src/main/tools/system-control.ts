import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
type KeyboardShortcutAction =
  | "copy"
  | "paste"
  | "select_all"
  | "undo"
  | "enter"
  | "escape"
  | "tab"
  | "new_window"
  | "new_tab"
  | "refresh"
  | "browser_back"
  | "browser_forward"
  | "toggle_fullscreen";

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

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const normalizeMacAppName = (appName: string) => {
  const trimmed = appName.trim();
  const normalized = trimmed.toLowerCase().replace(/[\s._-]+/g, "");
  if (["appletv", "苹果tv", "苹果电视", "tvapp", "电视app"].includes(normalized)) {
    return { openName: "TV", processName: "TV" };
  }
  if (["applemusic", "musicapp", "音乐", "音乐app"].includes(normalized)) {
    return { openName: "Music", processName: "Music" };
  }
  if (["safari浏览器", "浏览器safari"].includes(normalized)) {
    return { openName: "Safari", processName: "Safari" };
  }
  if (["微信", "wechat"].includes(normalized)) {
    return { openName: "WeChat", processName: "WeChat" };
  }
  if (normalized === "chrome") {
    return { openName: "Google Chrome", processName: "Google Chrome" };
  }
  return { openName: trimmed, processName: trimmed };
};

const isAppRunning = async (processName: string) => {
  const script = `
    tell application "System Events"
      return exists process ${JSON.stringify(processName)}
    end tell
  `;
  const output = await run("osascript", ["-e", script], undefined, 5000);
  return output.trim().toLowerCase() === "true";
};

const appOpenDisplay = (appName: string, requestedAppName: string, verified: boolean) => ({
  title: verified ? `${appName} 已打开` : `${appName} 打开未确认`,
  subtitle: requestedAppName !== appName ? `来自请求: ${requestedAppName}` : undefined,
  kind: "apps",
  generatedAt: new Date().toISOString(),
  source: "macOS",
  metrics: [
    { label: "状态", value: verified ? "opened" : "open_requested" },
    { label: "验证", value: verified ? "进程已运行" : "未检测到进程" },
  ],
  items: [
    {
      title: appName,
      body: verified ? "macOS 已确认目标 app 进程存在。" : "HER 已发送打开请求，但没有确认目标 app 出现在系统进程中。",
    },
  ],
  note: verified ? undefined : "如果 app 名称是别名，请在设置里确认应用授权和实际 macOS app 名称。",
});

export class SystemControl {
  async openApp(appName: string) {
    const target = normalizeMacAppName(appName);
    await run("open", ["-a", target.openName]);
    await delay(700);
    const verified = await isAppRunning(target.processName).catch(() => false);
    return {
      status: verified ? "opened" : "open_requested",
      opened: target.openName,
      requestedAppName: appName,
      verified,
      display: appOpenDisplay(target.openName, appName, verified),
    };
  }

  async focusApp(appName: string) {
    const target = normalizeMacAppName(appName);
    const script = `
      tell application ${JSON.stringify(target.openName)} to activate
      delay 0.2
      tell application "System Events"
        try
          set frontmost of process ${JSON.stringify(target.processName)} to true
        end try
      end tell
    `;
    await run("osascript", ["-e", script], undefined, 10000);
    return { focused: target.openName, requestedAppName: appName };
  }

  async closeApp(appName: string) {
    await run("osascript", ["-e", `tell application ${JSON.stringify(appName)} to quit`]);
    return { closed: appName };
  }

  async quitApp(appName: string) {
    await run("osascript", ["-e", `tell application ${JSON.stringify(appName)} to quit`]);
    return { quit: appName };
  }

  async listWindows(appNames?: Iterable<string>) {
    const allowedApps = [...(appNames ?? [])].filter(Boolean);
    const script = `
      tell application "System Events"
        set sep to character id 31
        set allowedApps to ${appleScriptList(allowedApps)}
        set skippedApps to {"Electron", "HER", "Her Voice Agent", "Codex", "System Settings"}
        set output to ""
        repeat with proc in (application processes whose visible is true)
          set appName to name of proc
          if appName is not in skippedApps then
            if (count of allowedApps) is 0 or appName is in allowedApps then
              try
                with timeout of 2 seconds
                  repeat with targetWindow in windows of proc
                    set winName to ""
                    set winX to 0
                    set winY to 0
                    set winWidth to 0
                    set winHeight to 0
                    try
                      set winName to name of targetWindow as text
                      set winPosition to position of targetWindow
                      set winSize to size of targetWindow
                      set winX to item 1 of winPosition
                      set winY to item 2 of winPosition
                      set winWidth to item 1 of winSize
                      set winHeight to item 2 of winSize
                      set output to output & appName & sep & winName & sep & (winX as text) & sep & (winY as text) & sep & (winWidth as text) & sep & (winHeight as text) & linefeed
                    end try
                  end repeat
                end timeout
              end try
            end if
          end if
        end repeat
        return output
      end tell
    `;
    const output = await run("osascript", ["-e", script], undefined, 20000);
    return output
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [appName, title, x, y, width, height] = line.split("\u001f");
        return {
          appName,
          title,
          x: Number(x),
          y: Number(y),
          width: Number(width),
          height: Number(height),
        };
      });
  }

  async closeWindow(appName: string) {
    const output = await run("osascript", ["-e", closeWindowScript(appName)], undefined, 10000);
    const [before, after, method] = output.split("|");
    const windowsBefore = Number(before) || 0;
    const windowsAfter = Number(after) || 0;
    return {
      closedWindowFor: appName,
      windowsBefore,
      windowsAfter,
      verified: windowsAfter < windowsBefore,
      method,
      note: windowsAfter < windowsBefore ? "Verified that the app has fewer visible windows after the close action." : "Close action ran, but the visible window count did not decrease.",
    };
  }

  async closeAllWindows(appNames?: Iterable<string>) {
    const allowedApps = [...(appNames ?? [])].filter(Boolean);
    const script = `
      tell application "System Events"
        set allowedApps to ${appleScriptList(allowedApps)}
        set skippedApps to {"Electron", "HER", "Her Voice Agent", "Codex", "System Settings"}
        set closedCount to 0
        set appCount to 0

        repeat with proc in (application processes whose visible is true)
          set appName to name of proc
          if appName is not in skippedApps then
            if (count of allowedApps) is 0 or appName is in allowedApps then
              set appClosedCount to 0
              tell proc
                repeat while (count of windows) is greater than 0
                  try
                    set targetWindow to window 1
                    if exists button 1 of targetWindow then
                      click button 1 of targetWindow
                      set closedCount to closedCount + 1
                      set appClosedCount to appClosedCount + 1
                      delay 0.05
                    else
                      exit repeat
                    end if
                  on error
                    exit repeat
                  end try
                end repeat
              end tell
              if appClosedCount is greater than 0 then set appCount to appCount + 1
            end if
          end if
        end repeat

        set remainingCount to 0
        repeat with proc in (application processes whose visible is true)
          set appName to name of proc
          if appName is not in skippedApps then
            if (count of allowedApps) is 0 or appName is in allowedApps then
              tell proc
                repeat with targetWindow in windows
                  try
                    if subrole of targetWindow is "AXStandardWindow" then set remainingCount to remainingCount + 1
                  end try
                end repeat
              end tell
            end if
          end if
        end repeat

        return (closedCount as text) & "|" & (appCount as text) & "|" & (remainingCount as text)
      end tell
    `;
    const output = await run("osascript", ["-e", script], undefined, 20000);
    const [windowsClosed, appsAffected, windowsRemaining] = output.split("|").map((value) => Number(value) || 0);
    return {
      windowsClosed,
      appsAffected,
      windowsRemaining,
      verified: windowsClosed > 0 && windowsRemaining === 0,
      scope: allowedApps.length ? "authorized_apps" : "all_visible_apps",
    };
  }

  async hideAllWindows(options: { preserveFrontmost?: boolean; preserveFinder?: boolean } = {}) {
    const preserveFrontmost = options.preserveFrontmost ?? false;
    const preserveFinder = options.preserveFinder ?? true;
    const script = `
      tell application "System Events"
        set skippedApps to {"Electron", "HER", "Her Voice Agent", "Codex", "System Events"}
        set frontAppName to ""
        if ${preserveFrontmost ? "true" : "false"} then
          repeat with proc in application processes
            try
              if frontmost of proc is true then
                set frontAppName to name of proc
                exit repeat
              end if
            end try
          end repeat
        end if

        set hiddenCount to 0
        set preservedCount to 0
        repeat with proc in (application processes whose visible is true)
          set appName to name of proc
          set shouldPreserve to false
          if appName is in skippedApps then set shouldPreserve to true
          if ${preserveFinder ? "true" : "false"} then
            if appName is "Finder" then set shouldPreserve to true
          end if
          if ${preserveFrontmost ? "true" : "false"} then
            if appName is frontAppName then set shouldPreserve to true
          end if

          if shouldPreserve is true then
            set preservedCount to preservedCount + 1
          else
            try
              set visible of proc to false
              set hiddenCount to hiddenCount + 1
            end try
          end if
        end repeat

        return (hiddenCount as text) & "|" & (preservedCount as text) & "|" & frontAppName
      end tell
    `;
    const output = await run("osascript", ["-e", script], undefined, 10000);
    const [hiddenCount, preservedCount, frontmostApp] = output.split("|");
    return {
      hiddenCount: Number(hiddenCount) || 0,
      preservedCount: Number(preservedCount) || 0,
      frontmostApp,
      preserveFrontmost,
      preserveFinder,
      verified: Number(hiddenCount) > 0,
      note: preserveFrontmost ? "Hid visible apps except the current frontmost app and protected apps." : "Hid visible apps except protected apps.",
    };
  }

  async minimizeAllWindows() {
    const script = `
      tell application "System Events"
        set skippedApps to {"Electron", "HER", "Her Voice Agent", "Codex", "System Settings"}
        set minimizedCount to 0
        set appCount to 0

        repeat with proc in (application processes whose visible is true)
          set appName to name of proc
          if appName is not in skippedApps then
            set appMinimizedCount to 0
            tell proc
              repeat with targetWindow in windows
                try
                  set value of attribute "AXMinimized" of targetWindow to true
                  set minimizedCount to minimizedCount + 1
                  set appMinimizedCount to appMinimizedCount + 1
                end try
              end repeat
            end tell
            if appMinimizedCount is greater than 0 then set appCount to appCount + 1
          end if
        end repeat

        return (minimizedCount as text) & "|" & (appCount as text)
      end tell
    `;
    const output = await run("osascript", ["-e", script], undefined, 20000);
    const [windowsMinimized, appsAffected] = output.split("|");
    return {
      windowsMinimized: Number(windowsMinimized) || 0,
      appsAffected: Number(appsAffected) || 0,
      verified: Number(windowsMinimized) > 0,
    };
  }

  async autoArrangeWindows(appNames?: Iterable<string>) {
    const allowedApps = [...(appNames ?? [])].filter(Boolean);
    const script = `
      tell application "System Events"
        set allowedApps to ${appleScriptList(allowedApps)}
        set skippedApps to {"Electron", "HER", "Her Voice Agent", "Codex", "System Settings"}
        set targetCount to 0

        if (count of allowedApps) is greater than 0 then
          repeat with requestedApp in allowedApps
            set appName to requestedApp as text
            if appName is not in skippedApps then
              repeat with proc in (application processes whose visible is true)
                set currentAppName to name of proc as text
                if currentAppName is appName then
                  tell proc
                    repeat with targetWindow in windows
                      try
                        if subrole of targetWindow is "AXStandardWindow" then set targetCount to targetCount + 1
                      end try
                    end repeat
                  end tell
                end if
              end repeat
            end if
          end repeat
        else
          repeat with proc in (application processes whose visible is true)
            set appName to name of proc
            if appName is not in skippedApps then
              tell proc
                repeat with targetWindow in windows
                  try
                    if subrole of targetWindow is "AXStandardWindow" then set targetCount to targetCount + 1
                  end try
                end repeat
              end tell
            end if
          end repeat
        end if

        if targetCount is 0 then return "0|0|0"

        set desktopBounds to {0, 25, 1440, 900}
        try
          tell application "Finder"
            set desktopBounds to bounds of window of desktop
          end tell
        end try

        set leftEdge to item 1 of desktopBounds
        set topEdge to item 2 of desktopBounds
        set rightEdge to item 3 of desktopBounds
        set bottomEdge to item 4 of desktopBounds
        set usableWidth to rightEdge - leftEdge
        set usableHeight to bottomEdge - topEdge

        set columnsCount to 1
        repeat while (columnsCount * columnsCount) < targetCount
          set columnsCount to columnsCount + 1
        end repeat
        set rowsCount to ((targetCount + columnsCount - 1) div columnsCount)

        set cellWidth to usableWidth div columnsCount
        set cellHeight to usableHeight div rowsCount
        set arrangedCount to 0
        set appCount to 0

        if (count of allowedApps) is greater than 0 then
          repeat with requestedApp in allowedApps
            set appName to requestedApp as text
            if appName is not in skippedApps then
              set appArrangedCount to 0
              repeat with proc in (application processes whose visible is true)
                set currentAppName to name of proc as text
                if currentAppName is appName then
                  tell proc
                  repeat with targetWindow in windows
                    try
                      if subrole of targetWindow is "AXStandardWindow" then
                        set winIndex to arrangedCount
                        set columnIndex to winIndex mod columnsCount
                        set rowIndex to winIndex div columnsCount
                        set position of targetWindow to {leftEdge + (columnIndex * cellWidth), topEdge + (rowIndex * cellHeight)}
                        set size of targetWindow to {cellWidth, cellHeight}
                        set arrangedCount to arrangedCount + 1
                        set appArrangedCount to appArrangedCount + 1
                        delay 0.03
                      end if
                    end try
                  end repeat
                end tell
                end if
              end repeat
              if appArrangedCount is greater than 0 then set appCount to appCount + 1
            end if
          end repeat
        else
          repeat with proc in (application processes whose visible is true)
            set appName to name of proc
            if appName is not in skippedApps then
              set appArrangedCount to 0
              tell proc
                repeat with targetWindow in windows
                  try
                    if subrole of targetWindow is "AXStandardWindow" then
                      set winIndex to arrangedCount
                      set columnIndex to winIndex mod columnsCount
                      set rowIndex to winIndex div columnsCount
                      set position of targetWindow to {leftEdge + (columnIndex * cellWidth), topEdge + (rowIndex * cellHeight)}
                      set size of targetWindow to {cellWidth, cellHeight}
                      set arrangedCount to arrangedCount + 1
                      set appArrangedCount to appArrangedCount + 1
                      delay 0.03
                    end if
                  end try
                end repeat
              end tell
              if appArrangedCount is greater than 0 then set appCount to appCount + 1
            end if
          end repeat
        end if

        return (arrangedCount as text) & "|" & (appCount as text) & "|" & (columnsCount as text) & "x" & (rowsCount as text) & "|" & (targetCount as text)
      end tell
    `;
    await writeDebugScript("auto-arrange.applescript", script);
    const output = await run("osascript", ["-e", script], undefined, 60000);
    const [windowsArranged, appsAffected, layout, targetWindows] = output.split("|");
    const arranged = Number(windowsArranged) || 0;
    const target = Number(targetWindows) || 0;
    return {
      windowsArranged: arranged,
      targetWindows: target,
      appsAffected: Number(appsAffected) || 0,
      layout,
      verified: target > 0 && arranged === target,
      scope: allowedApps.length ? "authorized_apps" : "all_visible_apps",
    };
  }

  async minimizeUnrelatedWindows(options: {
    appNames?: Iterable<string>;
    keepAppNames?: Iterable<string>;
    keepTitleKeywords?: Iterable<string>;
    preserveFrontmost?: boolean;
  }) {
    const allowedApps = [...(options.appNames ?? [])].filter(Boolean);
    const keepAppNames = [...(options.keepAppNames ?? [])].filter(Boolean);
    const keepTitleKeywords = [...(options.keepTitleKeywords ?? [])].map((value) => value.trim()).filter(Boolean);
    const preserveFrontmost = options.preserveFrontmost ?? true;
    const script = `
      tell application "System Events"
        set allowedApps to ${appleScriptList(allowedApps)}
        set keepApps to ${appleScriptList(keepAppNames)}
        set keepKeywords to ${appleScriptList(keepTitleKeywords)}
        set skippedApps to {"Electron", "HER", "Her Voice Agent", "Codex", "System Settings"}
        set frontAppName to ""
        set frontWindowName to ""
        set minimizedCount to 0
        set preservedCount to 0
        set appCount to 0

        if ${preserveFrontmost ? "true" : "false"} then
          repeat with proc in application processes
            try
              if frontmost of proc is true then
                set frontAppName to name of proc
                if (count of windows of proc) is greater than 0 then set frontWindowName to name of window 1 of proc
                exit repeat
              end if
            end try
          end repeat
        end if

        if (count of allowedApps) is greater than 0 then
          repeat with requestedApp in allowedApps
            set appName to requestedApp as text
            if appName is not in skippedApps then
              set appMinimizedCount to 0
              repeat with proc in (application processes whose visible is true)
                set currentAppName to name of proc as text
                if currentAppName is appName then
                  tell proc
                    repeat with targetWindow in windows
                      try
                        if subrole of targetWindow is "AXStandardWindow" then
                          set winName to name of targetWindow as text
                          set shouldKeep to false
                          if appName is in keepApps then set shouldKeep to true
                          if ${preserveFrontmost ? "true" : "false"} then
                            if appName is frontAppName then
                              if winName is frontWindowName then set shouldKeep to true
                            end if
                          end if
                          repeat with keyword in keepKeywords
                            set keywordText to keyword as text
                            ignoring case
                              if winName contains keywordText then set shouldKeep to true
                            end ignoring
                          end repeat

                          if shouldKeep is true then
                            set preservedCount to preservedCount + 1
                          else
                            set value of attribute "AXMinimized" of targetWindow to true
                            set minimizedCount to minimizedCount + 1
                            set appMinimizedCount to appMinimizedCount + 1
                            delay 0.03
                          end if
                        end if
                      end try
                    end repeat
                  end tell
                end if
              end repeat
              if appMinimizedCount is greater than 0 then set appCount to appCount + 1
            end if
          end repeat
        else
          repeat with proc in (application processes whose visible is true)
            set appName to name of proc
            if appName is not in skippedApps then
              set appMinimizedCount to 0
              tell proc
                repeat with targetWindow in windows
                  try
                    if subrole of targetWindow is "AXStandardWindow" then
                      set winName to name of targetWindow as text
                      set shouldKeep to false
                      if appName is in keepApps then set shouldKeep to true
                      if ${preserveFrontmost ? "true" : "false"} then
                        if appName is frontAppName then
                          if winName is frontWindowName then set shouldKeep to true
                        end if
                      end if
                      repeat with keyword in keepKeywords
                        set keywordText to keyword as text
                        ignoring case
                          if winName contains keywordText then set shouldKeep to true
                        end ignoring
                      end repeat

                      if shouldKeep is true then
                        set preservedCount to preservedCount + 1
                      else
                        set value of attribute "AXMinimized" of targetWindow to true
                        set minimizedCount to minimizedCount + 1
                        set appMinimizedCount to appMinimizedCount + 1
                        delay 0.03
                      end if
                    end if
                  end try
                end repeat
              end tell
              if appMinimizedCount is greater than 0 then set appCount to appCount + 1
            end if
          end repeat
        end if

        return (minimizedCount as text) & "|" & (preservedCount as text) & "|" & (appCount as text) & "|" & frontAppName & "|" & frontWindowName
      end tell
    `;
    await writeDebugScript("minimize-unrelated.applescript", script);
    const output = await run("osascript", ["-e", script], undefined, 60000);
    const [windowsMinimized, windowsPreserved, appsAffected, frontmostApp, frontmostWindow] = output.split("|");
    return {
      windowsMinimized: Number(windowsMinimized) || 0,
      windowsPreserved: Number(windowsPreserved) || 0,
      appsAffected: Number(appsAffected) || 0,
      frontmostApp,
      frontmostWindow,
      scope: allowedApps.length ? "authorized_apps" : "all_visible_apps",
    };
  }

  async minimizeWindow(appName: string) {
    await run("osascript", [
      "-e",
      windowActionScript(appName, `set value of attribute "AXMinimized" of targetWindow to true`),
    ]);
    return { minimizedWindowFor: appName };
  }

  async maximizeWindow(appName: string) {
    await run("osascript", ["-e", windowActionScript(appName, `click button 2 of targetWindow`)]);
    return { maximizedWindowFor: appName };
  }

  async moveResizeWindow(appName: string, x: number, y: number, width: number, height: number) {
    const script = windowActionScript(
      appName,
      `
          set position of targetWindow to {${Math.round(x)}, ${Math.round(y)}}
          set size of targetWindow to {${Math.round(width)}, ${Math.round(height)}}
      `,
    );
    await run("osascript", ["-e", script]);
    return { appName, x, y, width, height };
  }

  async setVolume(level: number) {
    const requestedVolume = Math.round(level);
    await run("osascript", ["-e", `set volume output volume ${requestedVolume}`]);
    const readback = await this.getVolume();
    const applied = readback.volume === requestedVolume;
    return {
      status: applied ? "set" : "platform_limited",
      requestedVolume,
      volume: readback.volume,
      muted: readback.muted,
      note: applied
        ? "Set system output volume and verified readback."
        : "macOS accepted the volume command, but output volume did not read back as requested. The active output device may not expose software volume control.",
    };
  }
  async getVolume() {
    const output = await run("osascript", [
      "-e",
      `set settings to get volume settings
       return (output volume of settings as text) & "|" & (output muted of settings as text)`,
    ]);
    const [volume, muted] = output.split("|");
    return { volume: Number(volume) || 0, muted: muted === "true" };
  }

  async muteVolume(muted: boolean) {
    await run("osascript", ["-e", `set volume ${muted ? "with" : "without"} output muted`]);
    const readback = await this.getVolume();
    const applied = readback.muted === muted;
    return {
      status: applied ? "set" : "platform_limited",
      requestedMuted: muted,
      muted: readback.muted,
      volume: readback.volume,
      note: applied
        ? "Set output mute state and verified readback."
        : "macOS accepted the mute command, but mute state did not read back as requested. The active output device may not expose software mute control.",
    };
  }

  async setBrightness(level: number) {
    const normalized = Math.max(0, Math.min(1, level / 100));
    try {
      await run("brightness", [String(normalized)]);
      return { brightness: level };
    } catch {
      throw new Error("Brightness control requires the local `brightness` CLI. Install it separately or use System Settings > Displays.");
    }
  }

  async setDarkMode(enabled: boolean) {
    await run("osascript", [
      "-e",
      `tell application "System Events" to tell appearance preferences to set dark mode to ${enabled ? "true" : "false"}`,
    ]);
    return { darkMode: enabled };
  }

  async openSettings(pane?: string) {
    const panes: Record<string, string> = {
      system: "x-apple.systempreferences:",
      displays: "x-apple.systempreferences:com.apple.Displays-Settings.extension",
      sound: "x-apple.systempreferences:com.apple.Sound-Settings.extension",
      bluetooth: "x-apple.systempreferences:com.apple.BluetoothSettings",
      wifi: "x-apple.systempreferences:com.apple.wifi-settings-extension",
      keyboard: "x-apple.systempreferences:com.apple.Keyboard-Settings.extension",
      privacy: "x-apple.systempreferences:com.apple.preference.security?Privacy",
      microphone: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
      accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
      screenrecording: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
      automation: "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation",
      fulldiskaccess: "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles",
    };
    const target = pane ? panes[pane.toLowerCase()] : undefined;
    if (pane && !target) throw new Error(`Settings pane is not allowlisted: ${pane}`);
    await run("open", target ? [target] : ["-b", "com.apple.systempreferences"]);
    return { opened: pane ?? "System Settings" };
  }

  async sleepMac() {
    await run("pmset", ["sleepnow"], undefined, 5000);
    return { sleeping: true };
  }

  async lockScreen() {
    await run("pmset", ["displaysleepnow"], undefined, 5000);
    return { displaySleep: true };
  }

  async showDesktop() {
    await run("osascript", ["-e", `tell application "System Events" to key code 103`], undefined, 5000);
    return {
      action: "show_desktop",
      attempted: true,
      note: "Triggered macOS Show Desktop with System Events key code 103.",
    };
  }

  async readClipboard() {
    const text = await run("pbpaste", [], undefined, 5000);
    return { text };
  }

  async speakText(text: string, voice?: string) {
    const args = voice?.trim() ? ["-v", voice.trim(), text] : [text];
    await run("say", args, undefined, 20000);
    return { spoken: true, voice: voice?.trim() || undefined };
  }

  async showNotification(title: string, message: string, dialog = false) {
    const script = dialog
      ? `display dialog ${JSON.stringify(message)} buttons {"取消", "继续"} default button "继续" with title ${JSON.stringify(title)}`
      : `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`;
    const output = await run("osascript", ["-e", script], undefined, 10000);
    return { shown: true, dialog, output: output || undefined };
  }

  async captureScreenshot(mode: "clipboard" | "desktop" | "selection") {
    if (mode === "clipboard") {
      await run("screencapture", ["-c"], undefined, 10000);
      return { captured: true, mode };
    }
    const fileName = `screenshot-${timestampForFileName()}.png`;
    const path = `${process.env.HOME || ""}/Desktop/${fileName}`;
    if (mode === "selection") {
      await run("screencapture", ["-i", path], undefined, 60000);
    } else {
      await run("screencapture", [path], undefined, 10000);
    }
    return { captured: true, mode, path };
  }

  async keyboardShortcut(action: KeyboardShortcutAction) {
    const script = `tell application "System Events" to ${keyboardShortcutAppleScript(action)}`;
    await run("osascript", ["-e", script], undefined, 5000);
    return { action, sent: true };
  }

  async mediaKeyControl(action: "play_pause" | "next" | "previous" | "volume_up" | "volume_down", appName?: string) {
    if (action === "volume_up" || action === "volume_down") {
      const delta = action === "volume_up" ? 10 : -10;
      const output = await run("osascript", [
        "-e",
        `set currentVolume to output volume of (get volume settings)
         set nextVolume to currentVolume + (${delta})
         if nextVolume is greater than 100 then set nextVolume to 100
         if nextVolume is less than 0 then set nextVolume to 0
         set volume output volume nextVolume
         return nextVolume as text`,
      ]);
      return {
        action,
        volume: Number(output) || undefined,
        attempted: true,
        note: "Adjusted system output volume.",
      };
    }

    const targetAppName = appName ? normalizeMediaAppName(appName) : await visibleMediaAppName();
    const targetVisible = targetAppName ? await isVisibleAppProcess(targetAppName) : false;
    if (!targetAppName || !targetVisible) {
      return {
        status: "unavailable",
        reasonCode: "no_visible_media_target",
        action,
        appName: targetAppName,
        requestedAppName: appName,
        attempted: false,
        note: appName
          ? "The requested media app is not visible, so Her did not send a playback key."
          : "No visible media app was detected, so Her did not send a playback key to the current focus.",
      };
    }

    const script = `
      tell application ${JSON.stringify(targetAppName)} to activate
      delay 0.2
      tell application "System Events"
        ${mediaKeyAppleScript(action)}
      end tell
    `;
    await run("osascript", ["-e", script], undefined, 5000);
    return {
      action,
      appName: targetAppName,
      requestedAppName: appName,
      attempted: true,
      note: appName
        ? "Focused the requested app and sent a basic media/control keystroke. App-specific support depends on the media client and current focus."
        : "Sent a basic media/control keystroke to the current focused app. App-specific support depends on the media client and current focus.",
    };
  }
}

const mediaKeyAppleScript = (action: "play_pause" | "next" | "previous" | "volume_up" | "volume_down") => {
  switch (action) {
    case "play_pause":
      return "key code 49";
    case "next":
      return "key code 124 using {command down}";
    case "previous":
      return "key code 123 using {command down}";
    case "volume_up":
    case "volume_down":
      return "";
  }
};

const keyboardShortcutAppleScript = (action: KeyboardShortcutAction) => {
  switch (action) {
    case "copy":
      return `keystroke "c" using {command down}`;
    case "paste":
      return `keystroke "v" using {command down}`;
    case "select_all":
      return `keystroke "a" using {command down}`;
    case "undo":
      return `keystroke "z" using {command down}`;
    case "enter":
      return "key code 36";
    case "escape":
      return "key code 53";
    case "tab":
      return "key code 48";
    case "new_window":
      return `keystroke "n" using {command down}`;
    case "new_tab":
      return `keystroke "t" using {command down}`;
    case "refresh":
      return `keystroke "r" using {command down}`;
    case "browser_back":
      return "key code 123 using {command down}";
    case "browser_forward":
      return "key code 124 using {command down}";
    case "toggle_fullscreen":
      return `keystroke "f" using {control down, command down}`;
  }
};

const timestampForFileName = () => {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
};

const normalizeMediaAppName = (appName: string) => {
  const normalized = appName.trim().toLowerCase();
  if (normalized === "qq音乐" || normalized === "qq music" || normalized === "qqmusic") return "QQMusic";
  if (normalized === "网易云" || normalized === "网易云音乐" || normalized === "netease" || normalized === "neteasemusic") {
    return "NeteaseMusic";
  }
  return appName;
};

const knownMediaAppNames = ["Music", "Spotify", "QQMusic", "NeteaseMusic", "TV"];
const knownMediaAppNamesAppleScript = `{${knownMediaAppNames.map((name) => JSON.stringify(name)).join(", ")}}`;

const visibleMediaAppName = async () => {
  const script = `
    tell application "System Events"
      repeat with mediaAppName in ${knownMediaAppNamesAppleScript}
        set candidateName to mediaAppName as text
        if exists process candidateName then
          tell process candidateName
            if visible is true then return candidateName
          end tell
        end if
      end repeat
    end tell
    return ""
  `;
  const output = await run("osascript", ["-e", script], undefined, 5000).catch(() => "");
  return output || undefined;
};

const isVisibleAppProcess = async (appName: string) => {
  const script = `
    tell application "System Events"
      if not (exists process ${JSON.stringify(appName)}) then return "false"
      tell process ${JSON.stringify(appName)}
        if visible is true then return "true"
      end tell
    end tell
    return "false"
  `;
  const output = await run("osascript", ["-e", script], undefined, 5000).catch(() => "false");
  return output === "true";
};

const closeWindowScript = (appName: string) => `
  tell application ${JSON.stringify(appName)} to activate
  delay 0.2

  tell application "System Events"
    set targetAppName to ${JSON.stringify(appName)}
    set beforeCount to 0
    set afterCount to 0

    repeat 10 times
      repeat with proc in (application processes whose visible is true)
        if name of proc is targetAppName then
          tell proc
            try
              set beforeCount to count of windows
            end try
          end tell
        end if
      end repeat
      if beforeCount is greater than 0 then exit repeat
      delay 0.1
    end repeat

    if beforeCount is 0 then error "No controllable windows found for ${escapeAppleScriptString(appName)}. Open or create a window first."

    set closeMethod to "command_w"
    keystroke "w" using {command down}
    delay 0.4

    repeat with proc in (application processes whose visible is true)
      if name of proc is targetAppName then
        tell proc
          try
            set afterCount to count of windows
          end try
        end tell
      end if
    end repeat

    return (beforeCount as text) & "|" & (afterCount as text) & "|" & closeMethod
  end tell
`;

const windowActionScript = (appName: string, action: string) => `
  tell application ${JSON.stringify(appName)} to activate
  delay 0.2

  tell application "System Events"
    if not (exists process ${JSON.stringify(appName)}) then error "App process is not available: ${escapeAppleScriptString(appName)}"

    tell process ${JSON.stringify(appName)}
      repeat 10 times
        if (count of windows) is greater than 0 then exit repeat
        delay 0.1
      end repeat

      if (count of windows) = 0 then error "No controllable windows found for ${escapeAppleScriptString(appName)}. Open or create a window first."

      try
        set targetWindow to first window whose subrole is "AXStandardWindow"
      on error
        set targetWindow to window 1
      end try

      ${action}
    end tell
  end tell
`;

const escapeAppleScriptString = (value: string) => value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

const appleScriptList = (values: string[]) => `{${values.map((value) => JSON.stringify(value)).join(", ")}}`;

const writeDebugScript = async (name: string, script: string) => {
  const folder = process.env.HER_DEBUG_APPLESCRIPT_DIR;
  if (!folder) return;
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(folder, name), script, "utf8");
};
