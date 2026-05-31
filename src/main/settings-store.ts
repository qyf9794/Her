import fs from "node:fs";
import path from "node:path";
import { defaultCapabilities, type CapabilitySettings, type UserSettings } from "../shared/app-settings";

export class SettingsStore {
  private settingsPath: string;

  constructor(userDataDir: string) {
    this.settingsPath = path.join(userDataDir, "settings.json");
  }

  read(): UserSettings {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.settingsPath, "utf8")) as Partial<UserSettings>;
      return {
        yoloMode: Boolean(parsed.yoloMode),
        capabilities: { ...defaultCapabilities, ...(parsed.capabilities ?? {}) },
        appPermissions: parsed.appPermissions ?? {},
        hasCompletedOnboarding: Boolean(parsed.hasCompletedOnboarding),
        updatedAt: parsed.updatedAt ?? new Date().toISOString(),
      };
    } catch {
      return {
        yoloMode: false,
        capabilities: defaultCapabilities,
        appPermissions: {},
        hasCompletedOnboarding: false,
        updatedAt: new Date().toISOString(),
      };
    }
  }

  write(next: UserSettings) {
    fs.mkdirSync(path.dirname(this.settingsPath), { recursive: true });
    fs.writeFileSync(this.settingsPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    return next;
  }

  setCapabilities(capabilities: Partial<CapabilitySettings>) {
    const current = this.read();
    return this.write({
      ...current,
      capabilities: { ...current.capabilities, ...capabilities },
      updatedAt: new Date().toISOString(),
    });
  }

  setAppPermissions(appPermissions: Record<string, boolean>) {
    const current = this.read();
    return this.write({
      ...current,
      appPermissions: { ...current.appPermissions, ...appPermissions },
      hasCompletedOnboarding: true,
      updatedAt: new Date().toISOString(),
    });
  }

  setYoloMode(enabled: boolean, appPermissions: Record<string, boolean> = {}) {
    const current = this.read();
    return this.write({
      ...current,
      yoloMode: enabled,
      capabilities: enabled ? allCapabilitiesEnabled() : current.capabilities,
      appPermissions: enabled ? { ...current.appPermissions, ...appPermissions } : current.appPermissions,
      hasCompletedOnboarding: enabled ? true : current.hasCompletedOnboarding,
      updatedAt: new Date().toISOString(),
    });
  }

  isAppAuthorized(bundleId: string, recommendedDefault: boolean) {
    const settings = this.read();
    if (settings.yoloMode) return true;
    return settings.appPermissions[bundleId] ?? recommendedDefault;
  }
}

export const allCapabilitiesEnabled = (): CapabilitySettings =>
  Object.fromEntries(Object.keys(defaultCapabilities).map((key) => [key, true])) as CapabilitySettings;
