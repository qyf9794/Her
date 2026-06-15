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
});

const apiFetch = (apiPath: string, body: unknown, token: string | null = server.localApiToken) =>
  fetch(`http://127.0.0.1:${server.port}${apiPath}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
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
