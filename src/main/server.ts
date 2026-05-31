import express from "express";
import type { Server } from "node:http";
import { createRealtimeClientSecret } from "./realtime";
import { readOpenaiApiKey, saveOpenaiApiKey } from "./config";
import { AuditLog } from "./audit";
import { AppInventoryService } from "./app-inventory";
import { CapabilityGate } from "./capability-gate";
import { SettingsStore } from "./settings-store";
import { ConfirmationQueue } from "./tools/confirmation";
import { ToolRegistry } from "./tools/registry";
import { SystemControl } from "./tools/system-control";
import type { CapabilitySettings } from "../shared/app-settings";
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
  const inventory = new AppInventoryService(settings);
  const gate = new CapabilityGate(settings, () => inventory.listApps());
  const system = new SystemControl();
  const tools = new ToolRegistry(confirmations, audit, gate, {
    listApps: (refresh = false) => inventory.listApps(refresh),
    readSettings: () => settings.read(),
    setAppPermissions: (appPermissions) => settings.setAppPermissions(appPermissions),
    setCapabilities: (capabilities) => settings.setCapabilities(capabilities),
    setYoloMode: (enabled, appPermissions) => settings.setYoloMode(enabled, appPermissions),
  });

  app.use(express.json({ limit: "1mb" }));
  app.use((_req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "content-type");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    next();
  });
  app.options("*", (_req, res) => res.sendStatus(204));

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

  app.post("/api/realtime/client-secret", async (_req, res) => {
    try {
      res.json(await createRealtimeClientSecret());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: message });
    }
  });

  app.post("/api/tools/execute", async (req, res) => {
    const body = req.body as ToolCallRequest;
    res.json(await tools.execute(body));
  });

  app.post("/api/tools/confirm", async (req, res) => {
    const body = req.body as ConfirmationDecision;
    try {
      const decision = await tools.confirm(body.confirmationId, body.approved);
      res.json({
        ok: true,
        confirmationId: body.confirmationId,
        result: decision.rejected ? { rejected: true } : decision.result,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
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
