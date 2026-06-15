import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import type { DesktopContextRoutingMetadata, DesktopContextSnapshot, TextContextSummary } from "../../shared/context";
import { config } from "../config";

type DesktopContextServiceOptions = {
  readClipboardText?: () => Promise<string> | string;
  runAppleScript?: (script: string) => Promise<string>;
  allowedDirectories?: string[];
};

const textPreviewLimit = 180;
const recentFileLimit = 12;
const recentFilesPerRoot = 8;

export class DesktopContextService {
  private readonly readClipboardText: () => Promise<string> | string;
  private readonly runAppleScript: (script: string) => Promise<string>;
  private readonly allowedDirectories: string[];

  constructor(options: DesktopContextServiceOptions = {}) {
    this.readClipboardText = options.readClipboardText ?? readElectronClipboardText;
    this.runAppleScript = options.runAppleScript ?? runAppleScript;
    this.allowedDirectories = options.allowedDirectories ?? config.allowedDirectories;
  }

  async snapshot(): Promise<DesktopContextSnapshot> {
    const failures: DesktopContextSnapshot["failures"] = [];
    const [frontmost, clipboard, recentFiles] = await Promise.all([
      this.readFrontmost().catch((error) => {
        failures.push({ source: "frontmost", message: errorMessage(error) });
        return { status: "unavailable" as const, reason: errorMessage(error) };
      }),
      this.readClipboard().catch((error) => {
        failures.push({ source: "clipboard", message: errorMessage(error) });
        return { status: "unavailable" as const, chars: 0, contentType: "unknown" as const, reason: errorMessage(error) };
      }),
      this.readRecentFiles().catch((error) => {
        failures.push({ source: "recent_files", message: errorMessage(error) });
        return [];
      }),
    ]);
    const selection: TextContextSummary = {
      status: "unsupported",
      chars: 0,
      reason: "Selection capture is disabled until HER has a safe platform-specific reader that does not mutate clipboard state.",
    };

    return {
      capturedAt: new Date().toISOString(),
      frontmost,
      selection,
      clipboard,
      recentFiles,
      routingMetadata: toRoutingMetadata(frontmost, selection, clipboard, recentFiles),
      failures,
    };
  }

  private async readFrontmost(): Promise<DesktopContextSnapshot["frontmost"]> {
    if (process.platform !== "darwin") {
      return { status: "unsupported", reason: "Frontmost app capture is currently implemented for macOS only." };
    }
    const output = await this.runAppleScript(`
      tell application "System Events"
        set frontAppProcess to first application process whose frontmost is true
        set frontAppName to name of frontAppProcess
        set frontWindowTitle to ""
        try
          if (count of windows of frontAppProcess) is greater than 0 then
            set frontWindowTitle to name of window 1 of frontAppProcess
          end if
        end try
        return frontAppName & linefeed & frontWindowTitle
      end tell
    `);
    const [appName = "", windowTitle = ""] = output.split(/\r?\n/);
    if (!appName.trim()) return { status: "unavailable", reason: "No frontmost application was reported." };
    return {
      status: "available",
      appName: appName.trim(),
      windowTitle: windowTitle.trim() || undefined,
    };
  }

  private async readClipboard(): Promise<DesktopContextSnapshot["clipboard"]> {
    const text = await this.readClipboardText();
    if (!text) return { status: "empty", chars: 0, contentType: "empty" };
    return {
      ...summarizeText(text),
      contentType: "text",
    };
  }

  private async readRecentFiles() {
    const byRoot = await Promise.all(this.allowedDirectories.map((root) => this.readRecentFilesForRoot(root)));
    return byRoot
      .flat()
      .sort((a, b) => Date.parse(b.modifiedAt) - Date.parse(a.modifiedAt))
      .slice(0, recentFileLimit);
  }

  private async readRecentFilesForRoot(root: string): Promise<DesktopContextSnapshot["recentFiles"]> {
    try {
      const entries = await fs.readdir(root, { withFileTypes: true });
      const visible = entries.filter((entry) => !entry.name.startsWith(".")).slice(0, 80);
      const files = await Promise.all(
        visible.map(async (entry) => {
          const fullPath = path.join(root, entry.name);
          const stat = await fs.stat(fullPath).catch(() => undefined);
          if (!stat) return undefined;
          return {
            root,
            name: entry.name,
            path: fullPath,
            type: entry.isDirectory() ? "folder" as const : "file" as const,
            size: stat.size,
            modifiedAt: stat.mtime.toISOString(),
          };
        }),
      );
      return files
        .filter((item): item is NonNullable<typeof item> => Boolean(item))
        .sort((a, b) => Date.parse(b.modifiedAt) - Date.parse(a.modifiedAt))
        .slice(0, recentFilesPerRoot);
    } catch {
      return [];
    }
  }
}

export const summarizeText = (text: string): TextContextSummary => {
  const trimmed = text.trim();
  if (!trimmed) return { status: "empty", chars: 0 };
  if (isSecretLikeText(trimmed)) {
    return {
      status: "redacted",
      chars: trimmed.length,
      redacted: true,
      preview: "[redacted secret-like content]",
      reason: "Clipboard or selection text matched secret-like patterns.",
    };
  }
  return {
    status: "available",
    chars: trimmed.length,
    preview: trimmed.replace(/\s+/g, " ").slice(0, textPreviewLimit),
  };
};

const toRoutingMetadata = (
  frontmost: DesktopContextSnapshot["frontmost"],
  selection: TextContextSummary,
  clipboard: DesktopContextSnapshot["clipboard"],
  recentFiles: DesktopContextSnapshot["recentFiles"],
): DesktopContextRoutingMetadata => ({
  activeApp: frontmost.status === "available" ? frontmost.appName : undefined,
  activeWindowTitle: frontmost.status === "available" ? frontmost.windowTitle : undefined,
  clipboard: {
    status: clipboard.status,
    chars: clipboard.chars,
    preview: clipboard.redacted ? undefined : clipboard.preview,
  },
  selectedText: {
    status: selection.status,
    chars: selection.chars,
    preview: selection.redacted ? undefined : selection.preview,
  },
  recentFiles: recentFiles.slice(0, 5).map((item) => ({
    name: item.name,
    path: item.path,
    type: item.type,
    modifiedAt: item.modifiedAt,
  })),
});

const isSecretLikeText = (text: string) =>
  /\bsk-[a-z0-9_-]{8,}\b/i.test(text) ||
  /\b(?:bearer|authorization)\s+[a-z0-9._-]{8,}\b/i.test(text) ||
  /\b(?:api[_-]?key|token|secret|password|passwd|credential)\b\s*[:=]\s*\S+/i.test(text) ||
  /\b(?:ghp|github_pat|xox[baprs])_[a-z0-9_:-]{8,}\b/i.test(text);

const readElectronClipboardText = async () => {
  try {
    const electron = await import("electron");
    const clipboard = "clipboard" in electron ? electron.clipboard : undefined;
    return clipboard?.readText() ?? "";
  } catch {
    return "";
  }
};

const runAppleScript = (script: string) =>
  new Promise<string>((resolve, reject) => {
    const child = execFile("osascript", ["-e", script], { timeout: 1200 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || error.message));
        return;
      }
      resolve(stdout.trim());
    });
    child.stdin?.end();
  });

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
