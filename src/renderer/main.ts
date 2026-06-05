import * as THREE from "three";
import {
  OpenAIRealtimeWebRTC,
  RealtimeAgent,
  RealtimeSession,
  tool,
  type FunctionTool,
  type TransportEvent,
} from "@openai/agents/realtime";
import type { CapabilityKey, CapabilitySettings, InstalledApp, UserSettings } from "../shared/app-settings";
import { realtimeAgentInstructions } from "../shared/realtime-agent";
import {
  createRealtimeSessionConfig,
  realtimeInputTokenBudget,
  realtimeMaxOutputTokens,
  realtimeTranscriptionModel,
  realtimeTurnDetectionTuning,
  type RealtimeRuntimeOptions,
} from "../shared/realtime-config";
import type { AuditEvent } from "../shared/events";
import { allToolDefinitions, realtimeToolDefinitions, type ConfirmationResult, type ToolCallRequest, type ToolCallResult, type ToolName } from "../shared/tools";
import "./styles.css";

const LOCAL_API = "http://127.0.0.1:3939";

type SessionState = "idle" | "connecting" | "connected" | "error";
type VisualState = "idle" | "listening" | "thinking" | "speaking" | "tool" | "confirming" | "error";

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("Missing #app root.");

app.innerHTML = `
  <main class="productShell">
    <section id="onboarding" class="onboarding hidden" aria-label="Permission and app authorization">
      <header class="onboardingHeader">
        <div>
          <h1>HER</h1>
          <p id="onboardingStatus">Loading local applications...</p>
        </div>
        <div class="controls">
          <button id="onboardingYoloBtn" type="button">Enable YOLO</button>
          <button id="finishOnboardingBtn" type="button">Enter app</button>
        </div>
      </header>
      <section class="capabilityBand" aria-label="Global capabilities">
        <div id="onboardingCapabilities" class="toggleGrid"></div>
      </section>
      <section class="appPicker">
        <div class="sectionHeader">
          <h2>Application Authorization</h2>
          <button id="refreshAppsBtn" type="button">Refresh</button>
        </div>
        <div id="appGrid" class="appGrid"></div>
      </section>
    </section>

    <section id="appView" class="appView hidden">
      <section class="voiceStage">
        <header class="topbar">
          <div>
            <h1>HER</h1>
            <p id="statusText">Idle</p>
          </div>
          <div class="controls">
            <button id="connectBtn" type="button">Start voice</button>
            <button id="disconnectBtn" type="button" disabled>Stop</button>
          </div>
        </header>

        <section class="orbPanel" aria-label="Voice state">
          <div id="orbMount" class="orbMount"></div>
          <div class="orbTelemetry" aria-hidden="true">
            <span id="userMeter"></span>
            <span id="aiMeter"></span>
          </div>
        </section>

        <section class="conversation" aria-label="Conversation">
          <div id="transcript" class="transcript"></div>
          <div class="composer">
            <input id="textInput" type="text" placeholder="Type a fallback instruction..." />
            <button id="sendTextBtn" type="button" disabled>Send</button>
          </div>
        </section>
      </section>

      <aside class="sidepanel">
        <section class="apiKeyPanel">
          <div class="sectionHeader">
            <h2>OpenAI API Key</h2>
            <span id="openaiKeyBadge" class="keyBadge">Checking</span>
          </div>
          <div class="apiKeyForm">
            <input id="openaiKeyInput" type="password" placeholder="Paste OpenAI API key" autocomplete="off" spellcheck="false" />
            <button id="saveOpenaiKeyBtn" type="button">Save</button>
          </div>
          <p id="openaiKeyStatus" class="muted">Saved locally in .env.local for voice sessions.</p>
        </section>
        <section class="codexLoginPanel">
          <div class="sectionHeader">
            <h2>Codex Login</h2>
            <span id="codexLoginBadge" class="keyBadge">Checking</span>
          </div>
          <p id="codexLoginStatus" class="muted">Checking local Codex CLI login status.</p>
          <label class="codexModelField">
            <span>Model</span>
            <select id="codexModelSelect" aria-label="Codex model">
              <option value="">App-server default</option>
            </select>
          </label>
          <p id="codexModelStatus" class="muted">Codex tasks use this model unless a task overrides it.</p>
          <div class="codexLoginActions">
            <button id="refreshCodexLoginBtn" type="button">Refresh</button>
            <button id="startCodexLoginBtn" type="button">Start login</button>
          </div>
          <pre id="codexLoginOutput" class="codexLoginOutput hidden"></pre>
        </section>
        <section class="devicePanel">
          <div class="sectionHeader">
            <h2>Microphone</h2>
            <button id="refreshMicrophonesBtn" type="button">Refresh</button>
          </div>
          <select id="microphoneSelect" aria-label="Microphone input">
            <option value="">System default</option>
          </select>
          <p id="microphoneStatus" class="muted">Choose the input device macOS exposes to Electron.</p>
        </section>
        <section class="yoloPanel">
          <div class="sectionHeader">
            <h2>YOLO Mode</h2>
            <button id="yoloModeBtn" type="button">Enable</button>
          </div>
          <p id="yoloModeStatus" class="muted"></p>
          <div class="permissionButtons" aria-label="macOS permission shortcuts">
            <button type="button" data-settings-pane="microphone">Microphone</button>
            <button type="button" data-settings-pane="accessibility">Accessibility</button>
            <button type="button" data-settings-pane="screenrecording">Screen Recording</button>
            <button type="button" data-settings-pane="fulldiskaccess">Full Disk Access</button>
            <button type="button" data-settings-pane="automation">Automation</button>
          </div>
        </section>
        <section>
          <div class="sectionHeader">
            <h2>Capabilities</h2>
            <button id="openPermissionsBtn" type="button">Manage</button>
          </div>
          <div id="runtimeCapabilities" class="toggleGrid compact"></div>
        </section>
        <section>
          <h2>Authorized Apps</h2>
          <div id="authorizedApps" class="authorizedApps"></div>
        </section>
        <section>
          <h2>Realtime Usage</h2>
          <div id="realtimeUsage" class="usagePanel"></div>
        </section>
        <section>
          <h2>Pending Confirmation</h2>
          <div id="confirmations" class="stack empty">No pending actions</div>
        </section>
        <section>
          <h2>Tool Activity</h2>
          <div id="activity" class="stack empty">No tool calls yet</div>
        </section>
      </aside>
    </section>
  </main>
`;

const onboarding = document.querySelector<HTMLDivElement>("#onboarding")!;
const appView = document.querySelector<HTMLDivElement>("#appView")!;
const onboardingStatus = document.querySelector<HTMLParagraphElement>("#onboardingStatus")!;
const appGrid = document.querySelector<HTMLDivElement>("#appGrid")!;
const onboardingCapabilities = document.querySelector<HTMLDivElement>("#onboardingCapabilities")!;
const runtimeCapabilities = document.querySelector<HTMLDivElement>("#runtimeCapabilities")!;
const authorizedApps = document.querySelector<HTMLDivElement>("#authorizedApps")!;
const statusText = document.querySelector<HTMLParagraphElement>("#statusText")!;
const connectBtn = document.querySelector<HTMLButtonElement>("#connectBtn")!;
const disconnectBtn = document.querySelector<HTMLButtonElement>("#disconnectBtn")!;
const sendTextBtn = document.querySelector<HTMLButtonElement>("#sendTextBtn")!;
const textInput = document.querySelector<HTMLInputElement>("#textInput")!;
const transcript = document.querySelector<HTMLDivElement>("#transcript")!;
const confirmations = document.querySelector<HTMLDivElement>("#confirmations")!;
const activity = document.querySelector<HTMLDivElement>("#activity")!;
const orbMount = document.querySelector<HTMLDivElement>("#orbMount")!;
const userMeter = document.querySelector<HTMLSpanElement>("#userMeter")!;
const aiMeter = document.querySelector<HTMLSpanElement>("#aiMeter")!;
const finishOnboardingBtn = document.querySelector<HTMLButtonElement>("#finishOnboardingBtn")!;
const onboardingYoloBtn = document.querySelector<HTMLButtonElement>("#onboardingYoloBtn")!;
const refreshAppsBtn = document.querySelector<HTMLButtonElement>("#refreshAppsBtn")!;
const openPermissionsBtn = document.querySelector<HTMLButtonElement>("#openPermissionsBtn")!;
const yoloModeBtn = document.querySelector<HTMLButtonElement>("#yoloModeBtn")!;
const yoloModeStatus = document.querySelector<HTMLParagraphElement>("#yoloModeStatus")!;
const openaiKeyInput = document.querySelector<HTMLInputElement>("#openaiKeyInput")!;
const saveOpenaiKeyBtn = document.querySelector<HTMLButtonElement>("#saveOpenaiKeyBtn")!;
const openaiKeyStatus = document.querySelector<HTMLParagraphElement>("#openaiKeyStatus")!;
const openaiKeyBadge = document.querySelector<HTMLSpanElement>("#openaiKeyBadge")!;
const codexLoginBadge = document.querySelector<HTMLSpanElement>("#codexLoginBadge")!;
const codexLoginStatus = document.querySelector<HTMLParagraphElement>("#codexLoginStatus")!;
const refreshCodexLoginBtn = document.querySelector<HTMLButtonElement>("#refreshCodexLoginBtn")!;
const startCodexLoginBtn = document.querySelector<HTMLButtonElement>("#startCodexLoginBtn")!;
const codexLoginOutput = document.querySelector<HTMLPreElement>("#codexLoginOutput")!;
const codexModelSelect = document.querySelector<HTMLSelectElement>("#codexModelSelect")!;
const codexModelStatus = document.querySelector<HTMLParagraphElement>("#codexModelStatus")!;
const microphoneSelect = document.querySelector<HTMLSelectElement>("#microphoneSelect")!;
const refreshMicrophonesBtn = document.querySelector<HTMLButtonElement>("#refreshMicrophonesBtn")!;
const microphoneStatus = document.querySelector<HTMLParagraphElement>("#microphoneStatus")!;
const realtimeUsage = document.querySelector<HTMLDivElement>("#realtimeUsage")!;

const capabilityLabels: Record<CapabilityKey, string> = {
  fileManagement: "File management",
  browserAutomation: "Browser operations",
  textOperations: "Text and writing",
  systemOperations: "System operations",
};

const capabilityHelp: Record<CapabilityKey, string> = {
  fileManagement: "file_* and document file access inside allowed folders",
  browserAutomation: "browser opening, isolated browser, forms, and clicks",
  textOperations: "drafts, summaries, clipboard, email and calendar adapters",
  systemOperations: "apps, windows, volume, brightness, settings, and shell",
};

let settings: UserSettings | null = null;
let installedApps: InstalledApp[] = [];
let appPermissions: Record<string, boolean> = {};
let state: SessionState = "idle";
let visualState: VisualState = "idle";
let realtimeSession: RealtimeSession | null = null;
let realtimeTransport: OpenAIRealtimeWebRTC | null = null;
let localStream: MediaStream | null = null;
let audioContext: AudioContext | null = null;
let inputAnalyser: AnalyserNode | null = null;
let outputAnalyser: AnalyserNode | null = null;
let userLevel = 0;
let aiLevel = 0;
let hasOpenaiApiKey = false;
let selectedMicrophoneId = window.localStorage.getItem("her:selectedMicrophoneId") ?? "";

type RealtimeUsageStats = {
  responses: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  audioInputTokens: number;
  audioOutputTokens: number;
  textInputTokens: number;
  textOutputTokens: number;
  transcriptionTokens: number;
  rateLimits: Array<{ name: string; remaining: number; limit: number; resetSeconds?: number }>;
  lastError?: string;
};

type RealtimeRateLimitSnapshot = { name: string; remaining: number; limit: number; resetSeconds?: number };

const realtimeUsageStats: RealtimeUsageStats = {
  responses: 0,
  inputTokens: 0,
  outputTokens: 0,
  cachedTokens: 0,
  audioInputTokens: 0,
  audioOutputTokens: 0,
  textInputTokens: 0,
  textOutputTokens: 0,
  transcriptionTokens: 0,
  rateLimits: [],
};

const getJson = async <T>(path: string): Promise<T> => {
  const response = await fetch(`${LOCAL_API}${path}`);
  const payload = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
  return payload;
};

const postJson = async <T>(path: string, body: unknown): Promise<T> => {
  const response = await fetch(`${LOCAL_API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
  return payload;
};

const writeAudit = (
  action: string,
  summary: string,
  status: AuditEvent["status"],
  details?: Record<string, unknown>,
) => {
  void fetch(`${LOCAL_API}/api/audit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, summary, status, details }),
  }).catch(() => undefined);
};

const initialize = async () => {
  initOrb();
  renderRealtimeUsage();
  try {
    settings = await getJson<UserSettings>("/api/settings");
    await loadOpenaiKeyStatus();
    await loadCodexLoginStatus();
    await loadCodexModel();
    await refreshMicrophoneDevices();
    installedApps = await getJson<InstalledApp[]>("/api/apps");
    appPermissions = Object.fromEntries(installedApps.map((item) => [item.bundleId, item.authorized]));
    renderSettings();
    showOnboarding(!settings.hasCompletedOnboarding);
    addLine("system", "Start voice, then ask me to manage files, documents, drafts, email, calendar, music, apps, browser tasks, or safe shell commands.");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    onboardingStatus.textContent = message;
    statusText.textContent = message;
    renderOpenaiKeyStatus(false, "Start or restart the app backend to enable key saving.");
    renderCodexLoginStatus({ configured: false, label: "Error", detail: "Start or restart the app backend to check Codex login." });
    codexModelStatus.textContent = "Start or restart the app backend to load Codex models.";
    showOnboarding(false);
    addLine("system", `Local backend unavailable: ${message}`);
    setVisualState("error");
  }
};

const showOnboarding = (visible: boolean) => {
  onboarding.classList.toggle("hidden", !visible);
  appView.classList.toggle("hidden", visible);
  onboardingStatus.textContent = `${installedApps.length} local apps found. Recommended low-risk apps are preselected.`;
  if (!visible) requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
};

const renderSettings = () => {
  if (!settings) return;
  renderYoloMode();
  renderCapabilityControls(onboardingCapabilities, false);
  renderCapabilityControls(runtimeCapabilities, true);
  renderAppGrid();
  renderAuthorizedApps();
};

const renderYoloMode = () => {
  if (!settings) return;
  const enabled = settings.yoloMode;
  yoloModeBtn.textContent = enabled ? "Disable" : "Enable";
  onboardingYoloBtn.textContent = enabled ? "YOLO enabled" : "Enable YOLO";
  yoloModeBtn.classList.toggle("dangerActive", enabled);
  onboardingYoloBtn.classList.toggle("dangerActive", enabled);
  yoloModeStatus.textContent = enabled
    ? "All discovered apps and capabilities are enabled. Local confirmations are bypassed."
    : "Enable all discovered app permissions and bypass local confirmation prompts.";
};

const renderCapabilityControls = (target: HTMLElement, compact: boolean) => {
  if (!settings) return;
  target.innerHTML = "";
  for (const key of Object.keys(settings.capabilities) as CapabilityKey[]) {
    const label = document.createElement("label");
    label.className = `capabilityToggle${compact ? " compactToggle" : ""}`;
    label.innerHTML = `
      <input type="checkbox" data-capability="${key}" ${settings.capabilities[key] ? "checked" : ""} ${settings.yoloMode ? "disabled" : ""} />
      <span>
        <strong>${capabilityLabels[key]}</strong>
        <small>${capabilityHelp[key]}</small>
      </span>
    `;
    target.append(label);
  }
};

const renderAppGrid = () => {
  appGrid.innerHTML = "";
  for (const item of installedApps) {
    const enabled = appPermissions[item.bundleId] ?? item.recommended;
    const button = document.createElement("button");
    button.type = "button";
    button.className = `appTile ${enabled ? "selected" : ""} ${item.risk === "high" ? "highRisk" : ""}`;
    button.dataset.bundleId = item.bundleId;
    button.innerHTML = `
      <img src="${iconSrc(item)}" alt="" />
      <span class="appName">${escapeHtml(item.name)}</span>
      <span class="risk">${item.risk}</span>
      <span class="capTags">${item.capabilities.map((capability) => `<em>${capability}</em>`).join("")}</span>
    `;
    appGrid.append(button);
  }
};

const renderAuthorizedApps = () => {
  const enabled = installedApps.filter((item) => appPermissions[item.bundleId] ?? item.recommended);
  authorizedApps.innerHTML = enabled.length
    ? enabled
        .map(
          (item) => `
            <div class="authorizedApp">
              <img src="${iconSrc(item)}" alt="" />
              <span>${escapeHtml(item.name)}</span>
            </div>
          `,
        )
        .join("")
    : `<p class="muted">No authorized apps</p>`;
};

const iconSrc = (item: InstalledApp) => `${LOCAL_API}${item.iconUrl}`;

const saveCapabilities = async (capabilities: Partial<CapabilitySettings>) => {
  settings = await postJson<UserSettings>("/api/settings/capabilities", capabilities);
  renderSettings();
};

const saveAppPermissions = async () => {
  settings = await postJson<UserSettings>("/api/apps/permissions", { appPermissions });
  installedApps = await getJson<InstalledApp[]>("/api/apps");
  appPermissions = Object.fromEntries(installedApps.map((item) => [item.bundleId, item.authorized]));
  renderSettings();
};

const saveYoloMode = async (enabled: boolean) => {
  settings = await postJson<UserSettings>("/api/settings/yolo", { enabled });
  installedApps = await getJson<InstalledApp[]>("/api/apps");
  appPermissions = Object.fromEntries(installedApps.map((item) => [item.bundleId, item.authorized]));
  renderSettings();
  addActivity(`YOLO mode ${enabled ? "enabled" : "disabled"}`, "ok");
};

const openSystemSettingsPane = async (pane: string) => {
  await postJson<Record<string, unknown>>("/api/system/settings", { pane });
  addActivity(`Opened macOS ${pane} settings`, "ok");
};

type OpenaiKeyStatus = {
  configured: boolean;
};

type CodexLoginStatus = {
  configured: boolean;
  label: string;
  detail: string;
  command: string;
  checkedAt: string;
};

type CodexDeviceAuthStatus = {
  running: boolean;
  startedAt?: string;
  completedAt?: string;
  exitCode?: number | null;
  output: string;
  command: string;
};

type CodexModelStatus = {
  model: string;
  options: Array<{ label: string; value: string }>;
  note?: string;
};

const renderOpenaiKeyStatus = (configured: boolean, message?: string) => {
  hasOpenaiApiKey = configured;
  openaiKeyBadge.textContent = configured ? "Configured" : "Missing";
  openaiKeyBadge.classList.toggle("configured", configured);
  openaiKeyStatus.textContent =
    message ?? (configured ? "OpenAI key is saved locally and ready for voice sessions." : "Add a key before starting voice.");
  if (state === "idle") {
    statusText.textContent = configured ? "Idle" : "Add OpenAI API key before starting voice";
    connectBtn.disabled = !configured;
  }
};

const renderCodexLoginStatus = (status: Pick<CodexLoginStatus, "configured" | "label" | "detail">) => {
  codexLoginBadge.textContent = status.label;
  codexLoginBadge.classList.toggle("configured", status.configured);
  codexLoginBadge.classList.toggle("error", status.label.toLowerCase() === "error");
  codexLoginStatus.textContent = status.detail;
  startCodexLoginBtn.disabled = status.configured;
};

const loadCodexLoginStatus = async () => {
  refreshCodexLoginBtn.disabled = true;
  try {
    const result = await getJson<CodexLoginStatus>("/api/codex-login/status");
    renderCodexLoginStatus(result);
    if (result.configured) {
      codexLoginOutput.classList.add("hidden");
      codexLoginOutput.textContent = "";
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    renderCodexLoginStatus({ configured: false, label: "Error", detail: message });
  } finally {
    refreshCodexLoginBtn.disabled = false;
  }
};

let codexLoginPoll: number | undefined;

const renderCodexModel = (status: CodexModelStatus) => {
  const options = [...status.options];
  if (status.model && !options.some((item) => item.value === status.model)) {
    options.push({ label: status.model, value: status.model });
  }

  codexModelSelect.innerHTML = "";
  for (const option of options) {
    const item = document.createElement("option");
    item.value = option.value;
    item.textContent = option.label;
    codexModelSelect.append(item);
  }
  codexModelSelect.value = status.model;
  codexModelStatus.textContent = status.model
    ? `Codex tasks default to ${status.model}.`
    : (status.note ?? "Codex tasks use the app-server default model.");
};

const loadCodexModel = async () => {
  try {
    renderCodexModel(await getJson<CodexModelStatus>("/api/codex/model"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    codexModelStatus.textContent = `Model status failed: ${message}`;
  }
};

const saveCodexModel = async () => {
  const model = codexModelSelect.value;
  codexModelSelect.disabled = true;
  codexModelStatus.textContent = model ? `Saving ${model}...` : "Switching to app-server default...";
  try {
    renderCodexModel(await postJson<CodexModelStatus>("/api/codex/model", { model }));
    addActivity(model ? `Codex model set to ${model}` : "Codex model reset to app-server default", "ok");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    codexModelStatus.textContent = message;
    addActivity(`Codex model update failed: ${message}`, "error");
  } finally {
    codexModelSelect.disabled = false;
  }
};

const renderCodexDeviceAuth = (result: CodexDeviceAuthStatus) => {
  const output = result.output || `${result.command}\nWaiting for Codex to print device login instructions...`;
  codexLoginOutput.classList.remove("hidden");
  codexLoginOutput.textContent = output;
  if (result.running) {
    renderCodexLoginStatus({ configured: false, label: "Login", detail: "Codex device login is running. Complete the browser/device prompt, then refresh status." });
    startCodexLoginBtn.disabled = true;
    return;
  }

  startCodexLoginBtn.disabled = false;
  if (typeof result.exitCode === "number" && result.exitCode !== 0) {
    renderCodexLoginStatus({ configured: false, label: "Error", detail: `Codex login exited with code ${result.exitCode}.` });
  }
};

const pollCodexDeviceAuth = async () => {
  const result = await getJson<CodexDeviceAuthStatus>("/api/codex-login/device-auth");
  renderCodexDeviceAuth(result);
  if (result.running) {
    codexLoginPoll = window.setTimeout(() => void pollCodexDeviceAuth(), 2000);
    return;
  }
  codexLoginPoll = undefined;
  await loadCodexLoginStatus();
};

const startCodexLogin = async () => {
  if (codexLoginPoll) window.clearTimeout(codexLoginPoll);
  startCodexLoginBtn.disabled = true;
  codexLoginStatus.textContent = "Starting Codex device login...";
  try {
    const result = await postJson<CodexDeviceAuthStatus>("/api/codex-login/device-auth", {});
    renderCodexDeviceAuth(result);
    addActivity("Codex device login started", "pending");
    if (result.running) codexLoginPoll = window.setTimeout(() => void pollCodexDeviceAuth(), 2000);
    else await loadCodexLoginStatus();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    renderCodexLoginStatus({ configured: false, label: "Error", detail: message });
    startCodexLoginBtn.disabled = false;
    addActivity(`Codex login failed: ${message}`, "error");
  }
};

const loadOpenaiKeyStatus = async () => {
  try {
    const result = await getJson<OpenaiKeyStatus>("/api/openai-key");
    renderOpenaiKeyStatus(result.configured);
  } catch {
    renderOpenaiKeyStatus(false, "Restart the app once to enable key saving.");
  }
};

const saveOpenaiKey = async () => {
  const apiKey = openaiKeyInput.value.trim();
  if (!apiKey) {
    renderOpenaiKeyStatus(false, "Paste an OpenAI API key first.");
    openaiKeyInput.focus();
    return;
  }

  saveOpenaiKeyBtn.disabled = true;
  openaiKeyStatus.textContent = "Saving key locally...";
  try {
    const result = await postJson<OpenaiKeyStatus>("/api/openai-key", { apiKey });
    openaiKeyInput.value = "";
    renderOpenaiKeyStatus(result.configured, "Saved. Voice sessions will use this key now.");
    addActivity("OpenAI API key saved locally", "ok");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    renderOpenaiKeyStatus(false, message);
  } finally {
    saveOpenaiKeyBtn.disabled = false;
  }
};

const reloadSettingsAndApps = async () => {
  settings = await getJson<UserSettings>("/api/settings");
  installedApps = await getJson<InstalledApp[]>("/api/apps");
  appPermissions = Object.fromEntries(installedApps.map((item) => [item.bundleId, item.authorized]));
  renderSettings();
};

const refreshApps = async () => {
  onboardingStatus.textContent = "Refreshing local applications...";
  installedApps = await getJson<InstalledApp[]>("/api/apps?refresh=true");
  appPermissions = Object.fromEntries(installedApps.map((item) => [item.bundleId, item.authorized]));
  renderSettings();
  onboardingStatus.textContent = `${installedApps.length} local apps found.`;
};

const setState = (next: SessionState, detail?: string) => {
  state = next;
  statusText.textContent = !hasOpenaiApiKey && next === "idle" ? "Add OpenAI API key before starting voice" : (detail ?? next);
  connectBtn.disabled = !hasOpenaiApiKey || next === "connecting" || next === "connected";
  disconnectBtn.disabled = next !== "connected" && next !== "connecting";
  sendTextBtn.disabled = next !== "connected";
  if (next === "idle") setVisualState("idle");
  if (next === "connecting") setVisualState("thinking");
  if (next === "connected") setVisualState("listening");
  if (next === "error") setVisualState("error");
};

const setVisualState = (next: VisualState) => {
  visualState = next;
  orbMount.dataset.state = next;
};

const addLine = (kind: "user" | "assistant" | "system" | "tool", text: string) => {
  const row = document.createElement("div");
  row.className = `line ${kind}`;
  row.textContent = text;
  transcript.append(row);
  transcript.scrollTop = transcript.scrollHeight;
};

const addActivity = (text: string, status: "ok" | "pending" | "error" = "ok") => {
  if (activity.classList.contains("empty")) {
    activity.textContent = "";
    activity.classList.remove("empty");
  }
  const item = document.createElement("div");
  item.className = `activity ${status}`;
  item.textContent = text;
  activity.prepend(item);
};

const renderRealtimeUsage = () => {
  const cacheRatio =
    realtimeUsageStats.inputTokens > 0
      ? Math.round((realtimeUsageStats.cachedTokens / realtimeUsageStats.inputTokens) * 100)
      : 0;
  const rateLimitText = realtimeUsageStats.rateLimits.length
    ? realtimeUsageStats.rateLimits
        .slice(0, 3)
        .map((item) => `${item.name}: ${item.remaining}/${item.limit}`)
        .join(" · ")
    : "No rate limit update";

  realtimeUsage.innerHTML = `
    <div class="usageGrid">
      <span>Responses</span><strong>${realtimeUsageStats.responses}</strong>
      <span>Input</span><strong>${realtimeUsageStats.inputTokens}</strong>
      <span>Output</span><strong>${realtimeUsageStats.outputTokens}</strong>
      <span>Cached</span><strong>${realtimeUsageStats.cachedTokens} (${cacheRatio}%)</strong>
      <span>Audio in/out</span><strong>${realtimeUsageStats.audioInputTokens}/${realtimeUsageStats.audioOutputTokens}</strong>
      <span>ASR</span><strong>${realtimeUsageStats.transcriptionTokens}</strong>
    </div>
    <p>${escapeHtml(rateLimitText)}</p>
    ${realtimeUsageStats.lastError ? `<p class="usageError">${escapeHtml(realtimeUsageStats.lastError)}</p>` : ""}
  `;
};

type RealtimeAccess = {
  clientSecret: string;
  model: string;
  voice: string;
  runtimeOptions: RealtimeRuntimeOptions;
};

const getRealtimeAccess = async (): Promise<RealtimeAccess> => {
  const payload = await postJson<Record<string, unknown>>("/api/realtime/client-secret", {});
  const direct = payload.value;
  const nested = (payload.client_secret as { value?: string } | undefined)?.value;
  const secret = typeof direct === "string" ? direct : nested;
  if (!secret) throw new Error("Realtime client secret response did not include a usable value.");
  const her = payload.her as {
    realtimeModel?: unknown;
    realtimeVoice?: unknown;
    maxOutputTokens?: unknown;
    truncation?: { postInstructions?: unknown; retentionRatio?: unknown };
    transcription?: { enabled?: unknown; model?: unknown };
    turnDetection?: { threshold?: unknown; silenceDurationMs?: unknown; prefixPaddingMs?: unknown };
  } | undefined;
  return {
    clientSecret: secret,
    model: typeof her?.realtimeModel === "string" ? her.realtimeModel : "gpt-realtime-2",
    voice: typeof her?.realtimeVoice === "string" ? her.realtimeVoice : "marin",
    runtimeOptions: {
      budget: {
        postInstructions:
          typeof her?.truncation?.postInstructions === "number"
            ? her.truncation.postInstructions
            : realtimeInputTokenBudget.postInstructions,
        retentionRatio:
          typeof her?.truncation?.retentionRatio === "number"
            ? her.truncation.retentionRatio
            : realtimeInputTokenBudget.retentionRatio,
      },
      maxOutputTokens: typeof her?.maxOutputTokens === "number" ? her.maxOutputTokens : realtimeMaxOutputTokens,
      transcriptionEnabled:
        typeof her?.transcription?.enabled === "boolean" ? her.transcription.enabled : true,
      transcriptionModel:
        typeof her?.transcription?.model === "string" ? her.transcription.model : realtimeTranscriptionModel,
      turnDetection: {
        threshold:
          typeof her?.turnDetection?.threshold === "number"
            ? her.turnDetection.threshold
            : realtimeTurnDetectionTuning.threshold,
        silenceDurationMs:
          typeof her?.turnDetection?.silenceDurationMs === "number"
            ? her.turnDetection.silenceDurationMs
            : realtimeTurnDetectionTuning.silenceDurationMs,
        prefixPaddingMs:
          typeof her?.turnDetection?.prefixPaddingMs === "number"
            ? her.turnDetection.prefixPaddingMs
            : realtimeTurnDetectionTuning.prefixPaddingMs,
      },
    },
  };
};

const renderMicrophoneDevices = (devices: MediaDeviceInfo[]) => {
  const audioInputs = devices.filter((device) => device.kind === "audioinput");
  const selectedStillExists = selectedMicrophoneId && audioInputs.some((device) => device.deviceId === selectedMicrophoneId);
  if (selectedMicrophoneId && !selectedStillExists) {
    selectedMicrophoneId = "";
    window.localStorage.removeItem("her:selectedMicrophoneId");
  }

  microphoneSelect.innerHTML = `<option value="">System default</option>`;
  audioInputs.forEach((device, index) => {
    const option = document.createElement("option");
    option.value = device.deviceId;
    option.textContent = device.label || `Microphone ${index + 1}`;
    microphoneSelect.append(option);
  });
  microphoneSelect.value = selectedMicrophoneId;
  microphoneStatus.textContent = audioInputs.length
    ? "Select your phone mic if it appears here."
    : "No microphone found. Check macOS Sound input or reconnect your phone mic.";
};

const refreshMicrophoneDevices = async () => {
  if (!navigator.mediaDevices?.enumerateDevices) {
    microphoneStatus.textContent = "This browser cannot list microphone devices.";
    return;
  }

  refreshMicrophonesBtn.disabled = true;
  microphoneStatus.textContent = "Checking microphone devices...";
  try {
    renderMicrophoneDevices(await navigator.mediaDevices.enumerateDevices());
  } catch (error) {
    microphoneStatus.textContent = microphoneErrorMessage(error);
  } finally {
    refreshMicrophonesBtn.disabled = false;
  }
};

const microphoneAudioConstraint = (): boolean | MediaTrackConstraints =>
  selectedMicrophoneId ? { deviceId: { exact: selectedMicrophoneId } } : true;

const assertMicrophoneAvailable = async () => {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("This browser cannot access a microphone. Open the Electron app window and allow Microphone access.");
  }

  const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
  const audioInputs = devices.filter((device) => device.kind === "audioinput");
  if (devices.length > 0 && audioInputs.length === 0) {
    throw new Error("No microphone input was found. Connect or enable a microphone, then allow Microphone access for Electron in macOS System Settings.");
  }
  if (selectedMicrophoneId && audioInputs.length > 0 && !audioInputs.some((device) => device.deviceId === selectedMicrophoneId)) {
    throw new Error("Selected microphone is no longer available. Refresh the microphone list and choose your phone mic again.");
  }
};

const microphoneErrorMessage = (error: unknown) => {
  const raw = error instanceof Error ? error.message : String(error);
  if (/requested device not found|notfounderror/i.test(raw)) {
    return "No microphone input was found. Connect or enable a microphone, then allow Microphone access for Electron in macOS System Settings.";
  }
  if (/permission denied|notallowederror/i.test(raw)) {
    return "Microphone access is blocked. Open System Settings > Privacy & Security > Microphone and enable Electron.";
  }
  return raw;
};

const connect = async () => {
  setState("connecting", "Requesting microphone and Realtime session...");
  writeAudit("realtime.connect", "Starting Realtime voice session", "started", {
    microphoneDeviceSelected: Boolean(selectedMicrophoneId),
  });
  try {
    await assertMicrophoneAvailable();
    const access = await getRealtimeAccess();
    localStream = await navigator.mediaDevices.getUserMedia({ audio: microphoneAudioConstraint() });
    void refreshMicrophoneDevices();
    setupInputAnalyser(localStream);

    const audio = document.createElement("audio");
    audio.autoplay = true;
    audio.addEventListener("play", () => {
      const outputStream = (audio as HTMLAudioElement & { captureStream?: () => MediaStream }).captureStream?.();
      if (outputStream) setupOutputAnalyser(outputStream);
    });

    realtimeTransport = new OpenAIRealtimeWebRTC({
      mediaStream: localStream,
      audioElement: audio,
    });

    const agent = new RealtimeAgent({
      name: "HER",
      instructions: realtimeAgentInstructions,
      voice: access.voice,
      tools: createRealtimeTools(),
    });

    realtimeSession = new RealtimeSession(agent, {
      model: access.model,
      transport: realtimeTransport,
      config: createRealtimeSessionConfig(access.voice, access.runtimeOptions),
    });

    wireRealtimeSessionEvents(realtimeSession);
    await realtimeSession.connect({ apiKey: access.clientSecret });
    setState("connected", "Connected. Speak naturally.");
    addLine("system", "Voice session connected.");
    writeAudit("realtime.connect", "Realtime voice session connected", "ok", {
      model: access.model,
      voice: access.voice,
      runtimeOptions: access.runtimeOptions,
    });
  } catch (error) {
    disconnect();
    const message = microphoneErrorMessage(error);
    setState("error", message);
    addLine("system", message);
    writeAudit("realtime.connect", message, "error");
  }
};

const disconnect = () => {
  if (realtimeSession || realtimeTransport || localStream) {
    writeAudit("realtime.disconnect", "Realtime voice session disconnected", "cancelled");
  }
  realtimeSession?.close();
  realtimeSession = null;
  realtimeTransport = null;
  localStream?.getTracks().forEach((track) => track.stop());
  localStream = null;
  inputAnalyser = null;
  outputAnalyser = null;
  activeAssistantLine = null;
  setState("idle", "Idle");
};

const wireRealtimeSessionEvents = (session: RealtimeSession) => {
  session.on("transport_event", (event) => handleTransportEvent(event));
  session.on("agent_start", () => setVisualState("thinking"));
  session.on("audio_start", () => setVisualState("speaking"));
  session.on("audio_stopped", () => {
    activeAssistantLine = null;
    setVisualState("listening");
  });
  session.on("audio_interrupted", () => {
    activeAssistantLine = null;
    setVisualState("listening");
  });
  session.on("agent_tool_start", (_context, _agent, sdkTool) => {
    setVisualState("tool");
    addActivity(`${sdkTool.name} requested`, "pending");
  });
  session.on("agent_tool_end", async (_context, _agent, sdkTool) => {
    addActivity(`${sdkTool.name} completed`, "ok");
    setVisualState("listening");
  });
  session.on("error", (event) => {
    setVisualState("error");
    addLine("system", errorMessage(event.error));
  });
};

const handleTransportEvent = (event: TransportEvent) => {
  trackRealtimeTelemetry(event);

  if (event.type === "conversation.item.input_audio_transcription.completed") {
    addLine("user", event.transcript);
    setVisualState("thinking");
    return;
  }

  if (event.type === "response.audio_transcript.delta") {
    setVisualState("speaking");
    appendAssistantDelta(String(event.delta ?? ""));
    return;
  }

  if (event.type === "error") {
    setVisualState("error");
    addLine("system", errorMessage(event.error));
  }
};

const trackRealtimeTelemetry = (event: TransportEvent) => {
  const raw = event as unknown as Record<string, unknown>;
  if (raw.type === "response.done") {
    const response = raw.response as Record<string, unknown> | undefined;
    addRealtimeUsage(response?.usage);
    writeAudit("realtime.response", "Realtime response completed", "ok", {
      responseId: response?.id,
      status: response?.status,
      statusDetails: response?.status_details,
      usage: response?.usage,
    });
    renderRealtimeUsage();
    return;
  }

  if (raw.type === "conversation.item.input_audio_transcription.completed") {
    addTranscriptionUsage(raw.usage);
    writeAudit("realtime.transcription", "Input audio transcription completed", "ok", {
      itemId: raw.item_id,
      transcriptChars: typeof raw.transcript === "string" ? raw.transcript.length : undefined,
      usage: raw.usage,
    });
    renderRealtimeUsage();
    return;
  }

  if (raw.type === "rate_limits.updated") {
    const rateLimits = Array.isArray(raw.rate_limits) ? raw.rate_limits : [];
    realtimeUsageStats.rateLimits = rateLimits
      .map((item) => normalizeRateLimit(item))
      .filter((item): item is RealtimeRateLimitSnapshot => Boolean(item));
    writeAudit("realtime.rate_limits", "Realtime rate limits updated", "ok", {
      rateLimits: realtimeUsageStats.rateLimits,
    });
    renderRealtimeUsage();
    return;
  }

  if (raw.type === "error") {
    const message = errorMessage(raw.error);
    realtimeUsageStats.lastError = message;
    writeAudit("realtime.error", message, "error", { error: raw.error });
    if (/rate limit|429|too many requests/i.test(message)) {
      addActivity(`Realtime rate limit: ${message}`, "error");
    }
    renderRealtimeUsage();
  }
};

const addRealtimeUsage = (usage: unknown) => {
  if (!usage || typeof usage !== "object") return;
  const value = usage as Record<string, unknown>;
  const input = readNumber(value, "input_tokens");
  const output = readNumber(value, "output_tokens");
  realtimeUsageStats.responses += 1;
  realtimeUsageStats.inputTokens += input;
  realtimeUsageStats.outputTokens += output;

  const inputDetails = value.input_token_details as Record<string, unknown> | undefined;
  const outputDetails = value.output_token_details as Record<string, unknown> | undefined;
  realtimeUsageStats.cachedTokens += readNumber(inputDetails, "cached_tokens");
  realtimeUsageStats.textInputTokens += readNumber(inputDetails, "text_tokens");
  realtimeUsageStats.audioInputTokens += readNumber(inputDetails, "audio_tokens");
  realtimeUsageStats.textOutputTokens += readNumber(outputDetails, "text_tokens");
  realtimeUsageStats.audioOutputTokens += readNumber(outputDetails, "audio_tokens");
};

const addTranscriptionUsage = (usage: unknown) => {
  if (!usage || typeof usage !== "object") return;
  const value = usage as Record<string, unknown>;
  realtimeUsageStats.transcriptionTokens += readNumber(value, "input_tokens") + readNumber(value, "output_tokens");
};

const normalizeRateLimit = (value: unknown): RealtimeRateLimitSnapshot | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Record<string, unknown>;
  const name = typeof item.name === "string" ? item.name : "limit";
  const remaining = readNumber(item, "remaining");
  const limit = readNumber(item, "limit");
  const resetSeconds = readNumber(item, "reset_seconds");
  return {
    name,
    remaining,
    limit,
    ...(resetSeconds ? { resetSeconds } : {}),
  };
};

const readNumber = (value: Record<string, unknown> | undefined, key: string) => {
  const raw = value?.[key];
  return typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
};

const createRealtimeTools = (): FunctionTool[] =>
  realtimeToolDefinitions.map((definition) =>
    tool({
      name: definition.name,
      description: definition.description,
      parameters: definition.parameters as never,
      strict: false,
      execute: async (input, _context, details) => {
        const callId = typeof details?.toolCall?.callId === "string" ? details.toolCall.callId : undefined;
        return executeLocalToolForSdk(definition.name, input, callId);
      },
    }),
  );

const coerceToolArguments = (input: unknown): Record<string, unknown> => {
  if (typeof input === "string") {
    try {
      const parsed = JSON.parse(input) as unknown;
      return coerceToolArguments(parsed);
    } catch {
      return {};
    }
  }

  if (input && typeof input === "object" && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }

  return {};
};

const executeLocalToolForSdk = async (name: string, input: unknown, callId?: string) => {
  if (!isToolName(name)) {
    const result = { ok: false, name, error: `Unknown local tool: ${name}` };
    addActivity(`Unknown tool requested: ${name}`, "error");
    return result;
  }

  setVisualState("tool");
  const result = await postJson<ToolCallResult>("/api/tools/execute", {
    name,
    arguments: coerceToolArguments(input),
    callId,
    source: "realtime",
  } satisfies ToolCallRequest);

  if (result.ok && result.requiresConfirmation) {
    setVisualState("confirming");
    addActivity(result.summary, "pending");
    renderConfirmation(result);
  } else if (result.ok) {
    setVisualState("listening");
    if (name === "app_permission_set" || name === "capability_set" || name === "yolo_mode_set") {
      await reloadSettingsAndApps();
    }
    if (name === "confirmation_decide") {
      await reloadPendingConfirmations();
    }
  } else {
    setVisualState("error");
    addActivity(`${name} failed: ${result.error}`, "error");
  }

  return result;
};

const errorMessage = (error: unknown) => {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
};

let activeAssistantLine: HTMLDivElement | null = null;
const appendAssistantDelta = (text: string) => {
  if (!text) return;
  if (!activeAssistantLine || !transcript.contains(activeAssistantLine)) {
    activeAssistantLine = document.createElement("div");
    activeAssistantLine.className = "line assistant";
    transcript.append(activeAssistantLine);
  }
  activeAssistantLine.textContent += text;
  transcript.scrollTop = transcript.scrollHeight;
};

const toolNames = new Set<string>(allToolDefinitions.map((definition) => definition.name));

const isToolName = (name: string): name is ToolName => toolNames.has(name);

const sendUserText = (text: string) => {
  if (!realtimeSession || state !== "connected" || !text.trim()) return;
  addLine("user", text);
  setVisualState("thinking");
  realtimeSession.sendMessage(text);
};

const renderConfirmation = (result: Extract<ToolCallResult, { requiresConfirmation: true }>) => {
  if (confirmations.classList.contains("empty")) {
    confirmations.textContent = "";
    confirmations.classList.remove("empty");
  }

  const item = document.createElement("div");
  item.className = "confirmation";
  item.dataset.id = result.confirmationId;
  item.innerHTML = `
    <p>${escapeHtml(result.summary)}</p>
    <div class="confirmActions">
      <button type="button" data-decision="approve">Approve</button>
      <button type="button" data-decision="reject">Reject</button>
    </div>
  `;
  confirmations.prepend(item);
};

type PendingConfirmation = {
  confirmationId: string;
  name: ToolName;
  summary: string;
  expiresAt: string;
};

const reloadPendingConfirmations = async () => {
  const pending = await getJson<PendingConfirmation[]>("/api/tools/pending");
  confirmations.textContent = "";
  confirmations.classList.toggle("empty", pending.length === 0);
  if (!pending.length) {
    confirmations.textContent = "No pending actions";
    return;
  }

  for (const item of pending) {
    renderConfirmation({
      ok: true,
      name: item.name,
      requiresConfirmation: true,
      confirmationId: item.confirmationId,
      summary: item.summary,
      expiresAt: item.expiresAt,
    });
  }
};

const decideConfirmation = async (confirmationId: string, approved: boolean) => {
  const result = await postJson<ConfirmationResult>("/api/tools/confirm", { confirmationId, approved });
  document.querySelector(`[data-id="${confirmationId}"]`)?.remove();
  if (!confirmations.children.length) {
    confirmations.textContent = "No pending actions";
    confirmations.classList.add("empty");
    setVisualState("listening");
  }

  addActivity(approved ? `Approved ${confirmationId}` : `Rejected ${confirmationId}`, approved ? "ok" : "error");
  sendUserText(`Local confirmation result: ${JSON.stringify(result)}`);
};

const setupInputAnalyser = (stream: MediaStream) => {
  audioContext ??= new AudioContext();
  inputAnalyser = audioContext.createAnalyser();
  inputAnalyser.fftSize = 256;
  audioContext.createMediaStreamSource(stream).connect(inputAnalyser);
};

const setupOutputAnalyser = (stream: MediaStream) => {
  audioContext ??= new AudioContext();
  outputAnalyser = audioContext.createAnalyser();
  outputAnalyser.fftSize = 256;
  audioContext.createMediaStreamSource(stream).connect(outputAnalyser);
};

const readLevel = (analyser: AnalyserNode | null) => {
  if (!analyser) return 0;
  const values = new Uint8Array(analyser.frequencyBinCount);
  analyser.getByteTimeDomainData(values);
  let sum = 0;
  for (const value of values) {
    const normalized = (value - 128) / 128;
    sum += normalized * normalized;
  }
  return Math.min(1, Math.sqrt(sum / values.length) * 4);
};

const initOrb = () => {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
  camera.position.set(0, 0, 6);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  orbMount.append(renderer.domElement);

  const uniforms = {
    uTime: { value: 0 },
    uUserLevel: { value: 0 },
    uAiLevel: { value: 0 },
    uStateColor: { value: new THREE.Color("#68e1fd") },
  };

  const material = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    vertexShader: `
      uniform float uTime;
      uniform float uUserLevel;
      uniform float uAiLevel;
      varying vec3 vNormal;
      varying vec3 vPosition;
      void main() {
        vNormal = normalize(normalMatrix * normal);
        vPosition = position;
        float wave = sin(position.y * 7.0 + uTime * 1.7) * 0.05;
        float pulse = 1.0 + uUserLevel * 0.16 + uAiLevel * 0.1;
        vec3 displaced = position * pulse + normal * wave;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(displaced, 1.0);
      }
    `,
    fragmentShader: `
      uniform float uTime;
      uniform float uUserLevel;
      uniform float uAiLevel;
      uniform vec3 uStateColor;
      varying vec3 vNormal;
      varying vec3 vPosition;
      void main() {
        vec3 aqua = vec3(0.16, 0.92, 1.0);
        vec3 coral = vec3(1.0, 0.34, 0.46);
        vec3 violet = vec3(0.54, 0.42, 1.0);
        vec3 gold = vec3(1.0, 0.74, 0.25);
        float flow = sin(vPosition.x * 3.0 + vPosition.y * 4.0 + uTime * (0.6 + uAiLevel * 2.0)) * 0.5 + 0.5;
        vec3 color = mix(aqua, violet, flow);
        color = mix(color, coral, uUserLevel * 0.65);
        color = mix(color, gold, uAiLevel * 0.55);
        color = mix(color, uStateColor, 0.35);
        float fresnel = pow(1.0 - abs(dot(vNormal, vec3(0.0, 0.0, 1.0))), 2.4);
        float alpha = 0.72 + fresnel * 0.28;
        gl_FragColor = vec4(color * (0.82 + fresnel + uAiLevel * 0.45), alpha);
      }
    `,
  });

  const sphere = new THREE.Mesh(new THREE.IcosahedronGeometry(1.55, 64), material);
  scene.add(sphere);

  const halo = new THREE.Mesh(
    new THREE.SphereGeometry(1.9, 64, 64),
    new THREE.MeshBasicMaterial({ color: "#51ddf2", transparent: true, opacity: 0.1, blending: THREE.AdditiveBlending }),
  );
  scene.add(halo);

  const particleGeometry = new THREE.BufferGeometry();
  const particleCount = 420;
  const positions = new Float32Array(particleCount * 3);
  for (let i = 0; i < particleCount; i += 1) {
    const radius = 2.2 + Math.random() * 1.35;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(Math.random() * 2 - 1);
    positions[i * 3] = radius * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = radius * Math.sin(phi) * Math.sin(theta);
    positions[i * 3 + 2] = radius * Math.cos(phi);
  }
  particleGeometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const particles = new THREE.Points(
    particleGeometry,
    new THREE.PointsMaterial({ color: "#d8fff7", size: 0.018, transparent: true, opacity: 0.42, blending: THREE.AdditiveBlending }),
  );
  scene.add(particles);

  const stateColors: Record<VisualState, string> = {
    idle: "#66d9d6",
    listening: "#43f0a8",
    thinking: "#f4c95d",
    speaking: "#ff6289",
    tool: "#9a8cff",
    confirming: "#ff9c55",
    error: "#ff4f5e",
  };

  const resize = () => {
    const rect = orbMount.getBoundingClientRect();
    renderer.setSize(rect.width, rect.height, false);
    camera.aspect = rect.width / Math.max(1, rect.height);
    camera.updateProjectionMatrix();
  };
  resize();
  window.addEventListener("resize", resize);

  const clock = new THREE.Clock();
  const animate = () => {
    requestAnimationFrame(animate);
    userLevel = userLevel * 0.82 + readLevel(inputAnalyser) * 0.18;
    aiLevel = aiLevel * 0.82 + readLevel(outputAnalyser) * 0.18;
    userMeter.style.transform = `scaleX(${Math.max(0.04, userLevel)})`;
    aiMeter.style.transform = `scaleX(${Math.max(0.04, aiLevel)})`;

    const elapsed = clock.getElapsedTime();
    uniforms.uTime.value = elapsed;
    uniforms.uUserLevel.value = userLevel;
    uniforms.uAiLevel.value = aiLevel;
    uniforms.uStateColor.value.lerp(new THREE.Color(stateColors[visualState]), 0.05);
    sphere.rotation.y = elapsed * 0.12;
    sphere.rotation.x = Math.sin(elapsed * 0.28) * 0.08;
    halo.scale.setScalar(1 + userLevel * 0.18 + aiLevel * 0.12);
    (halo.material as THREE.MeshBasicMaterial).opacity = 0.08 + userLevel * 0.22 + aiLevel * 0.16;
    particles.rotation.y = elapsed * (0.025 + userLevel * 0.05);
    particles.rotation.x = elapsed * (0.015 + aiLevel * 0.04);
    renderer.render(scene, camera);
  };
  animate();
};

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[char]!);

document.addEventListener("change", (event) => {
  const input = (event.target as HTMLElement).closest<HTMLInputElement>("input[data-capability]");
  if (!input) return;
  void saveCapabilities({ [input.dataset.capability as CapabilityKey]: input.checked });
});

appGrid.addEventListener("click", async (event) => {
  if (settings?.yoloMode) return;
  const tile = (event.target as HTMLElement).closest<HTMLButtonElement>(".appTile");
  if (!tile?.dataset.bundleId) return;
  tile.disabled = true;
  appPermissions[tile.dataset.bundleId] = !(appPermissions[tile.dataset.bundleId] ?? false);
  renderAppGrid();
  renderAuthorizedApps();
  try {
    await saveAppPermissions();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    onboardingStatus.textContent = `Permission update failed: ${message}`;
    appPermissions[tile.dataset.bundleId] = !(appPermissions[tile.dataset.bundleId] ?? false);
    renderSettings();
  }
});

finishOnboardingBtn.addEventListener("click", async () => {
  await saveAppPermissions();
  showOnboarding(false);
});
onboardingYoloBtn.addEventListener("click", async () => {
  await saveYoloMode(!settings?.yoloMode);
});
refreshAppsBtn.addEventListener("click", () => void refreshApps());
openPermissionsBtn.addEventListener("click", () => showOnboarding(true));
yoloModeBtn.addEventListener("click", () => void saveYoloMode(!settings?.yoloMode));
saveOpenaiKeyBtn.addEventListener("click", () => void saveOpenaiKey());
refreshCodexLoginBtn.addEventListener("click", () => void loadCodexLoginStatus());
startCodexLoginBtn.addEventListener("click", () => void startCodexLogin());
codexModelSelect.addEventListener("change", () => void saveCodexModel());
openaiKeyInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") void saveOpenaiKey();
});
refreshMicrophonesBtn.addEventListener("click", () => void refreshMicrophoneDevices());
microphoneSelect.addEventListener("change", () => {
  selectedMicrophoneId = microphoneSelect.value;
  if (selectedMicrophoneId) {
    window.localStorage.setItem("her:selectedMicrophoneId", selectedMicrophoneId);
    microphoneStatus.textContent = "Selected microphone saved for voice sessions.";
  } else {
    window.localStorage.removeItem("her:selectedMicrophoneId");
    microphoneStatus.textContent = "Using the macOS default input device.";
  }
});
document.addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-settings-pane]");
  if (!button?.dataset.settingsPane) return;
  void openSystemSettingsPane(button.dataset.settingsPane);
});
connectBtn.addEventListener("click", () => void connect());
disconnectBtn.addEventListener("click", disconnect);
sendTextBtn.addEventListener("click", () => {
  sendUserText(textInput.value);
  textInput.value = "";
});
textInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    sendUserText(textInput.value);
    textInput.value = "";
  }
});
confirmations.addEventListener("click", (event) => {
  const target = event.target as HTMLElement;
  const button = target.closest<HTMLButtonElement>("button[data-decision]");
  const item = target.closest<HTMLElement>(".confirmation");
  if (!button || !item?.dataset.id) return;
  void decideConfirmation(item.dataset.id, button.dataset.decision === "approve");
});

setState("idle", "Idle");
void initialize();
