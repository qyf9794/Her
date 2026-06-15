import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuditLog } from "../../src/main/audit";
import { selectToolBundles } from "../../src/main/agent/tool-bundle-router";
import { ConfirmationQueue } from "../../src/main/tools/confirmation";
import { ToolRegistry } from "../../src/main/tools/registry";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("simple command execution", () => {
  it("routes and executes low-risk simple commands through the real registry", async () => {
    const registry = createRegistry();

    expect(selectToolBundles("查看系统状态").bundles).toContain("core");
    const status = await registry.execute({ name: "system_status", arguments: {}, source: "local" });
    expect(status).toMatchObject({ ok: true, name: "system_status" });
    expect(status.ok && status.result).toMatchObject({ adapters: expect.any(Object), toolGroups: expect.any(Array) });

    expect(selectToolBundles("列出我的快捷指令").bundles).toContain("core");
    const aliases = await registry.execute({ name: "alias_list", arguments: {}, source: "local" });
    expect(aliases).toMatchObject({ ok: true, name: "alias_list", result: { aliases: [] } });

    expect(selectToolBundles("查一下我下周有哪些会议").bundles).toContain("comms");
    const calendar = await registry.execute({
      name: "calendar_search",
      arguments: { from: "2026-06-15T00:00:00.000Z", to: "2026-06-22T00:00:00.000Z", query: "会议", limit: 10 },
      source: "local",
    });
    expect(calendar).toMatchObject({ ok: true, name: "calendar_search" });
  });

  it("does not directly execute high-risk simple commands before confirmation", async () => {
    const confirmations = new ConfirmationQueue();
    const registry = createRegistry(confirmations);

    const cancel = await registry.execute({ name: "task_cancel", arguments: { taskId: "last_task" }, source: "local" });
    expect(cancel).toMatchObject({ ok: false, name: "task_cancel" });
    expect(confirmations.list()).toHaveLength(0);

    const draft = await registry.execute({
      name: "email_draft",
      arguments: { to: "律师", subject: "补充材料", body: "我会尽快补充材料" },
      source: "local",
    });
    expect(draft).toMatchObject({ ok: true, name: "email_draft", requiresConfirmation: true });
    expect(confirmations.list()).toHaveLength(1);
  });
});

const createRegistry = (confirmations = new ConfirmationQueue()) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "her-simple-command-test-"));
  tmpDirs.push(dir);
  const registry = new ToolRegistry(confirmations, new AuditLog());
  return registry;
};
