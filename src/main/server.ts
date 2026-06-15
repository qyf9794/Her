import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createLocalApiAuth, requireLocalApiAuth } from "./api/auth";
import { localApiCors, requireTrustedLocalApiRequest } from "./api/cors";
import { createRealtimeClientSecret } from "./realtime";
import { readCodexModel, readOpenaiApiKey, readRealtimeVoice, saveCodexModel, saveOpenaiApiKey, saveRealtimeVoice } from "./config";
import { getAppleMusicDeveloperToken } from "./music/apple-music-token";
import { CodingAgentRuntime } from "./agents/coding-agent/runtime";
import { TaskQueue } from "./tasks/task-queue";
import { TaskStore } from "./tasks/task-store";
import { AliasStore } from "./memory/alias-store";
import { readCodexDeviceAuth, readCodexLoginStatus, startCodexDeviceAuth } from "./codex-login";
import { AuditLog } from "./audit";
import { AppInventoryService } from "./app-inventory";
import { CapabilityGate } from "./capability-gate";
import { SettingsStore } from "./settings-store";
import { MemoryStore } from "./memory-store";
import { ConfirmationQueue } from "./tools/confirmation";
import { ToolRegistry } from "./tools/registry";
import { manifestRealtimeToolDefinitions, manifestRealtimeToolDefinitionsForBundles } from "./tools/manifest";
import { isToolBundleName, selectToolBundles } from "./agent/tool-bundle-router";
import { SystemControl } from "./tools/system-control";
import type { CapabilitySettings } from "../shared/app-settings";
import type { AuditEvent } from "../shared/events";
import { realtimeVoiceOptions } from "../shared/realtime-config";
import type { ConfirmationDecision, ToolCallRequest } from "../shared/tools";

export type LocalServer = {
  port: number;
  localApiToken: string;
  close: () => Promise<void>;
};

export const startLocalServer = async (port: number, userDataDir: string, isPackaged = false): Promise<LocalServer> => {
  const app = express();
  const localApiAuth = createLocalApiAuth();
  const requireAuth = requireLocalApiAuth(localApiAuth);
  const audit = new AuditLog();
  const confirmations = new ConfirmationQueue();
  const settings = new SettingsStore(userDataDir);
  const memory = new MemoryStore(userDataDir);
  const codingAgent = new CodingAgentRuntime();
  const taskStore = new TaskStore(userDataDir);
  const taskQueue = new TaskQueue(taskStore);
  const aliasStore = new AliasStore(userDataDir);
  const inventory = new AppInventoryService(settings);
  const gate = new CapabilityGate(settings, () => inventory.listApps());
  const system = new SystemControl();
  const tools = new ToolRegistry(confirmations, audit, gate, {
    listApps: (refresh = false) => inventory.listApps(refresh),
    readSettings: () => settings.read(),
    setAppPermissions: (appPermissions) => settings.setAppPermissions(appPermissions),
    setCapabilities: (capabilities) => settings.setCapabilities(capabilities),
    setYoloMode: (enabled, appPermissions) => settings.setYoloMode(enabled, appPermissions),
  }, memory, codingAgent, taskStore, taskQueue, aliasStore);

  const safetyIdentifier = crypto.createHash("sha256").update(`her:${userDataDir}`).digest("hex");

  app.use(express.json({ limit: "1mb" }));
  app.use(localApiCors(isPackaged));

  app.get("/health", (_req, res) => {
    res.json({ ok: true, service: "her-local-agent" });
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

  app.use("/api", requireTrustedLocalApiRequest(isPackaged));

  app.get("/api/settings", requireAuth, (_req, res) => {
    res.json(settings.read());
  });

  app.post("/api/settings/capabilities", requireAuth, (req, res) => {
    res.json(settings.setCapabilities(req.body as Partial<CapabilitySettings>));
  });

  app.post("/api/settings/yolo", requireAuth, async (req, res) => {
    const body = req.body as { enabled?: boolean };
    const enabled = Boolean(body.enabled);
    const appPermissions = enabled
      ? Object.fromEntries((await inventory.listApps()).map((item) => [item.bundleId, true]))
      : {};
    res.json(settings.setYoloMode(enabled, appPermissions));
  });

  app.get("/api/apps", requireAuth, async (req, res) => {
    const refresh = req.query.refresh === "true";
    res.json(await inventory.listApps(refresh));
  });

  app.post("/api/apps/permissions", requireAuth, (req, res) => {
    const body = req.body as { appPermissions?: Record<string, boolean> };
    res.json(settings.setAppPermissions(body.appPermissions ?? {}));
  });

  app.post("/api/system/settings", requireAuth, async (req, res) => {
    const body = req.body as { pane?: string };
    try {
      res.json(await system.openSettings(body.pane));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(400).json({ error: message });
    }
  });

  app.get("/api/openai-key", requireAuth, (_req, res) => {
    res.json({ configured: Boolean(readOpenaiApiKey()) });
  });

  app.post("/api/openai-key", requireAuth, (req, res) => {
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

  app.get("/api/codex-login/status", requireAuth, async (_req, res) => {
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

  app.get("/api/codex-login/device-auth", requireAuth, (_req, res) => {
    res.json(readCodexDeviceAuth());
  });

  app.post("/api/codex-login/device-auth", requireAuth, (_req, res) => {
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

  app.get("/api/codex/model", requireAuth, (_req, res) => {
    res.json({
      model: readCodexModel(),
      options: codexModelOptions,
      note: "Empty model uses the Codex app-server default.",
    });
  });

  app.post("/api/codex/model", requireAuth, (req, res) => {
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

  app.get("/api/tasks", requireAuth, (req, res) => {
    const status = typeof req.query.status === "string" && isHerTaskStatus(req.query.status) ? req.query.status : undefined;
    const limit = typeof req.query.limit === "string" ? Number(req.query.limit) : 20;
    res.json({ tasks: taskStore.list({ status, limit: Number.isFinite(limit) ? limit : 20 }) });
  });

  app.get("/api/tasks/:taskId", requireAuth, (req, res) => {
    const task = taskStore.get(String(req.params.taskId));
    if (!task) {
      res.status(404).json({ error: "Task not found." });
      return;
    }
    res.json({ task });
  });

  app.get("/api/tasks/:taskId/events", requireAuth, (req, res) => {
    const limit = typeof req.query.limit === "string" ? Number(req.query.limit) : 50;
    res.json({ taskId: req.params.taskId, events: taskStore.listEvents(String(req.params.taskId), Number.isFinite(limit) ? limit : 50) });
  });

  app.post("/api/tasks/:taskId/cancel", requireAuth, (req, res) => {
    try {
      const reason = typeof req.body?.reason === "string" ? req.body.reason : undefined;
      res.json(taskQueue.cancel(String(req.params.taskId), reason));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(404).json({ error: message });
    }
  });

  app.get("/api/agents/coding/tasks", requireAuth, (req, res) => {
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const limit = typeof req.query.limit === "string" ? Number(req.query.limit) : 10;
    res.json(codingAgent.list(isCodingAgentStatus(status) ? status : undefined, Number.isFinite(limit) ? limit : 10));
  });

  app.get("/api/agents/coding/tasks/:taskId", requireAuth, (req, res) => {
    try {
      const taskId = String(req.params.taskId);
      res.json(codingAgent.status(taskId));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(404).json({ error: message });
    }
  });

  app.post("/api/agents/coding/tasks/:taskId/cancel", requireAuth, (req, res) => {
    try {
      const taskId = String(req.params.taskId);
      res.json(codingAgent.cancel(taskId));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(404).json({ error: message });
    }
  });

  app.get("/api/realtime/voice", requireAuth, (_req, res) => {
    res.json({
      voice: readRealtimeVoice(),
      options: realtimeVoiceOptions,
      note: "Voice changes apply when the next Realtime voice session starts.",
    });
  });

  app.post("/api/realtime/voice", requireAuth, (req, res) => {
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

  app.post("/api/audit", requireAuth, (req, res) => {
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

  app.post("/api/realtime/client-secret", requireAuth, async (_req, res) => {
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

  app.get("/api/realtime/tools", requireAuth, (req, res) => {
    const bundles = parseBundleQuery(req.query.bundles);
    res.json({
      bundles: bundles.length ? bundles : ["core"],
      tools: bundles.length ? manifestRealtimeToolDefinitionsForBundles(bundles) : manifestRealtimeToolDefinitions,
    });
  });

  app.get("/api/music/developer-token", requireAuth, (_req, res) => {
    const developerToken = getAppleMusicDeveloperToken();
    if (!developerToken) {
      res.status(400).json({
        error: "Apple Music developer token is not configured. Set APPLE_TEAM_ID, APPLE_MUSICKIT_KEY_ID, and HER_APPLE_MUSIC_PRIVATE_KEY_PATH.",
      });
      return;
    }
    res.json({ developerToken });
  });

  app.get("/api/music/playback-requests/next", requireAuth, (_req, res) => {
    const request = readQueuedMusicKitPlaybackRequest();
    res.json({ request });
  });

  app.post("/api/music/playback-status", requireAuth, (req, res) => {
    writeMusicKitPlaybackStatus(req.body);
    res.json({ ok: true });
  });

  app.post("/api/realtime/bundles/select", requireAuth, (req, res) => {
    const transcript = typeof req.body?.transcript === "string" ? req.body.transcript : "";
    const selection = selectToolBundles(transcript);
    res.json({
      selection,
      tools: manifestRealtimeToolDefinitionsForBundles(selection.bundles),
    });
  });

  app.post("/api/tools/execute", requireAuth, async (req, res) => {
    const body = req.body as ToolCallRequest;
    res.json(await tools.execute(body));
  });

  app.post("/api/tools/confirm", requireAuth, async (req, res) => {
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
        result: decision.rejected ? { rejected: true } : ("result" in decision ? decision.result : undefined),
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

  app.get("/api/tools/pending", requireAuth, (_req, res) => {
    res.json(
      confirmations.list().map((item) => ({
        confirmationId: item.id,
        name: item.name,
        summary: item.summary,
        risk: item.plan.risk,
        riskLabel: item.plan.riskLabel,
        target: item.plan.target,
        preview: item.plan.preview,
        reversible: item.plan.reversible,
        policyRationale: item.plan.policyRationale,
        taskId: item.plan.taskId,
        createdAt: new Date(item.createdAt).toISOString(),
        expiresAt: new Date(item.expiresAt).toISOString(),
      })),
    );
  });

  let server!: Server;
  await new Promise<void>((resolve, reject) => {
    server = app
      .listen(port, "127.0.0.1", () => resolve())
      .on("error", (error) => reject(error));
  });

  return {
    port: typeof server.address() === "object" && server.address() ? (server.address() as AddressInfo).port : port,
    localApiToken: localApiAuth.token,
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

const codingAgentStatuses = new Set(["queued", "running", "completed", "failed", "cancelled"]);
const herTaskStatuses = new Set(["queued", "running", "awaiting_confirmation", "completed", "failed", "cancelled", "blocked"]);

const isCodingAgentStatus = (value: unknown): value is "queued" | "running" | "completed" | "failed" | "cancelled" =>
  typeof value === "string" && codingAgentStatuses.has(value);

const isHerTaskStatus = (value: unknown): value is "queued" | "running" | "awaiting_confirmation" | "completed" | "failed" | "cancelled" | "blocked" =>
  typeof value === "string" && herTaskStatuses.has(value);

const parseBundleQuery = (value: unknown) => {
  const raw = Array.isArray(value) ? value.join(",") : typeof value === "string" ? value : "";
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(isToolBundleName);
};

const codexModelOptions = [
  { label: "App-server default", value: "" },
  { label: "GPT-5 Codex", value: "gpt-5-codex" },
  { label: "GPT-5", value: "gpt-5" },
  { label: "GPT-5 Mini", value: "gpt-5-mini" },
];

const queuedMusicRequestPath = () => path.join(process.cwd(), ".her-music-playback-request.json");
const musicPlaybackStatusPath = () => path.join(process.cwd(), ".her-music-playback-status.json");

const readQueuedMusicKitPlaybackRequest = () => {
  const filePath = queuedMusicRequestPath();
  if (!fs.existsSync(filePath)) return undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as {
      action?: unknown;
      id?: unknown;
      title?: unknown;
      artist?: unknown;
      album?: unknown;
      artworkUrl?: unknown;
    };
    fs.rmSync(filePath, { force: true });
    const action = parsed.action === "pause" || parsed.action === "stop" ? parsed.action : "play";
    if (action === "play" && (typeof parsed.id !== "string" || !parsed.id.trim())) return undefined;
    return {
      action,
      id: typeof parsed.id === "string" ? parsed.id.trim() : "",
      title: typeof parsed.title === "string" ? parsed.title : undefined,
      artist: typeof parsed.artist === "string" ? parsed.artist : undefined,
      album: typeof parsed.album === "string" ? parsed.album : undefined,
      artworkUrl: typeof parsed.artworkUrl === "string" ? parsed.artworkUrl : undefined,
    };
  } catch {
    fs.rmSync(filePath, { force: true });
    return undefined;
  }
};

const writeMusicKitPlaybackStatus = (value: unknown) => {
  const payload = value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
  fs.writeFileSync(
    musicPlaybackStatusPath(),
    JSON.stringify(
      {
        status: typeof payload.status === "string" ? payload.status : "unknown",
        songId: typeof payload.songId === "string" ? payload.songId : undefined,
        title: typeof payload.title === "string" ? payload.title : undefined,
        artist: typeof payload.artist === "string" ? payload.artist : undefined,
        album: typeof payload.album === "string" ? payload.album : undefined,
        artworkUrl: typeof payload.artworkUrl === "string" ? payload.artworkUrl : undefined,
        error: typeof payload.error === "string" ? payload.error : undefined,
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
};
