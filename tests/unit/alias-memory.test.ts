import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AliasResolver } from "../../src/main/memory/alias-resolver";
import { AliasStore } from "../../src/main/memory/alias-store";
import { normalizeAliasPhrase } from "../../src/main/memory/alias-normalize";
import { validateAliasTarget } from "../../src/main/memory/alias-validation";
import { SkillStore, resolveSkillArguments } from "../../src/main/memory/skill-store";
import { toolRequiresConfirmation } from "../../src/main/tools/manifest";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("AliasStore", () => {
  it("normalizes phrases for exact matching", () => {
    expect(normalizeAliasPhrase(" 打开  VPN ")).toBe("打开vpn");
    expect(normalizeAliasPhrase("打开vpn")).toBe("打开vpn");
    expect(normalizeAliasPhrase("Open VPN")).toBe("openvpn");
  });

  it("creates, lists, persists, and deletes aliases under userData", () => {
    const userData = makeTmpDir();
    const store = new AliasStore(userData);
    const alias = store.create({
      phrase: "打开 VPN",
      target: { toolName: "app_open", arguments: { appName: "Shadowrocket" } },
      description: "Open VPN app",
    });

    expect(alias.normalizedPhrase).toBe("打开vpn");
    expect(store.list()).toHaveLength(1);
    expect(store.getByPhrase(" 打开 vpn ")).toMatchObject({ id: alias.id });
    expect(fs.existsSync(path.join(userData, "aliases.json"))).toBe(true);

    const reloaded = new AliasStore(userData);
    expect(reloaded.getByPhrase("打开VPN")).toMatchObject({ id: alias.id });

    const deleted = reloaded.delete({ phrase: "打开 vpn" });
    expect(deleted.id).toBe(alias.id);
    expect(reloaded.list()).toHaveLength(0);
  });

  it("rejects duplicate normalized phrases unless overwrite is explicit", () => {
    const store = new AliasStore(makeTmpDir());
    store.create({ phrase: "打开 VPN", target: { toolName: "app_open", arguments: { appName: "Shadowrocket" } } });

    expect(() => {
      store.create({ phrase: " 打开 vpn ", target: { toolName: "app_open", arguments: { appName: "Google Chrome" } } });
    }).toThrow("Alias already exists");

    const overwritten = store.create({
      phrase: " 打开 vpn ",
      target: { toolName: "app_open", arguments: { appName: "Google Chrome" } },
      overwrite: true,
    });
    expect(overwritten.target.arguments).toEqual({ appName: "Google Chrome" });
    expect(store.list()).toHaveLength(1);
  });

  it("handles corrupted JSON as safe empty state", () => {
    const userData = makeTmpDir();
    fs.writeFileSync(path.join(userData, "aliases.json"), "{not-json", "utf8");
    expect(new AliasStore(userData).list()).toEqual([]);
  });
});

describe("AliasResolver", () => {
  it("matches exact normalized phrases only", () => {
    const store = new AliasStore(makeTmpDir());
    const alias = store.create({ phrase: "打开 VPN", target: { toolName: "app_open", arguments: { appName: "Shadowrocket" } } });
    const resolver = new AliasResolver(store);

    expect(resolver.resolve(" 打开  vpn ")).toMatchObject({ matched: true, alias: { id: alias.id }, confidence: 1 });
    expect(resolver.resolve("请打开 vpn")).toMatchObject({ matched: false, reason: "no exact alias match" });
  });
});

describe("alias target validation", () => {
  it("validates target tool existence and target arguments", () => {
    expect(validateAliasTarget({ toolName: "app_open", arguments: { appName: "Google Chrome" } })).toEqual({
      toolName: "app_open",
      arguments: { appName: "Google Chrome" },
    });

    expect(() => validateAliasTarget({ toolName: "missing_tool", arguments: {} })).toThrow("Unknown alias target tool");
    expect(() => validateAliasTarget({ toolName: "system_set_volume", arguments: { level: 200 } })).toThrow("Too big");
  });

  it("rejects secret-like keys recursively", () => {
    expect(() => {
      validateAliasTarget({ toolName: "app_open", arguments: { appName: "Chrome", nested: { password: "secret" } } });
    }).toThrow("Secret-like alias argument key is not allowed");
  });

  it("rejects secret-like values recursively", () => {
    expect(() => {
      validateAliasTarget({ toolName: "app_open", arguments: { appName: "Chrome", nested: { value: "sk-123" } } });
    }).toThrow("Secret-like alias argument value is not allowed");
  });

  it("marks alias write tools as confirmation-required and list as read-only", () => {
    expect(toolRequiresConfirmation("alias_create")).toBe(true);
    expect(toolRequiresConfirmation("alias_delete")).toBe(true);
    expect(toolRequiresConfirmation("alias_list")).toBe(false);
  });
});

describe("SkillStore", () => {
  it("previews, persists, resolves parameters, and deletes skills", () => {
    const userData = makeTmpDir();
    const store = new SkillStore(userData);
    const input = {
      name: "Meeting Prep",
      trigger: "准备开会",
      parameters: [{ name: "folder", required: true }],
      steps: [
        { toolName: "file_create_folder", arguments: { parentPath: userData, folderName: "{{folder}}" } },
        { toolName: "app_open", arguments: { appName: "Calendar" } },
      ],
    };
    const preview = store.preview(input);
    expect(preview.requiredCapabilities).toContain("fileManagement");
    expect(preview.risks).toEqual(expect.arrayContaining(["local_write", "local_open"]));
    expect(preview.requiresConfirmation).toBe(true);

    const saved = store.save(input);
    expect(saved.skill.trigger).toBe("准备开会");
    expect(new SkillStore(userData).getByTrigger("准备开会")).toMatchObject({ id: saved.skill.id });
    expect(resolveSkillArguments(saved.skill.steps[0], { folder: "smoke" })).toEqual({ parentPath: userData, folderName: "smoke" });
    expect(store.delete({ trigger: "准备开会" }).skill.id).toBe(saved.skill.id);
    expect(store.list()).toHaveLength(0);
  });

  it("rejects secret-like skill definitions and parameter names", () => {
    const store = new SkillStore(makeTmpDir());
    expect(() => store.preview({
      name: "Secret",
      trigger: "login",
      steps: [{ toolName: "app_open", arguments: { appName: "Chrome", nested: { password: "secret" } } }],
    })).toThrow("Secret-like alias argument key is not allowed");
    expect(() => store.preview({
      name: "Secret Param",
      trigger: "login",
      parameters: [{ name: "apiKey" }],
      steps: [{ toolName: "app_open", arguments: { appName: "Chrome" } }],
    })).toThrow("Secret-like alias argument key is not allowed");
  });

  it("marks skill save/delete as confirmation-required while preview/list/inspect/run stay policy-routed", () => {
    expect(toolRequiresConfirmation("skill_save")).toBe(true);
    expect(toolRequiresConfirmation("skill_delete")).toBe(true);
    expect(toolRequiresConfirmation("skill_preview")).toBe(false);
    expect(toolRequiresConfirmation("skill_run")).toBe(false);
  });
});

const makeTmpDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "her-alias-test-"));
  tmpDirs.push(dir);
  return dir;
};
