import express from "express";
import type { Server } from "node:http";
import crypto from "node:crypto";
import { createRealtimeClientSecret } from "./realtime";
import { readCodexModel, readOpenaiApiKey, readRealtimeVoice, saveCodexModel, saveOpenaiApiKey, saveRealtimeVoice } from "./config";
import { readCodexDeviceAuth, readCodexLoginStatus, startCodexDeviceAuth } from "./codex-login";
import { AuditLog } from "./audit";
import { AppInventoryService } from "./app-inventory";
import { CapabilityGate } from "./capability-gate";
import { SettingsStore } from "./settings-store";
import { MemoryStore } from "./memory-store";
import { ConfirmationQueue } from "./tools/confirmation";
import { ToolRegistry } from "./tools/registry";
import { SystemControl } from "./tools/system-control";
import type { CapabilitySettings } from "../shared/app-settings";
import type { AuditEvent } from "../shared/events";
import { realtimeVoiceOptions } from "../shared/realtime-config";
import type { ConfirmationDecision, ToolCallRequest } from "../shared/tools";

export type LocalServer = {
  port: number;
  close: () => Promise<void>;
};

export const startLocalServer = async (port: number, userDataDir: string): Promise<LocalServer> => {
  const app = express();
  const audit = new AuditLog();
  const confirmations = new ConfirmationQueue();
  const settings = new SettingsStore(userDataDir);
  const memory = new MemoryStore(userDataDir);
  const inventory = new AppInventoryService(settings);
  const gate = new CapabilityGate(settings, () => inventory.listApps());
  const system = new SystemControl();
  const tools = new ToolRegistry(confirmations, audit, gate, {
    listApps: (refresh = false) => inventory.listApps(refresh),
    readSettings: () => settings.read(),
    setAppPermissions: (appPermissions) => settings.setAppPermissions(appPermissions),
    setCapabilities: (capabilities) => settings.setCapabilities(capabilities),
    setYoloMode: (enabled, appPermissions) => settings.setYoloMode(enabled, appPermissions),
  }, memory);

  const safetyIdentifier = crypto.createHash("sha256").update(`her:${userDataDir}`).digest("hex");
  const trustedOrigins = new Set(["http://127.0.0.1:5174", "http://localhost:5174", "file://", "null"]);

  app.use(express.json({ limit: "1mb" }));
  app.use((_req, res, next) => {
    const origin = _req.headers.origin;
    if (!origin || trustedOrigins.has(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin ?? "null");
    }
    res.setHeader("Access-Control-Allow-Headers", "content-type");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    next();
  });
  app.options("*", (_req, res) => res.sendStatus(204));

  app.use("/api", (req, res, next) => {
    const origin = req.headers.origin;
    if (origin && !trustedOrigins.has(origin)) {
      res.status(403).json({ error: "Untrusted local API origin." });
      return;
    }
    next();
  });

  app.get("/health", (_req, res) => {
    res.json({ ok: true, service: "her-local-agent" });
  });

  app.get("/api/settings", (_req, res) => {
    res.json(settings.read());
  });

  app.post("/api/settings/capabilities", (req, res) => {
    res.json(settings.setCapabilities(req.body as Partial<CapabilitySettings>));
  });

  app.post("/api/settings/yolo", async (req, res) => {
    const body = req.body as { enabled?: boolean };
    const enabled = Boolean(body.enabled);
    const appPermissions = enabled
      ? Object.fromEntries((await inventory.listApps()).map((item) => [item.bundleId, true]))
      : {};
    res.json(settings.setYoloMode(enabled, appPermissions));
  });

  app.get("/api/apps", async (req, res) => {
    const refresh = req.query.refresh === "true";
    res.json(await inventory.listApps(refresh));
  });

  app.get("/api/apps/icon", async (req, res) => {
    const appPath = typeof req.query.path === "string" ? req.query.path : "";
    if (!appPath) {
      res.status(400).send("Missing app path.");
      return;
    }

    try {
      const icon = await inventory.iconForPath(appPath);
      const match = /^data:(.+);base64,(.+)$/.exec(icon);
      if (!match) {
        res.type("text/plain").send(icon);
        return;
      }
      res.type(match[1]).send(Buffer.from(match[2], "base64"));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(404).send(message);
    }
  });

  app.post("/api/apps/permissions", (req, res) => {
    const body = req.body as { appPermissions?: Record<string, boolean> };
    res.json(settings.setAppPermissions(body.appPermissions ?? {}));
  });

  app.post("/api/system/settings", async (req, res) => {
    const body = req.body as { pane?: string };
    try {
      res.json(await system.openSettings(body.pane));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(400).json({ error: message });
    }
  });

  app.get("/api/openai-key", (_req, res) => {
    res.json({ configured: Boolean(readOpenaiApiKey()) });
  });

  app.post("/api/openai-key", (req, res) => {
    const body = req.body as { apiKey?: unknown };
    if (typeof body.apiKey !== "string") {
      res.status(400).json({ error: "Missing OpenAI API key." });
      return;
    }

    try {
      saveOpenaiApiKey(body.apiKey);
      res.json({ configured: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(400).json({ error: message });
    }
  });

  app.get("/api/codex-login/status", async (_req, res) => {
    try {
      res.json(await readCodexLoginStatus());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({
        configured: false,
        label: "Error",
        detail: message,
        command: "codex login status",
        checkedAt: new Date().toISOString(),
      });
    }
  });

  app.get("/api/codex-login/device-auth", (_req, res) => {
    res.json(readCodexDeviceAuth());
  });

  app.post("/api/codex-login/device-auth", (_req, res) => {
    try {
      const result = startCodexDeviceAuth();
      audit.write({
        action: "codex.login",
        summary: "Started Codex device auth",
        status: "started",
        details: { command: result.command, startedAt: result.startedAt },
      });
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      audit.write({
        action: "codex.login",
        summary: message,
        status: "error",
      });
      res.status(500).json({ running: false, output: message, command: "codex login --device-auth" });
    }
  });

  app.get("/api/codex/model", (_req, res) => {
    res.json({
      model: readCodexModel(),
      options: codexModelOptions,
      note: "Empty model uses the Codex app-server default.",
    });
  });

  app.post("/api/codex/model", (req, res) => {
    const body = req.body as { model?: unknown };
    if (typeof body.model !== "string") {
      res.status(400).json({ error: "Missing Codex model." });
      return;
    }

    try {
      const model = saveCodexModel(body.model);
      audit.write({
        action: "codex.model",
        summary: model ? `Set Codex model to ${model}` : "Use Codex app-server default model",
        status: "ok",
        details: { model: model || "[app-server-default]" },
      });
      res.json({ model, options: codexModelOptions });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(400).json({ error: message });
    }
  });

  app.get("/api/realtime/voice", (_req, res) => {
    res.json({
      voice: readRealtimeVoice(),
      options: realtimeVoiceOptions,
      note: "Voice changes apply when the next Realtime voice session starts.",
    });
  });

  app.post("/api/realtime/voice", (req, res) => {
    const body = req.body as { voice?: unknown };
    if (typeof body.voice !== "string") {
      res.status(400).json({ error: "Missing Realtime voice." });
      return;
    }

    try {
      const voice = saveRealtimeVoice(body.voice);
      audit.write({
        action: "realtime.voice",
        summary: `Set Realtime voice to ${voice}`,
        status: "ok",
        details: { voice },
      });
      res.json({
        voice,
        options: realtimeVoiceOptions,
        note: "Voice changes apply when the next Realtime voice session starts.",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(400).json({ error: message });
    }
  });

  app.post("/api/audit", (req, res) => {
    const body = req.body as Partial<Omit<AuditEvent, "id" | "timestamp">>;
    if (typeof body.action !== "string" || typeof body.summary !== "string" || !isAuditStatus(body.status)) {
      res.status(400).json({ error: "Invalid audit event." });
      return;
    }
    const entry = audit.write({
      action: body.action,
      summary: body.summary,
      status: body.status,
      details: body.details && typeof body.details === "object" ? (body.details as Record<string, unknown>) : undefined,
    });
    res.json({ ok: true, id: entry.id });
  });

  app.post("/api/realtime/client-secret", async (_req, res) => {
    audit.write({
      action: "realtime.client_secret",
      summary: "Creating Realtime client secret",
      status: "started",
    });
    try {
      const payload = await createRealtimeClientSecret(safetyIdentifier);
      audit.write({
        action: "realtime.client_secret",
        summary: "Realtime client secret created",
        status: "ok",
        details: payload.her as Record<string, unknown>,
      });
      res.json(payload);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      audit.write({
        action: "realtime.client_secret",
        summary: message,
        status: "error",
      });
      res.status(500).json({ error: message });
    }
  });

  app.post("/api/tools/execute", async (req, res) => {
    const body = req.body as ToolCallRequest;
    res.json(await tools.execute(body));
  });

  app.post("/api/tools/confirm", async (req, res) => {
    const body = req.body as ConfirmationDecision;
    audit.write({
      action: "confirmation.request",
      summary: `${body.approved ? "Approve" : "Reject"} confirmation ${body.confirmationId}`,
      status: "started",
      details: { confirmationId: body.confirmationId, approved: body.approved },
    });
    try {
      const decision = await tools.confirm(body.confirmationId, body.approved);
      audit.write({
        action: "confirmation.request",
        summary: `${body.approved ? "Approved" : "Rejected"} confirmation ${body.confirmationId}`,
        status: decision.rejected ? "rejected" : "ok",
        details: { confirmationId: body.confirmationId, approved: body.approved },
      });
      res.json({
        ok: true,
        confirmationId: body.confirmationId,
        result: decision.rejected ? { rejected: true } : decision.result,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      audit.write({
        action: "confirmation.request",
        summary: message,
        status: "error",
        details: { confirmationId: body.confirmationId, approved: body.approved },
      });
      res.status(404).json({ ok: false, confirmationId: body.confirmationId, error: message });
    }
  });

  app.get("/api/tools/pending", (_req, res) => {
    res.json(
      confirmations.list().map((item) => ({
        confirmationId: item.id,
        name: item.name,
        summary: item.summary,
        expiresAt: new Date(item.expiresAt).toISOString(),
      })),
    );
  });

  let server: Server;
  await new Promise<void>((resolve, reject) => {
    server = app
      .listen(port, "127.0.0.1", () => resolve())
      .on("error", (error) => reject(error));
  });

  return {
    port,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
};

const auditStatuses = new Set<AuditEvent["status"]>([
  "started",
  "queued",
  "running",
  "backoff",
  "ok",
  "needs_confirmation",
  "rejected",
  "cancelled",
  "error",
]);

const isAuditStatus = (value: unknown): value is AuditEvent["status"] =>
  typeof value === "string" && auditStatuses.has(value as AuditEvent["status"]);

const codexModelOptions = [
  { label: "App-server default", value: "" },
  { label: "GPT-5 Codex", value: "gpt-5-codex" },
  { label: "GPT-5", value: "gpt-5" },
  { label: "GPT-5 Mini", value: "gpt-5-mini" },
];
