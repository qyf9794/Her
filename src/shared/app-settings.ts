export type CapabilityKey = "fileManagement" | "browserAutomation" | "textOperations" | "systemOperations";

export type CapabilitySettings = Record<CapabilityKey, boolean>;

export type AppRisk = "low" | "medium" | "high";

export type AppCapability =
  | "open"
  | "quit"
  | "focus"
  | "window"
  | "text"
  | "browser"
  | "scriptable"
  | "system"
  | "music";

export type InstalledApp = {
  name: string;
  path: string;
  bundleId: string;
  executable: string;
  iconUrl: string;
  scriptable: boolean;
  risk: AppRisk;
  capabilities: AppCapability[];
  recommended: boolean;
  authorized: boolean;
};

export type AppPermission = {
  bundleId: string;
  authorized: boolean;
};

export type UserSettings = {
  yoloMode: boolean;
  yoloExpiresAt?: string;
  capabilities: CapabilitySettings;
  appPermissions: Record<string, boolean>;
  hasCompletedOnboarding: boolean;
  updatedAt: string;
};

export const defaultCapabilities: CapabilitySettings = {
  fileManagement: true,
  browserAutomation: true,
  textOperations: true,
  systemOperations: false,
};
