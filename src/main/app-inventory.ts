import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { app as electronApp } from "electron";
import type { AppCapability, AppRisk, InstalledApp } from "../shared/app-settings";
import { SettingsStore } from "./settings-store";

const scanRoots = () => [
  "/Applications",
  path.join(os.homedir(), "Applications"),
  "/System/Applications",
  "/System/Applications/Utilities",
  "/System/Library/CoreServices",
];

const highRiskNames = new Set([
  "Activity Monitor",
  "Disk Utility",
  "Keychain Access",
  "MacKeeper",
  "Passwords",
  "Shadowrocket",
  "System Settings",
  "Tailscale",
  "Terminal",
  "Xcode",
]);

const recommendedNames = new Set([
  "Arc",
  "Calendar",
  "DingTalk",
  "Finder",
  "Google Chrome",
  "Keynote",
  "Mail",
  "Microsoft Edge",
  "Microsoft Excel",
  "Microsoft PowerPoint",
  "Microsoft Word",
  "Music",
  "Notes",
  "Notion",
  "Numbers",
  "Pages",
  "Preview",
  "Reminders",
  "Safari",
  "TencentMeeting",
  "TextEdit",
  "TV",
  "WeChat",
]);

const browserNames = new Set(["Arc", "Google Chrome", "Microsoft Edge", "Safari"]);
const textNames = new Set(["TextEdit", "Notes", "Microsoft Word", "Pages", "Notion"]);
const musicNames = new Set(["Music", "QQMusic", "NeteaseMusic", "KugouMusic", "LinMusic", "虾米音乐"]);

export class AppInventoryService {
  private cache: InstalledApp[] | null = null;
  private iconCache = new Map<string, string>();

  constructor(private settings: SettingsStore) {}

  async listApps(refresh = false) {
    if (!this.cache || refresh) {
      this.cache = this.scanApps();
    }

    return this.cache.map((item) => ({
      ...item,
      authorized: this.settings.isAppAuthorized(item.bundleId, item.recommended),
    }));
  }

  async iconForPath(appPath: string) {
    if (this.iconCache.has(appPath)) return this.iconCache.get(appPath)!;
    const dataUrl = this.readBundleIcon(appPath) ?? (await electronApp.getFileIcon(appPath, { size: "normal" })).toDataURL();
    this.iconCache.set(appPath, dataUrl);
    return dataUrl;
  }

  private scanApps() {
    const found = new Set<string>();
    for (const root of scanRoots()) this.walk(root, found);

    const apps = [...found]
      .map((appPath) => this.readApp(appPath))
      .filter(Boolean)
      .sort((a, b) => a!.name.localeCompare(b!.name, undefined, { sensitivity: "base" })) as InstalledApp[];

    return apps;
  }

  private walk(dir: string, found: Set<string>, depth = 0) {
    if (depth > 3) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && entry.name.endsWith(".app")) found.add(full);
      else if (entry.isDirectory()) this.walk(full, found, depth + 1);
    }
  }

  private readApp(appPath: string): InstalledApp | null {
    const plist = path.join(appPath, "Contents", "Info.plist");
    if (!fs.existsSync(plist)) return null;

    const name = path.basename(appPath, ".app");
    const bundleId = readPlist(plist, "CFBundleIdentifier") || name;
    const executable = readPlist(plist, "CFBundleExecutable") || name;
    const scriptable = isScriptable(plist);
    const risk = riskFor(name);
    const recommended = recommendedNames.has(name) && risk !== "high";

    return {
      name,
      path: appPath,
      bundleId,
      executable,
      iconUrl: `/api/apps/icon?path=${encodeURIComponent(appPath)}`,
      scriptable,
      risk,
      recommended,
      authorized: recommended,
      capabilities: capabilitiesFor(name, scriptable, risk),
    };
  }

  private readBundleIcon(appPath: string) {
    const plist = path.join(appPath, "Contents", "Info.plist");
    const iconFile = readPlist(plist, "CFBundleIconFile");
    if (!iconFile) return null;

    const candidates = iconFile.endsWith(".icns") ? [iconFile] : [`${iconFile}.icns`, iconFile];
    for (const candidate of candidates) {
      const iconPath = path.join(appPath, "Contents", "Resources", candidate);
      if (!fs.existsSync(iconPath)) continue;
      const dataUrl = convertIcnsToPngDataUrl(iconPath);
      if (dataUrl) return dataUrl;
    }

    return null;
  }
}

const readPlist = (plist: string, key: string) => {
  try {
    return execFileSync("plutil", ["-extract", key, "raw", "-o", "-", plist], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
};

const convertIcnsToPngDataUrl = (iconPath: string) => {
  const output = path.join(os.tmpdir(), `her-icon-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.png`);
  try {
    execFileSync("sips", ["-s", "format", "png", iconPath, "--out", output], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    const data = fs.readFileSync(output);
    return `data:image/png;base64,${data.toString("base64")}`;
  } catch {
    return null;
  } finally {
    try {
      fs.unlinkSync(output);
    } catch {
      // Best-effort cleanup only.
    }
  }
};

const isScriptable = (plist: string) => {
  const scriptable = readPlist(plist, "NSAppleScriptEnabled");
  const sdef = readPlist(plist, "OSAScriptingDefinition");
  return scriptable === "true" || scriptable === "1" || Boolean(sdef);
};

const riskFor = (name: string): AppRisk => {
  if (highRiskNames.has(name)) return "high";
  if (["System Information", "Console", "Activity Monitor", "Shortcuts"].includes(name)) return "medium";
  return "low";
};

const capabilitiesFor = (name: string, scriptable: boolean, risk: AppRisk): AppCapability[] => {
  const capabilities = new Set<AppCapability>(["open", "focus", "quit", "window"]);
  if (scriptable) capabilities.add("scriptable");
  if (browserNames.has(name) || name.includes("Chrome")) capabilities.add("browser");
  if (textNames.has(name)) capabilities.add("text");
  if (musicNames.has(name)) capabilities.add("music");
  if (risk !== "low") capabilities.add("system");
  return [...capabilities];
};
