export type ContextAvailability = "available" | "empty" | "redacted" | "unsupported" | "unavailable";

export type TextContextSummary = {
  status: ContextAvailability;
  chars: number;
  preview?: string;
  redacted?: boolean;
  reason?: string;
};

export type DesktopContextSnapshot = {
  capturedAt: string;
  frontmost: {
    status: ContextAvailability;
    appName?: string;
    windowTitle?: string;
    reason?: string;
  };
  selection: TextContextSummary;
  clipboard: TextContextSummary & {
    contentType: "text" | "empty" | "unknown";
  };
  recentFiles: Array<{
    root: string;
    name: string;
    path: string;
    type: "file" | "folder";
    size: number;
    modifiedAt: string;
  }>;
  routingMetadata: DesktopContextRoutingMetadata;
  failures: Array<{
    source: "frontmost" | "selection" | "clipboard" | "recent_files";
    message: string;
  }>;
};

export type DesktopContextRoutingMetadata = {
  activeApp?: string;
  activeWindowTitle?: string;
  clipboard?: {
    status: ContextAvailability;
    chars: number;
    preview?: string;
  };
  selectedText?: {
    status: ContextAvailability;
    chars: number;
    preview?: string;
  };
  recentFiles: Array<{
    name: string;
    path: string;
    type: "file" | "folder";
    modifiedAt: string;
  }>;
};
