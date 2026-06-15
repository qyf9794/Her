import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { LocalServer } from "../../src/main/server";

let server: LocalServer;
let userDataDir: string;
let allowedDir: string;

beforeAll(async () => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "her-api-userdata-"));
  allowedDir = fs.mkdtempSync(path.join(os.tmpdir(), "her-api-allowed-"));
  process.env.HER_ALLOWED_DIRECTORIES = allowedDir;
  vi.resetModules();
  const { startLocalServer } = await import("../../src/main/server");
  server = await startLocalServer(0, userDataDir, false);
});

afterAll(async () => {
  await server?.close();
  fs.rmSync(userDataDir, { recursive: true, force: true });
  fs.rmSync(allowedDir, { recursive: true, force: true });
  delete process.env.HER_ALLOWED_DIRECTORIES;
});

describe("local API auth and confirmation flow", () => {
  it("rejects missing and invalid auth tokens", async () => {
    expect((await apiFetch("/api/tools/execute", {}, null)).status).toBe(401);
    expect((await apiFetch("/api/tools/execute", {}, "bad-token")).status).toBe(401);
    expect((await apiGetJson("/api/context/snapshot", null)).status).toBe(401);
    expect((await apiGetJson("/api/artifacts", null)).status).toBe(401);
  });

  it("rejects arbitrary web origins even with a valid local API token", async () => {
    const response = await apiFetch("/api/tools/execute", {}, server.localApiToken, {
      Origin: "https://evil.example",
      "Sec-Fetch-Site": "cross-site",
    });
    expect(response.status).toBe(403);

    const preflight = await fetch(`http://127.0.0.1:${server.port}/api/tools/execute`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://evil.example",
        "Access-Control-Request-Method": "POST",
      },
    });
    expect(preflight.status).toBe(403);
  });

  it("returns an auth-gated compact desktop context snapshot", async () => {
    fs.writeFileSync(path.join(allowedDir, "recent-context.txt"), "full file content should not appear in context snapshot");
    const response = await apiGetJson("/api/context/snapshot");
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      capturedAt: expect.any(String),
      frontmost: expect.objectContaining({ status: expect.any(String) }),
      clipboard: expect.objectContaining({ status: expect.any(String), chars: expect.any(Number) }),
      selection: expect.objectContaining({ status: "unsupported" }),
      routingMetadata: expect.objectContaining({ recentFiles: expect.any(Array) }),
      failures: expect.any(Array),
    });
    expect(JSON.stringify(response.body)).not.toContain("full file content should not appear");
  });

  it("creates a table artifact for file search results", async () => {
    fs.writeFileSync(path.join(allowedDir, "artifact-search-target.txt"), "artifact table payload");
    const search = await apiJson("/api/tools/execute", {
      name: "file_search",
      source: "local",
      arguments: { root: allowedDir, query: "artifact-search", maxDepth: 1, limit: 5 },
    });
    expect(search.body.ok).toBe(true);

    const artifacts = await apiGetJson("/api/artifacts?limit=5");
    expect(artifacts.body.artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "table",
        title: "File Search Results",
        sourceTool: "file_search",
        createdAt: expect.any(String),
      }),
    ]));
  });

  it("returns invalid_arguments for malformed tool args", async () => {
    const response = await apiJson("/api/tools/execute", {
      name: "system_set_volume",
      source: "local",
      arguments: { level: 200 },
    });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ok: false, code: "invalid_arguments" });
  });

  it("denies execution when a required capability is disabled", async () => {
    await apiJson("/api/settings/capabilities", { fileManagement: false });
    const response = await apiJson("/api/tools/execute", {
      name: "file_list",
      source: "local",
      arguments: { path: allowedDir, includeHidden: false },
    });
    expect(response.body).toMatchObject({ ok: false, code: "capability_denied" });
    await apiJson("/api/settings/capabilities", { fileManagement: true });
  });

  it("requires confirmation for high-risk tools and rejects without side effects", async () => {
    const folderName = "reject-me";
    const execute = await apiJson("/api/tools/execute", {
      name: "file_create_folder",
      source: "local",
      arguments: { parentPath: allowedDir, folderName },
    });
    expect(execute.body).toMatchObject({
      ok: true,
      requiresConfirmation: true,
      risk: "local_write",
      riskLabel: "Local write",
      target: `parentPath: ${allowedDir}`,
      reversible: true,
    });

    const confirmationId = execute.body.confirmationId;
    const pending = await apiGetJson("/api/tools/pending");
    expect(pending.body).toEqual(expect.arrayContaining([
      expect.objectContaining({
        confirmationId,
        risk: "local_write",
        riskLabel: "Local write",
        target: `parentPath: ${allowedDir}`,
        policyRationale: expect.arrayContaining(["The user must approve the exact local target before the write executes."]),
        expiresAt: expect.any(String),
      }),
    ]));
    const rejected = await apiJson("/api/tools/confirm", { confirmationId, approved: false });
    expect(rejected.body).toMatchObject({ ok: true, result: { rejected: true } });
    expect(fs.existsSync(path.join(allowedDir, folderName))).toBe(false);
  });

  it("executes confirmed high-risk tools", async () => {
    const folderName = "approve-me";
    const execute = await apiJson("/api/tools/execute", {
      name: "file_create_folder",
      source: "local",
      arguments: { parentPath: allowedDir, folderName },
    });
    expect(execute.body.requiresConfirmation).toBe(true);

    const approved = await apiJson("/api/tools/confirm", { confirmationId: execute.body.confirmationId, approved: true });
    expect(approved.body.ok).toBe(true);
    expect(fs.existsSync(path.join(allowedDir, folderName))).toBe(true);
  });

  it("validates alias targets before creating confirmation requests", async () => {
    const unknown = await apiJson("/api/tools/execute", {
      name: "alias_create",
      source: "local",
      arguments: { phrase: "bad", toolName: "missing_tool", arguments: {} },
    });
    expect(unknown.body).toMatchObject({ ok: false, code: "alias_target_unknown_tool" });

    const invalidArgs = await apiJson("/api/tools/execute", {
      name: "alias_create",
      source: "local",
      arguments: { phrase: "bad args", toolName: "system_set_volume", arguments: { level: 200 } },
    });
    expect(invalidArgs.body).toMatchObject({ ok: false, code: "alias_target_invalid_arguments" });

    const secret = await apiJson("/api/tools/execute", {
      name: "alias_create",
      source: "local",
      arguments: { phrase: "secret", toolName: "app_open", arguments: { appName: "Chrome", nested: { password: "secret" } } },
    });
    expect(secret.body).toMatchObject({ ok: false, code: "secret_like_key_rejected" });
  });

  it("creates, lists, and deletes aliases through confirmation", async () => {
    const create = await apiJson("/api/tools/execute", {
      name: "alias_create",
      source: "local",
      arguments: { phrase: "Open Smoke Browser", toolName: "app_open", arguments: { appName: "Google Chrome" } },
    });
    expect(create.body).toMatchObject({ ok: true, requiresConfirmation: true });
    await apiJson("/api/tools/confirm", { confirmationId: create.body.confirmationId, approved: true });

    const list = await apiJson("/api/tools/execute", {
      name: "alias_list",
      source: "local",
      arguments: { query: "smoke browser" },
    });
    expect(list.body.ok).toBe(true);
    expect(list.body.result.aliases).toHaveLength(1);
    expect(list.body.result.aliases[0]).toMatchObject({ phrase: "Open Smoke Browser", target: { toolName: "app_open" } });

    const duplicate = await apiJson("/api/tools/execute", {
      name: "alias_create",
      source: "local",
      arguments: { phrase: " open smoke browser ", toolName: "app_open", arguments: { appName: "Safari" } },
    });
    expect(duplicate.body).toMatchObject({ ok: false, code: "alias_duplicate" });

    const deleteAlias = await apiJson("/api/tools/execute", {
      name: "alias_delete",
      source: "local",
      arguments: { phrase: "open smoke browser" },
    });
    expect(deleteAlias.body).toMatchObject({ ok: true, requiresConfirmation: true });
    await apiJson("/api/tools/confirm", { confirmationId: deleteAlias.body.confirmationId, approved: true });

    const afterDelete = await apiJson("/api/tools/execute", {
      name: "alias_list",
      source: "local",
      arguments: { query: "smoke browser" },
    });
    expect(afterDelete.body.result.aliases).toHaveLength(0);
  });

  it("previews, saves, runs, and deletes skills through policy gates", async () => {
    const skillInput = {
      name: "Meeting Prep Smoke",
      trigger: "准备开会 smoke",
      parameters: [{ name: "folder", required: true }],
      steps: [
        {
          toolName: "file_create_folder",
          arguments: { parentPath: allowedDir, folderName: "{{folder}}" },
          title: "Create meeting folder",
        },
      ],
    };

    const preview = await apiJson("/api/tools/execute", {
      name: "skill_preview",
      source: "local",
      arguments: skillInput,
    });
    expect(preview.body.ok).toBe(true);
    expect(preview.body.result).toMatchObject({
      trigger: "准备开会 smoke",
      requiredCapabilities: expect.arrayContaining(["fileManagement"]),
      risks: expect.arrayContaining(["local_write"]),
      requiresConfirmation: true,
    });

    const save = await apiJson("/api/tools/execute", {
      name: "skill_save",
      source: "local",
      arguments: skillInput,
    });
    expect(save.body).toMatchObject({
      ok: true,
      requiresConfirmation: true,
      risk: "local_write",
      preview: expect.objectContaining({ trigger: "准备开会 smoke" }),
    });
    await apiJson("/api/tools/confirm", { confirmationId: save.body.confirmationId, approved: true });

    const list = await apiJson("/api/tools/execute", {
      name: "skill_list",
      source: "local",
      arguments: { query: "meeting" },
    });
    expect(list.body.result.skills).toHaveLength(1);
    const skillId = list.body.result.skills[0].id;

    const inspect = await apiJson("/api/tools/execute", {
      name: "skill_inspect",
      source: "local",
      arguments: { skillId },
    });
    expect(inspect.body.result.skill).toMatchObject({ id: skillId, trigger: "准备开会 smoke" });

    const run = await apiJson("/api/tools/execute", {
      name: "skill_run",
      source: "local",
      arguments: { skillId, parameters: { folder: "skill-created" } },
    });
    expect(run.body.ok).toBe(true);
    expect(run.body.result).toMatchObject({ status: "awaiting_confirmation" });
    expect(run.body.result.results[0].result).toMatchObject({
      requiresConfirmation: true,
      risk: "local_write",
    });
    expect(fs.existsSync(path.join(allowedDir, "skill-created"))).toBe(false);

    const status = await apiJson("/api/tools/execute", {
      name: "memory_status",
      source: "local",
      arguments: {},
    });
    expect(status.body.result).toMatchObject({
      aliases: expect.objectContaining({ total: expect.any(Number) }),
      skills: { total: 1 },
      counts: expect.any(Object),
    });

    const deleteSkill = await apiJson("/api/tools/execute", {
      name: "skill_delete",
      source: "local",
      arguments: { skillId },
    });
    expect(deleteSkill.body).toMatchObject({ ok: true, requiresConfirmation: true, risk: "local_write" });
    await apiJson("/api/tools/confirm", { confirmationId: deleteSkill.body.confirmationId, approved: true });

    const afterDelete = await apiJson("/api/tools/execute", {
      name: "skill_list",
      source: "local",
      arguments: { query: "meeting" },
    });
    expect(afterDelete.body.result.skills).toHaveLength(0);
  });

  it("rejects secret-like skill and memory payloads", async () => {
    const secretSkill = await apiJson("/api/tools/execute", {
      name: "skill_save",
      source: "local",
      arguments: {
        name: "Secret Skill",
        trigger: "login smoke",
        steps: [{ toolName: "app_open", arguments: { appName: "Chrome", nested: { password: "secret" } } }],
      },
    });
    expect(secretSkill.body).toMatchObject({ ok: false, code: "secret_like_key_rejected" });

    const secretMemory = await apiJson("/api/tools/execute", {
      name: "memory_save",
      source: "local",
      arguments: { type: "preference", key: "OPENAI_API_KEY", value: "sk-secret" },
    });
    expect(secretMemory.body).toMatchObject({ ok: false, error: expect.stringContaining("Secret-like") });
  });

  it("previews built-in workflow packs with scenario metadata", async () => {
    const list = await apiJson("/api/tools/execute", {
      name: "workflow_pack_list",
      source: "local",
      arguments: {},
    });
    expect(list.body.result.packs.map((pack: { id: string }) => pack.id)).toEqual(expect.arrayContaining([
      "focus_writing",
      "meeting_prep",
      "research_desk",
      "coding_session",
      "file_cleanup",
    ]));

    const expectedSteps: Record<string, string[]> = {
      focus_writing: ["file_search", "mac_note_create", "window_minimize_unrelated"],
      meeting_prep: ["calendar_search", "app_open", "mac_note_create"],
      research_desk: ["browser_search_open", "document_folder_digest"],
      coding_session: ["file_search", "coding_agent_start"],
      file_cleanup: ["file_search", "file_trash"],
    };

    for (const [packId, tools] of Object.entries(expectedSteps)) {
      const preview = await apiJson("/api/tools/execute", {
        name: "workflow_pack_preview",
        source: "local",
        arguments: { packId, parameters: { root: allowedDir, repoPath: allowedDir } },
      });
      expect(preview.body.ok).toBe(true);
      expect(preview.body.result.preview).toMatchObject({
        id: packId,
        requiredCapabilities: expect.any(Array),
        risks: expect.any(Array),
        rollbackNotes: expect.any(Array),
      });
      expect(preview.body.result.preview.steps.map((step: { toolName: string }) => step.toolName)).toEqual(expect.arrayContaining(tools));
    }
  });

  it("runs and cancels File Cleanup without trashing before confirmation", async () => {
    const targetPath = path.join(allowedDir, "cleanup-target.tmp");
    fs.writeFileSync(targetPath, "keep until confirmed");

    const run = await apiJson("/api/tools/execute", {
      name: "workflow_pack_run",
      source: "local",
      arguments: { packId: "file_cleanup", parameters: { root: allowedDir, query: "cleanup-target", targetPath } },
    });
    expect(run.body.ok).toBe(true);
    expect(run.body.result.run.status).toBe("awaiting_confirmation");
    expect(run.body.result.run.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ toolName: "file_trash", status: "awaiting_confirmation", confirmationId: expect.any(String) }),
    ]));
    expect(fs.existsSync(targetPath)).toBe(true);

    const runId = run.body.result.run.id;
    const cancel = await apiJson("/api/tools/execute", {
      name: "workflow_run_cancel",
      source: "local",
      arguments: { runId },
    });
    expect(cancel.body.result).toMatchObject({ cancelled: true, run: expect.objectContaining({ status: "cancelled" }) });
    expect(cancel.body.result.run.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ toolName: "file_trash", status: "cancelled" }),
    ]));
    expect(fs.existsSync(targetPath)).toBe(true);

    const pending = await apiGetJson("/api/tools/pending");
    expect(pending.body.some((item: { confirmationId: string }) => item.confirmationId === run.body.result.run.steps[1].confirmationId)).toBe(false);
  });

  it("shows partial workflow failure and skipped remaining steps", async () => {
    const run = await apiJson("/api/tools/execute", {
      name: "workflow_pack_run",
      source: "local",
      arguments: {
        packId: "file_cleanup",
        parameters: { root: "/not-allowlisted", query: "missing", targetPath: path.join(allowedDir, "never-trash.tmp") },
      },
    });
    expect(run.body.ok).toBe(true);
    expect(run.body.result.run).toMatchObject({
      status: "failed",
      steps: [
        expect.objectContaining({ toolName: "file_search", status: "failed" }),
        expect.objectContaining({ toolName: "file_trash", status: "skipped" }),
      ],
    });
    expect(run.body.result.run.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "workflow_step_failed" }),
      expect.objectContaining({ type: "workflow_step_skipped" }),
    ]));
  });
});

const apiFetch = (
  apiPath: string,
  body: unknown,
  token: string | null = server.localApiToken,
  headers: Record<string, string> = {},
) =>
  fetch(`http://127.0.0.1:${server.port}${apiPath}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });

const apiJson = async (apiPath: string, body: unknown) => {
  const response = await apiFetch(apiPath, body);
  return { status: response.status, body: await response.json() };
};

const apiGetJson = async (apiPath: string, token: string | null = server.localApiToken) => {
  const response = await fetch(`http://127.0.0.1:${server.port}${apiPath}`, {
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  return { status: response.status, body: await response.json() };
};
