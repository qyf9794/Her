import { spawn } from "node:child_process";
const run = (command: string, args: string[], input?: string) =>
  new Promise<string>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.trim() || `${command} exited with code ${code}`));
    });
    child.stdin.end(input);
  });

export class SystemControl {
  async openApp(appName: string) {
    await run("open", ["-a", appName]);
    return { opened: appName };
  }

  async focusApp(appName: string) {
    await run("osascript", ["-e", `tell application ${JSON.stringify(appName)} to activate`]);
    return { focused: appName };
  }

  async closeApp(appName: string) {
    await run("osascript", ["-e", `tell application ${JSON.stringify(appName)} to quit`]);
    return { closed: appName };
  }

  async quitApp(appName: string) {
    await run("osascript", ["-e", `tell application ${JSON.stringify(appName)} to quit`]);
    return { quit: appName };
  }

  async listWindows() {
    const script = `
      tell application "System Events"
        set sep to ASCII character 31
        set output to ""
        repeat with proc in (application processes whose visible is true)
          set appName to name of proc
          try
            repeat with targetWindow in windows of proc
              set winPosition to position of targetWindow
              set winSize to size of targetWindow
              set output to output & appName & sep & name of targetWindow & sep & item 1 of winPosition & sep & item 2 of winPosition & sep & item 1 of winSize & sep & item 2 of winSize & linefeed
            end repeat
          end try
        end repeat
        return output
      end tell
    `;
    const output = await run("osascript", ["-e", script]);
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
    await run("osascript", ["-e", windowActionScript(appName, `click button 1 of targetWindow`)]);
    return { closedWindowFor: appName };
  }

  async closeAllWindows(appNames?: Iterable<string>) {
    const allowedApps = [...(appNames ?? [])].filter(Boolean);
    const script = `
      tell application "System Events"
        set allowedApps to ${appleScriptList(allowedApps)}
        set skippedApps to {"Electron", "HER", "Her Voice Agent", "System Settings"}
        set closedCount to 0
        set appCount to 0

        repeat with proc in (application processes whose visible is true)
          set appName to name of proc
          if appName is not in skippedApps then
            if (count of allowedApps) is 0 or appName is in allowedApps then
              set appClosedCount to 0
              tell proc
                repeat while (count of windows) > 0
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
              if appClosedCount > 0 then set appCount to appCount + 1
            end if
          end if
        end repeat

        return (closedCount as text) & "|" & (appCount as text)
      end tell
    `;
    const output = await run("osascript", ["-e", script]);
    const [windowsClosed, appsAffected] = output.split("|").map((value) => Number(value) || 0);
    return { windowsClosed, appsAffected, scope: allowedApps.length ? "authorized_apps" : "all_visible_apps" };
  }

  async autoArrangeWindows(appNames?: Iterable<string>) {
    const allowedApps = [...(appNames ?? [])].filter(Boolean);
    const script = `
      tell application "System Events"
        set allowedApps to ${appleScriptList(allowedApps)}
        set skippedApps to {"Electron", "HER", "Her Voice Agent", "System Settings"}
        set targetCount to 0

        repeat with proc in (application processes whose visible is true)
          set appName to name of proc
          if appName is not in skippedApps then
            if (count of allowedApps) is 0 or appName is in allowedApps then
              tell proc
                repeat with targetWindow in windows
                  try
                    if subrole of targetWindow is "AXStandardWindow" then set targetCount to targetCount + 1
                  end try
                end repeat
              end tell
            end if
          end if
        end repeat

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

        repeat with proc in (application processes whose visible is true)
          set appName to name of proc
          if appName is not in skippedApps then
            if (count of allowedApps) is 0 or appName is in allowedApps then
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
              if appArrangedCount > 0 then set appCount to appCount + 1
            end if
          end if
        end repeat

        return (arrangedCount as text) & "|" & (appCount as text) & "|" & (columnsCount as text) & "x" & (rowsCount as text)
      end tell
    `;
    const output = await run("osascript", ["-e", script]);
    const [windowsArranged, appsAffected, layout] = output.split("|");
    return {
      windowsArranged: Number(windowsArranged) || 0,
      appsAffected: Number(appsAffected) || 0,
      layout,
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
        set skippedApps to {"Electron", "HER", "Her Voice Agent", "System Settings"}
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
                if (count of windows of proc) > 0 then set frontWindowName to name of window 1 of proc
                exit repeat
              end if
            end try
          end repeat
        end if

        repeat with proc in (application processes whose visible is true)
          set appName to name of proc
          if appName is not in skippedApps then
            if (count of allowedApps) is 0 or appName is in allowedApps then
              set appMinimizedCount to 0
              tell proc
                repeat with targetWindow in windows
                  try
                    if subrole of targetWindow is "AXStandardWindow" then
                      set winName to name of targetWindow as text
                      set shouldKeep to false
                      if appName is in keepApps then set shouldKeep to true
                      if (${preserveFrontmost ? "true" : "false"}) and appName is frontAppName and winName is frontWindowName then set shouldKeep to true
                      repeat with keyword in keepKeywords
                        ignoring case
                          if winName contains (keyword as text) then set shouldKeep to true
                        end ignoring case
                      end repeat

                      if shouldKeep then
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
              if appMinimizedCount > 0 then set appCount to appCount + 1
            end if
          end if
        end repeat

        return (minimizedCount as text) & "|" & (preservedCount as text) & "|" & (appCount as text) & "|" & frontAppName & "|" & frontWindowName
      end tell
    `;
    const output = await run("osascript", ["-e", script]);
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
    await run("osascript", ["-e", `set volume output volume ${Math.round(level)}`]);
    return { volume: Math.round(level) };
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
      displays: "x-apple.systempreferences:com.apple.Displays-Settings.extension",
      sound: "x-apple.systempreferences:com.apple.Sound-Settings.extension",
      bluetooth: "x-apple.systempreferences:com.apple.BluetoothSettings",
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
}

const windowActionScript = (appName: string, action: string) => `
  tell application ${JSON.stringify(appName)} to activate
  delay 0.2

  tell application "System Events"
    if not (exists process ${JSON.stringify(appName)}) then error "App process is not available: ${escapeAppleScriptString(appName)}"

    tell process ${JSON.stringify(appName)}
      repeat 10 times
        if (count of windows) > 0 then exit repeat
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
