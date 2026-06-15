import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const originalCwd = process.cwd();
const originalEnv = { ...process.env };

afterEach(() => {
  process.chdir(originalCwd);
  process.env = { ...originalEnv };
  vi.resetModules();
});

describe("Apple Music config", () => {
  it("resolves local commands from explicit search directories", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "her-command-path-"));
    const binPath = path.join(tempDir, "fake-codex");
    fs.writeFileSync(binPath, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(binPath, 0o755);
    process.env.PATH = "";
    vi.resetModules();

    const { resolveCommandPath, resolveCodexCommand } = await import("../../src/main/config");
    expect(resolveCommandPath("fake-codex", [tempDir])).toBe(binPath);
    expect(resolveCodexCommand("/custom/codex")).toBe("/custom/codex");

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("saves MusicKit key metadata and private key path without reading key contents", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "her-apple-music-config-"));
    const keyPath = path.join(tempDir, "AuthKey_XZD9PPKW2J.p8");
    fs.writeFileSync(keyPath, "PRIVATE KEY CONTENT SHOULD NOT BE COPIED");
    process.chdir(tempDir);
    vi.resetModules();

    const { readAppleMusicConfig, saveAppleMusicConfig } = await import("../../src/main/config");
    const saved = saveAppleMusicConfig({
      keyName: "Her MusicKit Key",
      teamId: "ABCDE12345",
      keyId: "XZD9PPKW2J",
      privateKeyPath: keyPath,
    });

    expect(saved).toMatchObject({
      keyName: "Her MusicKit Key",
      teamId: "ABCDE12345",
      keyId: "XZD9PPKW2J",
      privateKeyPath: keyPath,
      configured: true,
    });
    expect(readAppleMusicConfig()).toMatchObject({ configured: true, keyId: "XZD9PPKW2J" });
    const envLocal = fs.readFileSync(path.join(tempDir, ".env.local"), "utf8");
    expect(envLocal).toContain("HER_APPLE_MUSIC_PRIVATE_KEY_PATH=");
    expect(envLocal).not.toContain("PRIVATE KEY CONTENT SHOULD NOT BE COPIED");

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("uses HER MusicKit metadata when legacy Apple env vars are empty", async () => {
    process.env.APPLE_TEAM_ID = "";
    process.env.APPLE_MUSICKIT_KEY_ID = "";
    process.env.HER_APPLE_MUSIC_TEAM_ID = "ABCDE12345";
    process.env.HER_APPLE_MUSIC_KEY_ID = "XZD9PPKW2J";
    vi.resetModules();

    const { config } = await import("../../src/main/config");
    expect(config.appleMusicTeamId).toBe("ABCDE12345");
    expect(config.appleMusicKeyId).toBe("XZD9PPKW2J");
  });

  it("rejects invalid MusicKit key metadata", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "her-apple-music-config-invalid-"));
    process.chdir(tempDir);
    vi.resetModules();

    const { saveAppleMusicConfig } = await import("../../src/main/config");
    expect(() =>
      saveAppleMusicConfig({
        teamId: "bad",
        keyId: "XZD9PPKW2J",
        privateKeyPath: "relative/AuthKey.p8",
      }),
    ).toThrow("Apple Team ID");

    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});
