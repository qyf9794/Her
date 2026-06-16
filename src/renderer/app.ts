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
import type { CodingAgentTaskView } from "../shared/agents/coding-agent";
import type { HerArtifact, HerArtifactListResponse } from "../shared/artifacts";
import type { DesktopContextSnapshot } from "../shared/context";
import type { HerTaskView } from "../shared/tasks";
import type { WorkflowPackPreview, WorkflowRun } from "../shared/workflows";
import { buildRealtimeAgentInstructions } from "../shared/realtime-agent";
import {
  createRealtimeSessionConfig,
  realtimeInputTokenBudget,
  realtimeMaxOutputTokens,
  realtimeTranscriptionModel,
  realtimeTurnDetectionTuning,
  type RealtimeRuntimeOptions,
} from "../shared/realtime-config";
import type { ConfirmationResult, ToolCallRequest, ToolCallResult, ToolName } from "../shared/tools";
import { getJson, localApiUrl, postJson, writeAudit } from "./api/local-client";
import { authorizeMusicKit, getMusicKitStatus, pauseAppleMusic, playAppleMusicSong, resumeAppleMusic } from "./music/musickit-player";
import { RealtimeSessionService, type RealtimeToolDefinition } from "./realtime/realtime-session-service";
import { renderAppShell } from "./components/app-shell";
import { getRendererElements } from "./components/dom-elements";
import "./styles.css";

type SessionState = "idle" | "connecting" | "connected" | "error";
type VisualState = "idle" | "listening" | "thinking" | "speaking" | "tool" | "confirming" | "error";

declare global {
  interface Window {
    herWindow?: {
      setOrbOnlyMode: (enabled: boolean) => Promise<unknown>;
    };
  }
}

renderAppShell();

const {
  onboarding,
  appView,
  onboardingStatus,
  appGrid,
  onboardingCapabilities,
  runtimeCapabilities,
  authorizedApps,
  statusText,
  contextApp,
  contextWindow,
  contextClipboard,
  contextRecentFiles,
  connectBtn,
  disconnectBtn,
  orbOnlyBtn,
  restorePanelBtn,
  sendTextBtn,
  textInput,
  transcript,
  miniPlayer,
  miniPlayerArtwork,
  miniPlayerTitle,
  miniPlayerArtist,
  miniPlayerPlayBtn,
  miniPlayerPauseBtn,
  confirmations,
  activity,
  resultWindow,
  resultWindowTitle,
  resultWindowSubtitle,
  resultWindowBody,
  resultWindowCloseBtn,
  orbMount,
  siriInfoPanel,
  siriModeLabel,
  siriVoiceLevel,
  siriUserText,
  siriReplyText,
  glassReply,
  glassReplyText,
  userMeter,
  aiMeter,
  finishOnboardingBtn,
  onboardingYoloBtn,
  refreshAppsBtn,
  openPermissionsBtn,
  manageAppsBtn,
  yoloModeBtn,
  yoloModeStatus,
  openaiKeyInput,
  saveOpenaiKeyBtn,
  openaiKeyStatus,
  openaiKeyBadge,
  betaSetupBadge,
  betaSetupList,
  betaFeedbackInput,
  exportDiagnosticsBtn,
  exportFeedbackBtn,
  diagnosticsStatus,
  realtimeVoiceSelect,
  realtimeVoiceStatus,
  realtimeVoiceBadge,
  musicKitBadge,
  musicKitStatus,
  appleMusicKeyNameInput,
  appleMusicTeamIdInput,
  appleMusicKeyIdInput,
  appleMusicPrivateKeyPathInput,
  saveAppleMusicConfigBtn,
  authorizeMusicKitBtn,
  codexLoginBadge,
  codexLoginStatus,
  refreshCodexLoginBtn,
  startCodexLoginBtn,
  codexLoginOutput,
  codexModelSelect,
  codexModelStatus,
  refreshTasksBtn,
  taskRuns,
  refreshWorkflowsBtn,
  workflowPacks,
  refreshArtifactsBtn,
  artifactList,
  refreshAgentRunsBtn,
  agentRuns,
  microphoneSelect,
  refreshMicrophonesBtn,
  microphoneStatus,
  realtimeUsage,
} = getRendererElements();

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
let realtimeSessionService: RealtimeSessionService | null = null;
let localStream: MediaStream | null = null;
let micPreviewStream: MediaStream | null = null;
let micPreviewPointerId: number | null = null;
let micPreviewHoldTimer: number | undefined;
let audioContext: AudioContext | null = null;
let inputAnalyser: AnalyserNode | null = null;
let outputAnalyser: AnalyserNode | null = null;
let userLevel = 0;
let aiLevel = 0;
let hasOpenaiApiKey = false;
let selectedMicrophoneId = window.localStorage.getItem("her:selectedMicrophoneId") ?? "";
let isOrbOnly = window.localStorage.getItem("her:orbOnly") === "true";
let musicPlaybackPoll: number | undefined;
let contextPoll: number | undefined;
let currentMiniPlayerTrack: MiniPlayerTrack | undefined;
let taskRunsPoll: number | undefined;
let workflowRunsPoll: number | undefined;
let artifactsPoll: number | undefined;
let agentRunsPoll: number | undefined;
let codexLoginConfigured = false;
let workflowPackCount = 0;
const displayedTaskResultKeys = new Set<string>();
const watchedQueuedTaskIds = new Set<string>();
let microphoneCheckStatus: "unknown" | "available" | "unavailable" =
  typeof navigator.mediaDevices?.getUserMedia === "function" ? "available" : "unavailable";

type MiniPlayerTrack = {
  id: string;
  title?: string;
  artist?: string;
  album?: string;
  artworkUrl?: string;
  state: "playing" | "paused" | "requested";
};

type OrbPosition = { left: number; top: number };

const readStoredOrbPosition = (): OrbPosition | null => {
  try {
    const value = JSON.parse(window.localStorage.getItem("her:orbPosition") ?? "null") as Partial<OrbPosition> | null;
    if (!value || typeof value.left !== "number" || typeof value.top !== "number") return null;
    return { left: value.left, top: value.top };
  } catch {
    return null;
  }
};

let orbPosition: OrbPosition | null = readStoredOrbPosition();

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

const initialize = async () => {
  renderRealtimeUsage();
  showOnboarding(false);
  setState("idle", "Loading local backend...");
  addLine("system", "Loading Her local runtime...");
  initOrb();

  try {
    settings = await getJson<UserSettings>("/api/settings");
    renderSettings();
    showOnboarding(!settings.hasCompletedOnboarding);
    void loadStartupData();
    addLine("system", "Start voice, then ask me to manage files, documents, drafts, email, calendar, music, apps, browser tasks, or safe shell commands.");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const detail = localRuntimeUnavailableDetail(message);
    onboardingStatus.textContent = message;
    renderOpenaiKeyStatus(false, detail);
    renderMusicKitStatus(false, detail);
    renderCodexLoginStatus({ configured: false, label: "Error", detail });
    codexModelStatus.textContent = detail;
    statusText.textContent = detail;
    showOnboarding(false);
    addLine("system", `Local backend unavailable: ${message}`);
    setVisualState("error");
  }
};

const loadStartupData = async () => {
  await Promise.allSettled([
    loadOpenaiKeyStatus(),
    loadRealtimeVoice(),
    loadAppleMusicConfig(),
    loadMusicKitStatus(),
    loadCodexLoginStatus(),
    loadCodexModel(),
    loadDesktopContext(),
    loadTaskRuns(),
    loadWorkflowPacks(),
    loadArtifacts(),
    loadAgentRuns(),
    loadInstalledApps(),
  ]);

  startContextPolling();
  startTaskRunsPolling();
  startWorkflowRunsPolling();
  startArtifactsPolling();
  startAgentRunsPolling();
  startMusicPlaybackRequestPolling();
};

const loadInstalledApps = async () => {
  try {
    installedApps = await getJson<InstalledApp[]>("/api/apps");
    appPermissions = Object.fromEntries(installedApps.map((item) => [item.bundleId, item.authorized]));
    renderSettings();
    onboardingStatus.textContent = `${installedApps.length} local apps found. Recommended low-risk apps are preselected.`;
  } catch (error) {
    onboardingStatus.textContent = `Application inventory unavailable: ${errorMessage(error)}`;
    renderSettings();
  }
};

const showOnboarding = (visible: boolean) => {
  onboarding.classList.toggle("hidden", !visible);
  appView.classList.toggle("hidden", visible);
  onboardingStatus.textContent = `${installedApps.length} local apps found. Recommended low-risk apps are preselected.`;
  if (!visible) requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const orbOnlySize = 180;

const defaultOrbPosition = (): OrbPosition => ({
  left: Math.round((window.innerWidth - orbOnlySize) / 2),
  top: Math.round((window.innerHeight - orbOnlySize) / 2),
});

const clampOrbPosition = (position: OrbPosition): OrbPosition => {
  const rect = orbMount.parentElement?.getBoundingClientRect();
  const width = rect?.width || orbOnlySize;
  const height = rect?.height || orbOnlySize;
  return {
    left: clamp(position.left, 10, Math.max(10, window.innerWidth - width - 10)),
    top: clamp(position.top, 10, Math.max(10, window.innerHeight - height - 10)),
  };
};

const renderOrbPosition = () => {
  const next = clampOrbPosition(orbPosition ?? defaultOrbPosition());
  orbPosition = next;
  appView.style.setProperty("--orb-left", `${next.left}px`);
  appView.style.setProperty("--orb-top", `${next.top}px`);
};

const setOrbOnlyMode = (enabled: boolean) => {
  isOrbOnly = enabled;
  window.localStorage.setItem("her:orbOnly", String(enabled));
  document.documentElement.classList.toggle("orbOnlyActive", enabled);
  appView.classList.toggle("orbOnly", enabled);
  document.body.classList.toggle("orbOnlyActive", enabled);
  orbOnlyBtn.textContent = enabled ? "Show panel" : "Orb only";
  restorePanelBtn.hidden = !enabled;
  if (enabled) renderOrbPosition();
  void window.herWindow?.setOrbOnlyMode(enabled).then(() => window.dispatchEvent(new Event("resize"))).catch(() => undefined);
  requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
};

let activeOrbDrag:
  | {
      pointerId: number;
      offsetX: number;
      offsetY: number;
    }
  | null = null;

const startOrbDrag = (event: PointerEvent) => {
  if (!isOrbOnly || (event.target as HTMLElement).closest("button")) return;
  const panel = orbMount.parentElement;
  if (!panel) return;
  const rect = panel.getBoundingClientRect();
  activeOrbDrag = {
    pointerId: event.pointerId,
    offsetX: event.clientX - rect.left,
    offsetY: event.clientY - rect.top,
  };
  panel.classList.add("dragging");
  panel.setPointerCapture(event.pointerId);
};

const moveOrbDrag = (event: PointerEvent) => {
  if (!activeOrbDrag || event.pointerId !== activeOrbDrag.pointerId) return;
  orbPosition = clampOrbPosition({
    left: event.clientX - activeOrbDrag.offsetX,
    top: event.clientY - activeOrbDrag.offsetY,
  });
  renderOrbPosition();
};

const endOrbDrag = (event: PointerEvent) => {
  if (!activeOrbDrag || event.pointerId !== activeOrbDrag.pointerId) return;
  const panel = orbMount.parentElement;
  panel?.classList.remove("dragging");
  if (panel?.hasPointerCapture(event.pointerId)) panel.releasePointerCapture(event.pointerId);
  activeOrbDrag = null;
  if (orbPosition) window.localStorage.setItem("her:orbPosition", JSON.stringify(orbPosition));
};

const renderSettings = () => {
  if (!settings) return;
  renderYoloMode();
  renderCapabilityControls(onboardingCapabilities, false);
  renderCapabilityControls(runtimeCapabilities, true);
  renderAppGrid();
  renderAuthorizedApps();
  renderBetaSetup();
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

const iconSrc = (item: InstalledApp) => localApiUrl(item.iconUrl);

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

type RealtimeVoiceStatus = {
  voice: string;
  options: Array<{ label: string; value: string; recommended?: boolean }>;
  note?: string;
};

type AppleMusicConfigStatus = {
  keyName: string;
  teamId: string;
  keyId: string;
  privateKeyPath: string;
  configured: boolean;
};

type LocalExportResponse = {
  path: string;
  filename: string;
  bytes: number;
  payload?: unknown;
};

const renderBetaSetup = () => {
  const items = [
    {
      done: hasOpenaiApiKey,
      title: "OpenAI key",
      detail: hasOpenaiApiKey ? "Voice sessions can request Realtime access." : "Paste a key and press Save.",
    },
    {
      done: microphoneCheckStatus === "available",
      title: "Microphone",
      detail: microphoneCheckStatus === "available" ? "System audio input is available." : "Open macOS Microphone settings or reconnect an input.",
    },
    {
      done: Boolean(settings?.hasCompletedOnboarding),
      title: "Permissions",
      detail: settings?.hasCompletedOnboarding ? "App and capability preferences are saved." : "Review capabilities and authorized apps.",
    },
    {
      done: codexLoginConfigured,
      title: "Codex login",
      detail: codexLoginConfigured ? "Coding tasks can use Codex." : "Start login before using coding-agent tasks.",
    },
    {
      done: workflowPackCount > 0,
      title: "First workflow",
      detail: workflowPackCount > 0 ? `${workflowPackCount} workflow packs are ready.` : "Refresh workflow packs, then preview one before running.",
    },
  ];

  const completed = items.filter((item) => item.done).length;
  betaSetupBadge.textContent = `${completed}/${items.length}`;
  betaSetupBadge.classList.toggle("configured", completed === items.length);
  betaSetupList.innerHTML = items
    .map(
      (item) => `
        <div class="setupItem ${item.done ? "done" : ""}">
          <span>${item.done ? "✓" : "!"}</span>
          <div>
            <strong>${escapeHtml(item.title)}</strong>
            <small>${escapeHtml(item.detail)}</small>
          </div>
        </div>
      `,
    )
    .join("");
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
  renderBetaSetup();
};

const renderCodexLoginStatus = (status: Pick<CodexLoginStatus, "configured" | "label" | "detail">) => {
  codexLoginConfigured = status.configured;
  codexLoginBadge.textContent = status.label;
  codexLoginBadge.classList.toggle("configured", status.configured);
  codexLoginBadge.classList.toggle("error", status.label.toLowerCase() === "error");
  codexLoginStatus.textContent = status.detail;
  startCodexLoginBtn.disabled = status.configured;
  renderBetaSetup();
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

const renderRealtimeVoice = (status: RealtimeVoiceStatus, message?: string) => {
  const options = [...status.options];
  if (status.voice && !options.some((item) => item.value === status.voice)) {
    options.push({ label: status.voice, value: status.voice });
  }

  realtimeVoiceSelect.innerHTML = "";
  for (const option of options) {
    const item = document.createElement("option");
    item.value = option.value;
    item.textContent = option.recommended ? `${option.label} - recommended` : option.label;
    realtimeVoiceSelect.append(item);
  }
  realtimeVoiceSelect.value = status.voice;
  realtimeVoiceBadge.textContent = status.voice || "Voice";
  realtimeVoiceStatus.textContent =
    message ??
    (state === "connected"
      ? `${status.voice} is saved. Stop and start voice to use it.`
      : (status.note ?? "Voice changes apply to the next session."));
};

const loadRealtimeVoice = async () => {
  try {
    renderRealtimeVoice(await getJson<RealtimeVoiceStatus>("/api/realtime/voice"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    realtimeVoiceStatus.textContent = `Voice status failed: ${message}`;
  }
};

const saveRealtimeVoice = async () => {
  const voice = realtimeVoiceSelect.value;
  realtimeVoiceSelect.disabled = true;
  realtimeVoiceStatus.textContent = `Saving ${voice}...`;
  try {
    renderRealtimeVoice(
      await postJson<RealtimeVoiceStatus>("/api/realtime/voice", { voice }),
      state === "connected" ? `${voice} is saved. Stop and start voice to use it.` : `${voice} will be used for the next voice session.`,
    );
    addActivity(`Realtime voice set to ${voice}`, "ok");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    realtimeVoiceStatus.textContent = message;
    addActivity(`Realtime voice update failed: ${message}`, "error");
    await loadRealtimeVoice();
  } finally {
    realtimeVoiceSelect.disabled = false;
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

const startContextPolling = () => {
  if (contextPoll) return;
  contextPoll = window.setInterval(() => void loadDesktopContext(), 5000);
};

const loadDesktopContext = async () => {
  try {
    renderDesktopContext(await getJson<DesktopContextSnapshot>("/api/context/snapshot"));
  } catch (error) {
    contextApp.textContent = "Unavailable";
    contextWindow.textContent = errorMessage(error);
    contextClipboard.textContent = "Unknown";
    contextRecentFiles.textContent = "0 files";
  }
};

const renderDesktopContext = (snapshot: DesktopContextSnapshot) => {
  contextApp.textContent = snapshot.frontmost.appName ?? labelForContextStatus(snapshot.frontmost.status);
  contextWindow.textContent = snapshot.frontmost.windowTitle ?? snapshot.frontmost.reason ?? labelForContextStatus(snapshot.frontmost.status);
  contextClipboard.textContent = snapshot.clipboard.redacted
    ? "Redacted"
    : snapshot.clipboard.status === "available"
      ? `${snapshot.clipboard.chars} chars`
      : labelForContextStatus(snapshot.clipboard.status);
  contextRecentFiles.textContent = `${snapshot.recentFiles.length} ${snapshot.recentFiles.length === 1 ? "file" : "files"}`;
};

const labelForContextStatus = (status: string) => {
  if (status === "available") return "Available";
  if (status === "redacted") return "Redacted";
  if (status === "unsupported") return "Unsupported";
  if (status === "unavailable") return "Unavailable";
  return "Empty";
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

const startTaskRunsPolling = () => {
  if (taskRunsPoll) return;
  taskRunsPoll = window.setInterval(() => void loadTaskRuns(), 2000);
};

const loadTaskRuns = async () => {
  try {
    const response = await getJson<{ tasks: HerTaskView[] }>("/api/tasks?limit=10");
    maybeShowCompletedTaskDisplay(response.tasks);
    renderTaskRuns(response.tasks);
  } catch (error) {
    taskRuns.textContent = `Tasks unavailable: ${errorMessage(error)}`;
    taskRuns.classList.add("empty");
  }
};

const maybeShowCompletedTaskDisplay = (tasks: HerTaskView[]) => {
  for (const task of tasks) {
    if (task.status !== "completed" || !task.result) continue;
    const display = findToolDisplay(task.result);
    if (!display) continue;
    const resultKey = `${task.id}:${task.updatedAt}`;
    if (displayedTaskResultKeys.has(resultKey)) continue;
    displayedTaskResultKeys.add(resultKey);
    renderToolDisplay(display);
    addActivity(`${task.toolName ?? task.title} result displayed`, "ok");
    return;
  }
};

const startArtifactsPolling = () => {
  if (artifactsPoll) return;
  artifactsPoll = window.setInterval(() => void loadArtifacts(), 3000);
};

const loadArtifacts = async () => {
  try {
    const response = await getJson<HerArtifactListResponse>("/api/artifacts?limit=8");
    renderArtifacts(response.artifacts);
  } catch (error) {
    artifactList.textContent = `Artifacts unavailable: ${errorMessage(error)}`;
    artifactList.classList.add("empty");
  }
};

const renderArtifacts = (artifacts: HerArtifact[]) => {
  artifactList.textContent = "";
  artifactList.classList.toggle("empty", artifacts.length === 0);
  if (!artifacts.length) {
    artifactList.textContent = "No artifacts yet";
    return;
  }

  for (const artifact of artifacts) {
    const item = document.createElement("article");
    item.className = `artifactItem ${artifact.type}`;
    item.dataset.artifactId = artifact.id;
    item.innerHTML = `
      <div class="artifactHeader">
        <strong>${escapeHtml(artifact.title)}</strong>
        <span>${escapeHtml(artifact.type.replaceAll("_", " "))}</span>
      </div>
      <p>${escapeHtml(truncateText(artifact.summary, 180))}</p>
      <div class="artifactMeta">
        <span>${escapeHtml(artifact.id.slice(0, 8))}</span>
        ${artifact.sourceTaskId ? `<span>task ${escapeHtml(artifact.sourceTaskId.slice(0, 8))}</span>` : ""}
        ${artifact.sourceTool ? `<span>${escapeHtml(artifact.sourceTool)}</span>` : ""}
        ${artifact.truncated ? "<span>truncated</span>" : ""}
      </div>
      <div class="artifactActions">
        <button type="button" data-artifact-action="show">Show</button>
        <button type="button" data-artifact-action="copy-summary">Copy Summary</button>
      </div>
    `;
    artifactList.append(item);
  }
};

const showArtifact = async (artifactId: string) => {
  const response = await getJson<{ artifact: HerArtifact }>(`/api/artifacts/${encodeURIComponent(artifactId)}`);
  renderArtifactWindow(response.artifact);
};

const copyArtifactSummary = async (artifactId: string) => {
  const response = await getJson<{ artifact: HerArtifact }>(`/api/artifacts/${encodeURIComponent(artifactId)}`);
  await navigator.clipboard.writeText(response.artifact.summary);
  addActivity(`Copied artifact summary ${artifactId}`, "ok");
};

const renderArtifactWindow = (artifact: HerArtifact) => {
  resultWindowTitle.textContent = artifact.title;
  resultWindowSubtitle.textContent = [artifact.type.replaceAll("_", " "), artifact.sourceTool, new Date(artifact.createdAt).toLocaleString()]
    .filter(Boolean)
    .join(" · ");
  resultWindowBody.innerHTML = renderArtifactBody(artifact);
  resultWindow.classList.remove("hidden");
};

const renderArtifactBody = (artifact: HerArtifact) => {
  const summary = `<p class="resultNote">${escapeHtml(artifact.summary)}</p>`;
  if (artifact.type === "table") return `${summary}${renderArtifactTable(artifact.payload)}`;
  if (artifact.type === "diff") return `${summary}<pre class="artifactPre diff">${escapeHtml(payloadToText(artifact.payload))}</pre>`;
  if (artifact.type === "command_output") return `${summary}<pre class="artifactPre command">${escapeHtml(commandOutputToText(artifact.payload))}</pre>`;
  return `${summary}<pre class="artifactPre">${escapeHtml(payloadToText(artifact.payload))}</pre>`;
};

const renderArtifactTable = (payload: unknown) => {
  const rows = Array.isArray(payload) ? payload.slice(0, 40) : [];
  if (!rows.length) return `<p class="resultEmpty">No table rows.</p>`;
  const columns = Object.keys(rows.find((row) => row && typeof row === "object" && !Array.isArray(row)) ?? {}).slice(0, 6);
  if (!columns.length) return `<pre class="artifactPre">${escapeHtml(payloadToText(rows))}</pre>`;
  return `
    <table class="artifactTable">
      <thead><tr>${columns.map((column) => `<th>${escapeHtml(column)}</th>`).join("")}</tr></thead>
      <tbody>
        ${rows.map((row) => `
          <tr>${columns.map((column) => `<td>${escapeHtml(String((row as Record<string, unknown>)[column] ?? ""))}</td>`).join("")}</tr>
        `).join("")}
      </tbody>
    </table>
  `;
};

const commandOutputToText = (payload: unknown) => {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payloadToText(payload);
  const value = payload as Record<string, unknown>;
  return [
    `$ ${String(value.command ?? "")}`,
    `exitCode: ${String(value.exitCode ?? "")}`,
    value.stdout ? `\nstdout:\n${String(value.stdout)}` : "",
    value.stderr ? `\nstderr:\n${String(value.stderr)}` : "",
  ].filter(Boolean).join("\n");
};

const payloadToText = (payload: unknown) => {
  if (typeof payload === "string") return payload;
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return String(payload);
  }
};

const renderTaskRuns = (tasks: HerTaskView[]) => {
  taskRuns.textContent = "";
  taskRuns.classList.toggle("empty", tasks.length === 0);
  if (!tasks.length) {
    taskRuns.textContent = "No active tasks";
    return;
  }

  for (const task of tasks) {
    const item = document.createElement("article");
    item.className = `agentRun ${task.status}`;
    const latest = task.events.at(-1);
    const canCancel = task.status === "queued" || task.status === "blocked" || task.status === "awaiting_confirmation" || task.status === "running";
    item.innerHTML = `
      <div class="agentRunHeader">
        <strong>${escapeHtml(task.kind)} · ${escapeHtml(task.status)}</strong>
        ${canCancel ? `<button type="button" data-task-cancel="${escapeHtml(task.id)}">Cancel</button>` : ""}
      </div>
      <p>${escapeHtml(truncateText(task.summary, 180))}</p>
      <div class="agentRunMeta">
        <span>${escapeHtml(task.id.slice(0, 8))}</span>
        ${task.toolName ? `<span>${escapeHtml(task.toolName)}</span>` : ""}
        ${task.confirmationId ? `<span>confirm ${escapeHtml(task.confirmationId.slice(0, 8))}</span>` : ""}
      </div>
      ${task.progress?.message ? `<p class="agentRunEvent">${escapeHtml(task.progress.message)}</p>` : ""}
      ${latest && "message" in latest ? `<p class="agentRunEvent">${escapeHtml(String(latest.message))}</p>` : ""}
      ${task.error?.message ? `<p class="agentRunError">${escapeHtml(task.error.message)}</p>` : ""}
    `;
    taskRuns.append(item);
  }
};

const cancelTaskRun = async (taskId: string) => {
  try {
    await postJson(`/api/tasks/${encodeURIComponent(taskId)}/cancel`, {});
    await loadTaskRuns();
  } catch (error) {
    addActivity(`Task cancel failed: ${errorMessage(error)}`, "error");
  }
};

type WorkflowPackSummary = {
  id: string;
  title: string;
  description: string;
  triggers: string[];
  requiredCapabilities: string[];
  risks: string[];
  stepCount: number;
  rollbackNotes: string[];
};

const startWorkflowRunsPolling = () => {
  if (workflowRunsPoll) return;
  workflowRunsPoll = window.setInterval(() => void loadWorkflowPacks(), 4000);
};

const executeWorkflowTool = async <T>(name: ToolName, args: Record<string, unknown>) => {
  const response = await postJson<ToolCallResult>("/api/tools/execute", { name, source: "local", arguments: args });
  if (!response.ok) throw new Error(response.error);
  if (response.requiresConfirmation) throw new Error(`Workflow tool ${name} unexpectedly requires confirmation.`);
  return response.result as T;
};

const loadWorkflowPacks = async () => {
  try {
    const [packResult, runResult] = await Promise.all([
      executeWorkflowTool<{ packs: WorkflowPackSummary[] }>("workflow_pack_list", {}),
      executeWorkflowTool<{ runs: WorkflowRun[] }>("workflow_run_list", { limit: 5 }),
    ]);
    workflowPackCount = packResult.packs.length;
    renderBetaSetup();
    renderWorkflowPacks(packResult.packs, runResult.runs);
  } catch (error) {
    workflowPackCount = 0;
    renderBetaSetup();
    workflowPacks.textContent = `Workflow packs unavailable: ${errorMessage(error)}`;
    workflowPacks.classList.add("empty");
  }
};

const renderWorkflowPacks = (packs: WorkflowPackSummary[], runs: WorkflowRun[]) => {
  workflowPacks.textContent = "";
  workflowPacks.classList.toggle("empty", packs.length === 0);
  if (!packs.length) {
    workflowPacks.textContent = "No workflow packs loaded";
    return;
  }

  for (const pack of packs) {
    const item = document.createElement("article");
    item.className = "agentRun";
    item.innerHTML = `
      <div class="agentRunHeader">
        <strong>${escapeHtml(pack.title)}</strong>
        <span>
          <button type="button" data-workflow-preview="${escapeHtml(pack.id)}">Preview</button>
          <button type="button" data-workflow-run="${escapeHtml(pack.id)}">Run</button>
        </span>
      </div>
      <p>${escapeHtml(pack.description)}</p>
      <div class="agentRunMeta">
        <span>${pack.stepCount} steps</span>
        <span>${escapeHtml(pack.requiredCapabilities.join(", "))}</span>
        <span>${escapeHtml(pack.risks.join(", "))}</span>
      </div>
    `;
    workflowPacks.append(item);
  }

  for (const run of runs) {
    const item = document.createElement("article");
    item.className = `agentRun ${run.status}`;
    const latest = run.events.at(-1);
    item.innerHTML = `
      <div class="agentRunHeader">
        <strong>${escapeHtml(run.title)} · ${escapeHtml(run.status)}</strong>
        ${run.status === "running" || run.status === "awaiting_confirmation" ? `<button type="button" data-workflow-cancel="${escapeHtml(run.id)}">Cancel</button>` : ""}
      </div>
      <div class="agentRunMeta">
        <span>${escapeHtml(run.id.slice(0, 8))}</span>
        <span>${run.steps.filter((step) => step.status === "completed").length}/${run.steps.length} complete</span>
        ${run.steps.some((step) => step.confirmationId) ? `<span>waiting confirmation</span>` : ""}
      </div>
      ${latest ? `<p class="agentRunEvent">${escapeHtml(latest.message)}</p>` : ""}
      ${run.error ? `<p class="agentRunError">${escapeHtml(run.error)}</p>` : ""}
      <button type="button" data-workflow-status="${escapeHtml(run.id)}">Status</button>
    `;
    workflowPacks.append(item);
  }
};

const previewWorkflowPack = async (packId: string) => {
  try {
    const result = await executeWorkflowTool<{ preview: WorkflowPackPreview }>("workflow_pack_preview", { packId });
    renderWorkflowPreviewWindow(result.preview);
  } catch (error) {
    addActivity(`Workflow preview failed: ${errorMessage(error)}`, "error");
  }
};

const runWorkflowPack = async (packId: string) => {
  try {
    const result = await executeWorkflowTool<{ run: WorkflowRun }>("workflow_pack_run", { packId });
    addActivity(`${result.run.title} is ${result.run.status}`, result.run.status === "failed" ? "error" : "pending");
    renderWorkflowRunWindow(result.run);
    await loadWorkflowPacks();
  } catch (error) {
    addActivity(`Workflow run failed: ${errorMessage(error)}`, "error");
  }
};

const showWorkflowRun = async (runId: string) => {
  try {
    const result = await executeWorkflowTool<{ run: WorkflowRun }>("workflow_run_status", { runId });
    renderWorkflowRunWindow(result.run);
  } catch (error) {
    addActivity(`Workflow status failed: ${errorMessage(error)}`, "error");
  }
};

const cancelWorkflowRun = async (runId: string) => {
  try {
    await executeWorkflowTool<{ run: WorkflowRun; cancelled: boolean }>("workflow_run_cancel", { runId });
    await loadWorkflowPacks();
  } catch (error) {
    addActivity(`Workflow cancel failed: ${errorMessage(error)}`, "error");
  }
};

const renderWorkflowPreviewWindow = (preview: WorkflowPackPreview) => {
  resultWindowTitle.textContent = preview.title;
  resultWindowSubtitle.textContent = [preview.requiredCapabilities.join(", "), preview.risks.join(", ")].filter(Boolean).join(" · ");
  resultWindowBody.innerHTML = `
    <p class="resultNote">${escapeHtml(preview.description)}</p>
    <section class="resultItems">
      ${preview.steps.map((step) => `
        <article class="resultItem">
          <h3>${escapeHtml(step.title)}</h3>
          <p>${escapeHtml(step.summary)}</p>
          <div class="resultMeta">
            <span>${escapeHtml(step.toolName)}</span>
            <span>${escapeHtml(step.riskLabel)}</span>
            ${step.requiresConfirmation ? `<span>confirmation</span>` : ""}
          </div>
          ${step.rollbackNote ? `<p class="resultSubtitle">${escapeHtml(step.rollbackNote)}</p>` : ""}
        </article>
      `).join("")}
    </section>
    <p class="resultNote">${escapeHtml(preview.rollbackNotes.join(" "))}</p>
  `;
  resultWindow.classList.remove("hidden");
};

const renderWorkflowRunWindow = (run: WorkflowRun) => {
  resultWindowTitle.textContent = `${run.title} · ${run.status}`;
  resultWindowSubtitle.textContent = [run.id.slice(0, 8), new Date(run.updatedAt).toLocaleString()].join(" · ");
  resultWindowBody.innerHTML = `
    <section class="resultItems">
      ${run.steps.map((step) => `
        <article class="resultItem">
          <h3>${escapeHtml(step.title)} · ${escapeHtml(step.status)}</h3>
          <p>${escapeHtml(step.summary)}</p>
          <div class="resultMeta">
            <span>${escapeHtml(step.toolName)}</span>
            <span>${escapeHtml(step.risk)}</span>
            ${step.confirmationId ? `<span>confirm ${escapeHtml(step.confirmationId.slice(0, 8))}</span>` : ""}
            ${step.childTaskId ? `<span>task ${escapeHtml(step.childTaskId.slice(0, 8))}</span>` : ""}
          </div>
          ${step.error ? `<p class="agentRunError">${escapeHtml(step.error)}</p>` : ""}
        </article>
      `).join("")}
    </section>
    <section class="resultItems">
      ${run.events.map((event) => `
        <article class="resultItem">
          <h3>${escapeHtml(event.type)}</h3>
          <p>${escapeHtml(event.message)}</p>
          <div class="resultMeta"><span>${escapeHtml(new Date(event.timestamp).toLocaleTimeString())}</span></div>
        </article>
      `).join("")}
    </section>
  `;
  resultWindow.classList.remove("hidden");
};

const startAgentRunsPolling = () => {
  if (agentRunsPoll) return;
  agentRunsPoll = window.setInterval(() => void loadAgentRuns(), 2500);
};

const loadAgentRuns = async () => {
  try {
    const response = await getJson<{ tasks: CodingAgentTaskView[] }>("/api/agents/coding/tasks?limit=8");
    renderAgentRuns(response.tasks);
  } catch (error) {
    agentRuns.textContent = `Agent runs unavailable: ${errorMessage(error)}`;
    agentRuns.classList.add("empty");
  }
};

const renderAgentRuns = (tasks: CodingAgentTaskView[]) => {
  agentRuns.textContent = "";
  agentRuns.classList.toggle("empty", tasks.length === 0);
  if (!tasks.length) {
    agentRuns.textContent = "No coding agent runs";
    return;
  }

  for (const task of tasks) {
    const item = document.createElement("article");
    item.className = `agentRun ${task.status}`;
    const latest = task.events.at(-1);
    const branch = task.branch ? `<span>${escapeHtml(task.branch)}</span>` : "";
    const result = task.resultText ? `<p>${escapeHtml(truncateText(task.resultText, 220))}</p>` : "";
    const cancel = task.status === "queued" || task.status === "running"
      ? `<button type="button" data-agent-cancel="${escapeHtml(task.id)}">Cancel</button>`
      : "";
    const review = task.review
      ? `<button type="button" data-agent-review="${escapeHtml(task.id)}">Review</button>`
      : "";
    const apply = task.review?.applyAvailable
      ? `<button type="button" data-agent-apply="${escapeHtml(task.id)}">Apply</button>`
      : "";
    item.innerHTML = `
      <div class="agentRunHeader">
        <strong>${escapeHtml(task.mode)} · ${escapeHtml(task.status)}</strong>
        <div class="agentRunActions">${review}${apply}${cancel}</div>
      </div>
      <p>${escapeHtml(truncateText(task.prompt, 180))}</p>
      <div class="agentRunMeta">
        <span>${escapeHtml(task.id.slice(0, 8))}</span>
        ${branch}
        ${task.worktreePath ? `<span>${escapeHtml(task.worktreePath)}</span>` : ""}
        ${task.review ? `<span>${task.review.changedFiles.length} changed</span>` : ""}
        ${task.appliedAt ? `<span>applied</span>` : ""}
      </div>
      ${latest ? `<p class="agentRunEvent">${escapeHtml(latest.message)}</p>` : ""}
      ${task.error ? `<p class="agentRunError">${escapeHtml(task.error)}</p>` : ""}
      ${result}
    `;
    agentRuns.append(item);
  }
};

const showAgentReview = async (taskId: string) => {
  try {
    const response = await getJson<{ task: CodingAgentTaskView }>(`/api/agents/coding/tasks/${encodeURIComponent(taskId)}`);
    const task = response.task;
    if (!task.review) {
      addActivity(`No Codex review is available for ${taskId}`, "error");
      return;
    }
    resultWindowTitle.textContent = `Codex Review · ${task.id.slice(0, 8)}`;
    resultWindowSubtitle.textContent = [task.mode, task.status, task.branch].filter(Boolean).join(" · ");
    resultWindowBody.innerHTML = renderAgentReviewBody(task);
    resultWindow.classList.remove("hidden");
  } catch (error) {
    addActivity(`Load Codex review failed: ${errorMessage(error)}`, "error");
  }
};

const renderAgentReviewBody = (task: CodingAgentTaskView) => {
  const review = task.review;
  if (!review) return `<p class="resultEmpty">No review is available.</p>`;
  return `
    <p class="resultNote">${escapeHtml(review.summary)}</p>
    <table class="artifactTable">
      <thead><tr><th>Status</th><th>Path</th></tr></thead>
      <tbody>
        ${review.changedFiles.map((file) => `<tr><td>${escapeHtml(file.status)}</td><td>${escapeHtml(file.path)}</td></tr>`).join("")}
      </tbody>
    </table>
    ${review.tests.length ? `<h3>Tests</h3><pre class="artifactPre">${escapeHtml(review.tests.join("\n"))}</pre>` : ""}
    ${review.followUps.length ? `<h3>Follow-ups</h3><pre class="artifactPre">${escapeHtml(review.followUps.join("\n"))}</pre>` : ""}
    <h3>Diff</h3>
    <pre class="artifactPre diff">${escapeHtml(review.diffPreview || "No diff preview.")}</pre>
  `;
};

const applyAgentRun = async (taskId: string) => {
  try {
    const result = await postJson<ToolCallResult>("/api/tools/execute", {
      name: "coding_agent_apply_to_repo",
      source: "local",
      arguments: { taskId },
    });
    if (result.ok && "requiresConfirmation" in result && result.requiresConfirmation) {
      addActivity(`Codex apply requires confirmation: ${result.summary}`, "pending");
      renderConfirmationWindow([result]);
      await reloadPendingConfirmations({ showWindow: true });
      return;
    }
    if (result.ok) {
      addActivity(`Codex apply completed for ${taskId}`, "ok");
      await loadAgentRuns();
      await loadArtifacts();
      return;
    }
    addActivity(`Codex apply failed: ${result.error}`, "error");
  } catch (error) {
    addActivity(`Codex apply failed: ${errorMessage(error)}`, "error");
  }
};

const cancelAgentRun = async (taskId: string) => {
  try {
    await postJson(`/api/agents/coding/tasks/${encodeURIComponent(taskId)}/cancel`, {});
    await loadAgentRuns();
  } catch (error) {
    addActivity(`Agent cancel failed: ${errorMessage(error)}`, "error");
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

const showLocalExportResult = (title: string, result: LocalExportResponse) => {
  diagnosticsStatus.textContent = `Saved ${result.filename} (${result.bytes} bytes).`;
  resultWindowTitle.textContent = title;
  resultWindowSubtitle.textContent = result.filename;
  resultWindowBody.innerHTML = `
    <p class="resultNote">Saved locally. Review this file before sharing it with anyone.</p>
    <div class="resultMetrics">
      <div class="resultMetric"><span>Bytes</span><strong>${result.bytes}</strong></div>
    </div>
    <pre class="artifactPre">${escapeHtml(result.path)}</pre>
  `;
  resultWindow.classList.remove("hidden");
};

const exportDiagnostics = async () => {
  exportDiagnosticsBtn.disabled = true;
  diagnosticsStatus.textContent = "Exporting local diagnostics...";
  try {
    const result = await postJson<LocalExportResponse>("/api/diagnostics/export", {});
    showLocalExportResult("Diagnostics Export", result);
    addActivity("Diagnostics export saved locally", "ok");
  } catch (error) {
    const message = `Diagnostics export failed: ${errorMessage(error)}`;
    diagnosticsStatus.textContent = message;
    addActivity(message, "error");
  } finally {
    exportDiagnosticsBtn.disabled = false;
  }
};

const exportBetaFeedback = async () => {
  exportFeedbackBtn.disabled = true;
  diagnosticsStatus.textContent = "Exporting beta feedback...";
  try {
    const result = await postJson<LocalExportResponse>("/api/beta/feedback-export", {
      message: betaFeedbackInput.value,
    });
    showLocalExportResult("Beta Feedback Export", result);
    addActivity("Beta feedback export saved locally", "ok");
  } catch (error) {
    const message = `Beta feedback export failed: ${errorMessage(error)}`;
    diagnosticsStatus.textContent = message;
    addActivity(message, "error");
  } finally {
    exportFeedbackBtn.disabled = false;
  }
};

const renderAppleMusicConfig = (config: AppleMusicConfigStatus) => {
  appleMusicKeyNameInput.value = config.keyName ?? "";
  appleMusicTeamIdInput.value = config.teamId ?? "";
  appleMusicKeyIdInput.value = config.keyId ?? "";
  appleMusicPrivateKeyPathInput.value = config.privateKeyPath ?? "";
  if (!config.configured) {
    musicKitStatus.textContent = "Save Team ID, Key ID, and the absolute .p8 file path before authorizing Apple Music.";
  }
};

const loadAppleMusicConfig = async () => {
  try {
    const config = await getJson<AppleMusicConfigStatus>("/api/music/config");
    renderAppleMusicConfig(config);
  } catch (error) {
    musicKitStatus.textContent = `MusicKit config unavailable: ${errorMessage(error)}`;
  }
};

const saveAppleMusicConfig = async () => {
  saveAppleMusicConfigBtn.disabled = true;
  musicKitStatus.textContent = "Saving MusicKit key metadata locally...";
  try {
    const config = await postJson<AppleMusicConfigStatus>("/api/music/config", {
      keyName: appleMusicKeyNameInput.value,
      teamId: appleMusicTeamIdInput.value,
      keyId: appleMusicKeyIdInput.value,
      privateKeyPath: appleMusicPrivateKeyPathInput.value,
    });
    renderAppleMusicConfig(config);
    renderMusicKitStatus(false, "MusicKit key metadata saved locally. Click Authorize to connect Apple Music.");
    addActivity("Apple Music MusicKit key metadata saved locally", "ok");
  } catch (error) {
    const message = errorMessage(error);
    renderMusicKitStatus(false, message);
    addActivity(`Apple Music config failed: ${message}`, "error");
  } finally {
    saveAppleMusicConfigBtn.disabled = false;
  }
};

const loadMusicKitStatus = async () => {
  authorizeMusicKitBtn.disabled = true;
  musicKitBadge.textContent = "Checking";
  musicKitBadge.classList.remove("configured", "error");
  musicKitStatus.textContent = "Checking Apple Music playback support...";
  try {
    const status = await getMusicKitStatus();
    renderMusicKitStatus(status.authorized, musicKitStatusDetail(status));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    renderMusicKitStatus(false, message);
  } finally {
    authorizeMusicKitBtn.disabled = false;
  }
};

const authorizeAppleMusic = async () => {
  authorizeMusicKitBtn.disabled = true;
  musicKitStatus.textContent = "Opening Apple Music authorization...";
  try {
    const status = await authorizeMusicKit();
    renderMusicKitStatus(
      status.authorized,
      status.authorized
        ? musicKitStatusDetail(status)
        : "Authorization did not complete. If the Apple sign-in window closed successfully, click Reauthorize once more.",
    );
    addActivity(status.authorized ? "Apple Music authorized" : "Apple Music authorization incomplete", status.authorized ? "ok" : "pending");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    renderMusicKitStatus(false, message);
    addActivity(`Apple Music authorization failed: ${message}`, "error");
  } finally {
    authorizeMusicKitBtn.disabled = false;
  }
};

const renderMusicKitStatus = (authorized: boolean, detail?: string) => {
  musicKitBadge.textContent = authorized ? "Authorized" : "Required";
  musicKitBadge.classList.toggle("configured", authorized);
  musicKitBadge.classList.toggle("error", Boolean(detail) && !authorized);
  musicKitStatus.textContent = detail ?? (authorized ? "Apple Music catalog streaming is enabled." : "Authorize Apple Music to stream subscription catalog songs.");
  authorizeMusicKitBtn.textContent = authorized ? "Reauthorize" : "Authorize";
};

const musicKitStatusDetail = (status: { configured: boolean; authorized: boolean; playbackSupported: boolean; detail?: string }) => {
  if (!status.configured) return status.detail ?? "MusicKit is not configured.";
  if (!status.authorized) return undefined;
  return status.playbackSupported
    ? "Authorized. Catalog songs can stream through MusicKit."
    : "Authorized. This Electron runtime cannot play protected Apple Music streams directly, so Her will use the native Music app fallback when possible.";
};

const renderMiniPlayer = (track: MiniPlayerTrack) => {
  currentMiniPlayerTrack = track;
  miniPlayer.classList.remove("hidden");
  miniPlayer.dataset.state = track.state;
  miniPlayerTitle.textContent = track.title || "Apple Music";
  miniPlayerArtist.textContent = [track.artist, track.album].filter(Boolean).join(" - ");
  if (track.artworkUrl) {
    miniPlayerArtwork.src = track.artworkUrl;
    miniPlayerArtwork.hidden = false;
  } else {
    miniPlayerArtwork.removeAttribute("src");
    miniPlayerArtwork.hidden = true;
  }
  miniPlayerPlayBtn.disabled = track.state === "playing" || track.state === "requested";
  miniPlayerPauseBtn.disabled = track.state === "paused";
};

const pauseMiniPlayer = async () => {
  if (!currentMiniPlayerTrack) return;
  miniPlayerPauseBtn.disabled = true;
  try {
    await pauseAppleMusic();
    renderMiniPlayer({ ...currentMiniPlayerTrack, state: "paused" });
    await postJson("/api/music/playback-status", { status: "paused", songId: currentMiniPlayerTrack.id });
  } catch (error) {
    addActivity(`Apple Music pause failed: ${errorMessage(error)}`, "error");
  }
};

const resumeMiniPlayer = async () => {
  if (!currentMiniPlayerTrack) return;
  miniPlayerPlayBtn.disabled = true;
  try {
    await resumeAppleMusic();
    renderMiniPlayer({ ...currentMiniPlayerTrack, state: "playing" });
    await postJson("/api/music/playback-status", { status: "playing_requested", songId: currentMiniPlayerTrack.id });
  } catch (error) {
    addActivity(`Apple Music resume failed: ${errorMessage(error)}`, "error");
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

const visualStateLabels: Record<VisualState, string> = {
  idle: "Idle",
  listening: "Listening",
  thinking: "Thinking",
  speaking: "Speaking",
  tool: "Working",
  confirming: "Confirming",
  error: "Needs attention",
};

let lastUserPanelText = "Waiting for your voice.";
let lastReplyPanelText = "Her is ready.";

const renderSiriInfoPanel = () => {
  siriModeLabel.textContent = visualStateLabels[visualState];
  siriUserText.textContent = lastUserPanelText;
  siriReplyText.textContent = lastReplyPanelText;
  siriInfoPanel.dataset.state = visualState;
};

const setSiriVoiceLevel = (level: number) => {
  const normalized = Math.max(0, Math.min(1, level));
  siriVoiceLevel.textContent = `${Math.round(normalized * 100)}%`;
  siriInfoPanel.style.setProperty("--voice-intensity", normalized.toFixed(3));
};

const setVisualState = (next: VisualState) => {
  visualState = next;
  orbMount.dataset.state = next;
  renderSiriInfoPanel();
};

const addLine = (kind: "user" | "assistant" | "system" | "tool", text: string) => {
  const row = document.createElement("div");
  row.className = `line ${kind}`;
  row.textContent = text;
  transcript.append(row);
  transcript.scrollTop = transcript.scrollHeight;
  if (kind === "user") {
    lastUserPanelText = truncateText(text, 120);
    renderSiriInfoPanel();
  } else if (kind === "assistant") {
    lastReplyPanelText = truncateText(text, 150);
    renderSiriInfoPanel();
  }
};

const setGlassReplyText = (text: string) => {
  glassReplyText.textContent = text;
  const hasText = text.trim().length > 0;
  glassReply.classList.toggle("on", hasText);
  glassReply.setAttribute("aria-hidden", String(!hasText));
  glassReply.scrollTop = glassReply.scrollHeight;
  if (hasText) {
    lastReplyPanelText = truncateText(text, 150);
    renderSiriInfoPanel();
  }
};

const clearGlassReply = () => setGlassReplyText("");

const beginFreshAssistantReply = () => {
  activeAssistantLine = null;
  clearGlassReply();
  lastReplyPanelText = "Thinking...";
  renderSiriInfoPanel();
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

type ToolDisplay = {
  title?: string;
  subtitle?: string;
  kind?: string;
  generatedAt?: string;
  source?: string;
  metrics?: Array<{ label?: string; value?: string; detail?: string }>;
  items?: Array<{
    title?: string;
    subtitle?: string;
    body?: string;
    url?: string;
    meta?: Record<string, unknown>;
  }>;
  note?: string;
};

const isToolDisplay = (value: unknown): value is ToolDisplay => {
  if (!value || typeof value !== "object") return false;
  const candidate = value as ToolDisplay;
  return typeof candidate.title === "string" && Array.isArray(candidate.items);
};

const findToolDisplay = (value: unknown, depth = 0): ToolDisplay | undefined => {
  if (depth > 5 || !value || typeof value !== "object") return undefined;
  const objectValue = value as Record<string, unknown>;
  if (isToolDisplay(objectValue.display)) return objectValue.display;
  for (const nested of Object.values(objectValue)) {
    const found = findToolDisplay(nested, depth + 1);
    if (found) return found;
  }
  return undefined;
};

const renderToolDisplay = (display: ToolDisplay) => {
  resultWindowTitle.textContent = display.title ?? "Result";
  resultWindowSubtitle.textContent = [display.subtitle, display.source, display.generatedAt ? new Date(display.generatedAt).toLocaleString() : ""]
    .filter(Boolean)
    .join(" · ");

  const metrics = (display.metrics ?? [])
    .map((metric) => `
      <div class="resultMetric">
        <span>${escapeHtml(metric.label ?? "")}</span>
        <strong>${escapeHtml(metric.value ?? "")}</strong>
        ${metric.detail ? `<small>${escapeHtml(metric.detail)}</small>` : ""}
      </div>
    `)
    .join("");

  const items = (display.items ?? [])
    .map((item) => {
      const meta = item.meta
        ? Object.entries(item.meta)
            .filter(([, value]) => value !== undefined && value !== "")
            .map(([key, value]) => `<span>${escapeHtml(key)}: ${escapeHtml(String(value))}</span>`)
            .join("")
        : "";
      const title = item.url
        ? `<a href="${escapeHtml(item.url)}" target="_blank" rel="noreferrer">${escapeHtml(item.title ?? item.url)}</a>`
        : escapeHtml(item.title ?? "Untitled");
      return `
        <article class="resultItem">
          <h3>${title}</h3>
          ${item.subtitle ? `<p class="resultSubtitle">${escapeHtml(item.subtitle)}</p>` : ""}
          ${item.body ? `<p>${escapeHtml(item.body)}</p>` : ""}
          ${meta ? `<div class="resultMeta">${meta}</div>` : ""}
        </article>
      `;
    })
    .join("");

  resultWindowBody.innerHTML = `
    ${metrics ? `<section class="resultMetrics">${metrics}</section>` : ""}
    <section class="resultItems">${items || `<p class="resultEmpty">No displayable rows returned.</p>`}</section>
    ${display.note ? `<p class="resultNote">${escapeHtml(display.note)}</p>` : ""}
  `;
  resultWindow.classList.remove("hidden");
};

const maybeShowToolDisplay = (result: unknown) => {
  const display = findToolDisplay(result);
  if (display) renderToolDisplay(display);
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
  microphoneCheckStatus = audioInputs.length ? "available" : "unavailable";
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
  renderBetaSetup();
};

const refreshMicrophoneDevices = async () => {
  if (!navigator.mediaDevices?.enumerateDevices) {
    microphoneCheckStatus = "unavailable";
    microphoneStatus.textContent = "This browser cannot list microphone devices.";
    renderBetaSetup();
    return;
  }

  refreshMicrophonesBtn.disabled = true;
  microphoneStatus.textContent = "Checking microphone devices...";
  try {
    renderMicrophoneDevices(await navigator.mediaDevices.enumerateDevices());
  } catch (error) {
    microphoneCheckStatus = "unavailable";
    microphoneStatus.textContent = microphoneErrorMessage(error);
    renderBetaSetup();
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
    selectedVoice: realtimeVoiceSelect.value,
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

    const realtimeTools = await loadRealtimeTools();
    const createAgent = (tools: readonly RealtimeToolDefinition[]) =>
      new RealtimeAgent({
        name: "HER",
        instructions: buildRealtimeAgentInstructions(),
        voice: access.voice,
        tools: createRealtimeTools(tools),
      });
    const agent = createAgent(realtimeTools);

    realtimeSession = new RealtimeSession(agent, {
      model: access.model,
      transport: realtimeTransport,
      config: createRealtimeSessionConfig(access.voice, access.runtimeOptions),
    });
    realtimeSessionService = new RealtimeSessionService(realtimeSession, createAgent);

    wireRealtimeSessionEvents(realtimeSession);
    await realtimeSession.connect({ apiKey: access.clientSecret });
    setState("connected", "Connected. Speak naturally.");
    addLine("system", "Voice session connected.");
    realtimeVoiceStatus.textContent = `Current session voice: ${access.voice}.`;
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
  realtimeSessionService = null;
  realtimeTransport = null;
  localStream?.getTracks().forEach((track) => track.stop());
  localStream = null;
  inputAnalyser = null;
  outputAnalyser = null;
  beginFreshAssistantReply();
  setState("idle", "Idle");
};

const wireRealtimeSessionEvents = (session: RealtimeSession) => {
  session.on("transport_event", (event) => handleTransportEvent(event));
  session.on("agent_start", () => {
    beginFreshAssistantReply();
    setVisualState("thinking");
  });
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
    beginFreshAssistantReply();
    setVisualState("thinking");
    void realtimeSessionService?.respondToTranscript(event.transcript);
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

const loadRealtimeTools = async (): Promise<readonly RealtimeToolDefinition[]> => {
  const response = await getJson<{ tools: RealtimeToolDefinition[] }>("/api/realtime/tools");
  if (!Array.isArray(response.tools) || response.tools.length === 0) {
    throw new Error("Local API returned no Realtime tools.");
  }
  return response.tools;
};

const createRealtimeTools = (definitions: readonly RealtimeToolDefinition[]): FunctionTool[] =>
  definitions.map((definition) =>
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

type AppleMusicToolPayload = {
  status?: string;
  source?: string;
  id?: string;
  title?: string;
  artist?: string;
  album?: string;
  artworkUrl?: string;
};

const executeLocalToolForSdk = async (name: ToolName, input: unknown, callId?: string) => {
  setVisualState("tool");
  const args = await enrichToolArgumentsWithContext(name, coerceToolArguments(input));
  const result = await postJson<ToolCallResult>("/api/tools/execute", {
    name,
    arguments: args,
    callId,
    source: "realtime",
  } satisfies ToolCallRequest);

  if (result.ok && result.requiresConfirmation) {
    setVisualState("confirming");
    addActivity(result.summary, "pending");
    renderConfirmationWindow([result]);
    renderConfirmation(result);
  } else if (result.ok) {
    setVisualState("listening");
    maybeShowToolDisplay(result);
    maybeWatchQueuedToolDisplays(result);
    if (name === "music_play_song") {
      await maybePlayAppleMusicCatalogResult(result.result);
    }
    if (name === "app_permission_set" || name === "capability_set" || name === "yolo_mode_set") {
      await reloadSettingsAndApps();
    }
    if (name === "confirmation_decide") {
      await reloadPendingConfirmations();
    }
    await loadArtifacts();
  } else {
    setVisualState("error");
    addActivity(`${name} failed: ${result.error}`, "error");
  }

  return result;
};

const maybeWatchQueuedToolDisplays = (result: ToolCallResult) => {
  const queuedTasks = findQueuedTasks(result);
  for (const task of queuedTasks) {
    if (!task.taskId || watchedQueuedTaskIds.has(task.taskId)) continue;
    watchedQueuedTaskIds.add(task.taskId);
    void pollQueuedToolDisplay(task.taskId);
  }
};

const pollQueuedToolDisplay = async (taskId: string) => {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await sleep(1000);
    const status = await postJson<ToolCallResult>("/api/tools/execute", {
      name: "task_status",
      source: "local",
      arguments: { taskId },
    });
    maybeShowToolDisplay(status);
    const task = readTaskStatusPayload(status);
    if (task?.status === "awaiting_confirmation" || task?.status === "needs_confirmation") {
      await reloadPendingConfirmations({ showWindow: true });
      setVisualState("confirming");
      return;
    }
    if (task?.status && !["queued", "running"].includes(task.status)) return;
  }
};

const findQueuedTasks = (value: unknown): Array<{ taskId?: string }> => {
  if (!value || typeof value !== "object") return [];
  const objectValue = value as Record<string, unknown>;
  const queuedTasks = objectValue.queuedTasks;
  if (Array.isArray(queuedTasks)) {
    return queuedTasks
      .map((item) => (item && typeof item === "object" ? { taskId: String((item as Record<string, unknown>).taskId ?? "") } : {}))
      .filter((item) => item.taskId);
  }
  const task = objectValue.task;
  if (task && typeof task === "object" && !Array.isArray(task)) {
    const taskRecord = task as Record<string, unknown>;
    const taskId = typeof taskRecord.taskId === "string" ? taskRecord.taskId : typeof taskRecord.id === "string" ? taskRecord.id : undefined;
    if (taskId) return [{ taskId }];
  }
  return Object.values(objectValue).flatMap((nested) => findQueuedTasks(nested));
};

const readTaskStatusPayload = (value: unknown): { status?: string } | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const result = (value as Record<string, unknown>).result;
  if (!result || typeof result !== "object") return undefined;
  const task = (result as Record<string, unknown>).task;
  return task && typeof task === "object" ? (task as { status?: string }) : undefined;
};

const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

const enrichToolArgumentsWithContext = async (name: ToolName, args: Record<string, unknown>) => {
  if (name !== "intent_route") return args;
  try {
    const snapshot = await getJson<DesktopContextSnapshot>("/api/context/snapshot");
    renderDesktopContext(snapshot);
    return {
      ...args,
      activeApp: typeof args.activeApp === "string" && args.activeApp.trim() ? args.activeApp : snapshot.routingMetadata.activeApp,
      selectedText: typeof args.selectedText === "string" && args.selectedText.trim()
        ? args.selectedText
        : snapshot.routingMetadata.selectedText?.status === "available"
          ? snapshot.routingMetadata.selectedText.preview
          : undefined,
    };
  } catch {
    return args;
  }
};

const maybePlayAppleMusicCatalogResult = async (payload: unknown) => {
  if (!isAppleMusicCatalogPayload(payload)) return;
  if (payload.status === "playing" || payload.source !== "apple_music_api" || !payload.id) return;

  try {
    const playback = await playAppleMusicSong(payload.id);
    if (playback.status === "needs_authorization") {
      renderMusicKitStatus(false, "Click Authorize to stream Apple Music catalog songs.");
      renderMiniPlayer({ ...payload, id: payload.id, state: "paused" });
      addActivity("Apple Music authorization required", "pending");
      return;
    }
    if (playback.status === "electron_playback_unsupported") {
      renderMusicKitStatus(true, playback.note);
      addActivity("Apple Music playback is using native Music fallback", "pending");
      return;
    }
    renderMiniPlayer({
      id: payload.id,
      title: payload.title,
      artist: payload.artist,
      album: payload.album,
      artworkUrl: payload.artworkUrl,
      state: "playing",
    });
    renderMusicKitStatus(true, `Requested Apple Music playback: ${[payload.title, payload.artist].filter(Boolean).join(" - ") || payload.id}`);
    addActivity(`Apple Music playback requested: ${payload.title ?? payload.id}`, "ok");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    renderMusicKitStatus(false, message);
    addActivity(`MusicKit playback failed: ${message}`, "error");
  }
};

const isAppleMusicCatalogPayload = (payload: unknown): payload is AppleMusicToolPayload =>
  Boolean(payload && typeof payload === "object" && !Array.isArray(payload));

type QueuedMusicPlaybackRequest = {
  action?: "play" | "pause" | "stop";
  id: string;
  title?: string;
  artist?: string;
  album?: string;
  artworkUrl?: string;
};

const startMusicPlaybackRequestPolling = () => {
  if (musicPlaybackPoll) return;
  musicPlaybackPoll = window.setInterval(() => void pollMusicPlaybackRequest(), 1000);
  void pollMusicPlaybackRequest();
};

const pollMusicPlaybackRequest = async () => {
  try {
    const response = await getJson<{ request?: QueuedMusicPlaybackRequest }>("/api/music/playback-requests/next");
    if (!response.request) return;
    const request = response.request;
    if (request.action === "pause" || request.action === "stop") {
      await pauseAppleMusic();
      if (currentMiniPlayerTrack) renderMiniPlayer({ ...currentMiniPlayerTrack, state: "paused" });
      addActivity("Apple Music playback paused", "ok");
      await postJson("/api/music/playback-status", { status: "paused" });
      return;
    }

    const playback = await playAppleMusicSong(request.id);
    if (playback.status === "needs_authorization") {
      renderMusicKitStatus(false, "Click Authorize to stream Apple Music catalog songs.");
      renderMiniPlayer({ ...request, id: request.id, state: "paused" });
      addActivity("Apple Music authorization required", "pending");
      await postJson("/api/music/playback-status", {
        status: "needs_authorization",
        songId: request.id,
        title: request.title,
        artist: request.artist,
      });
      return;
    }
    if (playback.status === "electron_playback_unsupported") {
      renderMusicKitStatus(true, playback.note);
      addActivity("Apple Music playback is using native Music fallback", "pending");
      await postJson("/api/music/playback-status", {
        status: "electron_playback_unsupported",
        songId: request.id,
        title: request.title,
        artist: request.artist,
        album: request.album,
        artworkUrl: request.artworkUrl,
      });
      return;
    }
    renderMiniPlayer({
      id: request.id,
      title: request.title,
      artist: request.artist,
      album: request.album,
      artworkUrl: request.artworkUrl,
      state: "playing",
    });
    renderMusicKitStatus(true, `Requested Apple Music playback: ${[request.title, request.artist].filter(Boolean).join(" - ") || request.id}`);
    addActivity(`Apple Music playback requested: ${request.title ?? request.id}`, "ok");
    await postJson("/api/music/playback-status", {
      status: "playing_requested",
      songId: request.id,
      title: request.title,
      artist: request.artist,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    addActivity(`MusicKit playback request failed: ${message}`, "error");
    await postJson("/api/music/playback-status", { status: "error", error: message });
  }
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

const localRuntimeUnavailableDetail = (message: string) =>
  message.includes("Local API bridge is unavailable")
    ? "Open Her in the Electron desktop app window. The plain browser page cannot access local config, Apple Music authorization state, or Codex login."
    : "Start or restart the app backend to enable local config, Apple Music authorization, and Codex login.";

const truncateText = (value: string, maxLength: number) =>
  value.length > maxLength ? `${value.slice(0, maxLength - 1)}...` : value;

let activeAssistantLine: HTMLDivElement | null = null;
const appendAssistantDelta = (text: string) => {
  if (!text) return;
  if (!activeAssistantLine || !transcript.contains(activeAssistantLine)) {
    activeAssistantLine = document.createElement("div");
    activeAssistantLine.className = "line assistant";
    transcript.append(activeAssistantLine);
    setGlassReplyText("");
  }
  activeAssistantLine.textContent += text;
  setGlassReplyText(activeAssistantLine.textContent);
  transcript.scrollTop = transcript.scrollHeight;
};

const sendUserText = (text: string) => {
  if (!realtimeSession || state !== "connected" || !text.trim()) return;
  addLine("user", text);
  beginFreshAssistantReply();
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
    <div class="confirmationHeader">
      <span class="riskBadge">${escapeHtml(result.riskLabel ?? result.risk ?? "Action")}</span>
      <span>${escapeHtml(formatExpiry(result.expiresAt))}</span>
    </div>
    <p>${escapeHtml(result.summary)}</p>
    ${renderConfirmationDetails(result)}
    <div class="confirmActions">
      <button type="button" data-decision="approve">Approve</button>
      <button type="button" data-decision="reject">Reject</button>
    </div>
  `;
  confirmations.prepend(item);
};

const renderConfirmationWindow = (results: Array<Extract<ToolCallResult, { requiresConfirmation: true }>>) => {
  if (!results.length) return;
  resultWindowTitle.textContent = results.length === 1 ? "需要确认" : `需要确认 (${results.length})`;
  resultWindowSubtitle.textContent = results.length === 1
    ? [results[0].riskLabel ?? results[0].risk, formatExpiry(results[0].expiresAt)].filter(Boolean).join(" · ")
    : "请逐项批准或拒绝";
  resultWindowBody.innerHTML = `
    <section class="confirmationDialogList">
      ${results.map((result) => `
        <article class="confirmation confirmationDialog" data-id="${escapeHtml(result.confirmationId)}">
          <div class="confirmationHeader">
            <span class="riskBadge">${escapeHtml(result.riskLabel ?? result.risk ?? "Action")}</span>
            <span>${escapeHtml(formatExpiry(result.expiresAt))}</span>
          </div>
          <p>${escapeHtml(result.summary)}</p>
          ${renderConfirmationDetails(result)}
          <div class="confirmActions">
            <button type="button" data-decision="approve">Approve</button>
            <button type="button" data-decision="reject">Reject</button>
          </div>
        </article>
      `).join("")}
    </section>
  `;
  resultWindow.classList.remove("hidden");
};

const renderConfirmationDetails = (result: Extract<ToolCallResult, { requiresConfirmation: true }>) => {
  const rows = [
    result.target ? ["Target", result.target] : undefined,
    typeof result.reversible === "boolean" ? ["Reversible", result.reversible ? "Yes" : "No"] : undefined,
    result.taskId ? ["Task", result.taskId.slice(0, 8)] : undefined,
  ].filter(Boolean) as [string, string][];
  const rowHtml = rows.map(([label, value]) => `
    <div>
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
    </div>
  `).join("");
  const preview = formatPreview(result.preview);
  const previewHtml = preview ? `<pre class="confirmationPreview">${escapeHtml(preview)}</pre>` : "";
  const rationale = result.policyRationale?.length
    ? `<ul class="confirmationRationale">${result.policyRationale.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`
    : "";
  return `
    ${rowHtml ? `<div class="confirmationMeta">${rowHtml}</div>` : ""}
    ${previewHtml}
    ${rationale}
  `;
};

const formatPreview = (value: unknown) => {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value === "string") return truncateText(value, 900);
  try {
    return truncateText(JSON.stringify(value, null, 2), 900);
  } catch {
    return truncateText(String(value), 900);
  }
};

const formatExpiry = (expiresAt: string) => {
  const time = Date.parse(expiresAt);
  if (!Number.isFinite(time)) return "Expires soon";
  const seconds = Math.max(0, Math.round((time - Date.now()) / 1000));
  if (seconds >= 60) return `Expires in ${Math.round(seconds / 60)}m`;
  return `Expires in ${seconds}s`;
};

type PendingConfirmation = {
  confirmationId: string;
  name: ToolName;
  summary: string;
  risk?: string;
  riskLabel?: string;
  target?: string;
  preview?: unknown;
  reversible?: boolean;
  policyRationale?: string[];
  taskId?: string;
  createdAt?: string;
  expiresAt: string;
};

const reloadPendingConfirmations = async (options: { showWindow?: boolean } = {}) => {
  const pending = await getJson<PendingConfirmation[]>("/api/tools/pending");
  confirmations.textContent = "";
  confirmations.classList.toggle("empty", pending.length === 0);
  if (!pending.length) {
    confirmations.textContent = "No pending actions";
    if (options.showWindow && resultWindowBody.querySelector(".confirmation")) resultWindow.classList.add("hidden");
    return pending;
  }

  for (const item of pending) {
    renderConfirmation(toConfirmationResult(item));
  }
  if (options.showWindow) renderConfirmationWindow(pending.map(toConfirmationResult));
  return pending;
};

const toConfirmationResult = (item: PendingConfirmation): Extract<ToolCallResult, { requiresConfirmation: true }> => ({
  ok: true,
  name: item.name,
  requiresConfirmation: true,
  confirmationId: item.confirmationId,
  summary: item.summary,
  risk: item.risk,
  riskLabel: item.riskLabel,
  target: item.target,
  preview: item.preview,
  reversible: item.reversible,
  policyRationale: item.policyRationale,
  taskId: item.taskId,
  expiresAt: item.expiresAt,
});

const decideConfirmation = async (confirmationId: string, approved: boolean) => {
  const result = await postJson<ConfirmationResult>("/api/tools/confirm", { confirmationId, approved });
  document.querySelectorAll(`[data-id="${confirmationId}"]`).forEach((item) => item.remove());
  if (!resultWindowBody.querySelector(".confirmation")) resultWindow.classList.add("hidden");
  if (!confirmations.children.length) {
    confirmations.textContent = "No pending actions";
    confirmations.classList.add("empty");
    setVisualState("listening");
  }

  addActivity(approved ? `Approved ${confirmationId}` : `Rejected ${confirmationId}`, approved ? "ok" : "error");
  await reloadPendingConfirmations({ showWindow: true });
  sendUserText(`Local confirmation result: ${JSON.stringify(result)}`);
};

const handleConfirmationClick = (event: Event) => {
  const target = event.target as HTMLElement;
  const button = target.closest<HTMLButtonElement>("button[data-decision]");
  const item = target.closest<HTMLElement>(".confirmation");
  if (!button || !item?.dataset.id) return;
  void decideConfirmation(item.dataset.id, button.dataset.decision === "approve");
};

const setupInputAnalyser = (stream: MediaStream) => {
  audioContext ??= new AudioContext();
  inputAnalyser = audioContext.createAnalyser();
  inputAnalyser.fftSize = 256;
  inputAnalyser.smoothingTimeConstant = 0.62;
  audioContext.createMediaStreamSource(stream).connect(inputAnalyser);
};

const setupOutputAnalyser = (stream: MediaStream) => {
  audioContext ??= new AudioContext();
  outputAnalyser = audioContext.createAnalyser();
  outputAnalyser.fftSize = 256;
  outputAnalyser.smoothingTimeConstant = 0.62;
  audioContext.createMediaStreamSource(stream).connect(outputAnalyser);
};

const stopMicPreview = () => {
  window.clearTimeout(micPreviewHoldTimer);
  micPreviewHoldTimer = undefined;
  if (!micPreviewStream) return;
  micPreviewStream.getTracks().forEach((track) => track.stop());
  micPreviewStream = null;
  if (!localStream) inputAnalyser = null;
  lastUserPanelText = "Waiting for your voice.";
  lastReplyPanelText = state === "error" ? "Open the Electron app window for the full local runtime." : "Her is ready.";
  setVisualState(state === "error" ? "error" : "idle");
  renderSiriInfoPanel();
};

const startMicPreview = async () => {
  if (micPreviewStream || localStream || state === "connected" || state === "connecting") return;
  try {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("This browser cannot access a microphone.");
    }
    const stream = await navigator.mediaDevices.getUserMedia({ audio: microphoneAudioConstraint() });
    micPreviewStream = stream;
    setupInputAnalyser(stream);
    lastUserPanelText = "Listening to microphone preview.";
    lastReplyPanelText = "Release the orb to stop.";
    setVisualState("listening");
    renderSiriInfoPanel();
  } catch (error) {
    lastUserPanelText = "Microphone unavailable.";
    lastReplyPanelText = microphoneErrorMessage(error);
    setVisualState("error");
    renderSiriInfoPanel();
    microphoneStatus.textContent = microphoneErrorMessage(error);
  }
};

const startOrbMicPreview = (event: PointerEvent) => {
  if (isOrbOnly || state === "connected" || state === "connecting" || event.button !== 0) return;
  micPreviewPointerId = event.pointerId;
  orbMount.setPointerCapture(event.pointerId);
  window.clearTimeout(micPreviewHoldTimer);
  micPreviewHoldTimer = window.setTimeout(() => void startMicPreview(), 180);
};

const endOrbMicPreview = (event: PointerEvent) => {
  if (micPreviewPointerId !== event.pointerId) return;
  if (orbMount.hasPointerCapture(event.pointerId)) orbMount.releasePointerCapture(event.pointerId);
  micPreviewPointerId = null;
  stopMicPreview();
};

const analyserBuffers = new WeakMap<AnalyserNode, Uint8Array<ArrayBuffer>>();
const spectrumBuffers = new WeakMap<AnalyserNode, Uint8Array<ArrayBuffer>>();

const readLevel = (analyser: AnalyserNode | null) => {
  if (!analyser) return 0;
  let values = analyserBuffers.get(analyser);
  if (!values || values.length !== analyser.frequencyBinCount) {
    values = new Uint8Array(analyser.frequencyBinCount) as Uint8Array<ArrayBuffer>;
    analyserBuffers.set(analyser, values);
  }
  analyser.getByteTimeDomainData(values);
  let sum = 0;
  let peak = 0;
  for (const value of values) {
    const normalized = (value - 128) / 128;
    peak = Math.max(peak, Math.abs(normalized));
    sum += normalized * normalized;
  }
  const rms = Math.sqrt(sum / values.length);
  const rmsSignal = Math.max(0, (rms - 0.012) / 0.105);
  const peakSignal = Math.max(0, (peak - 0.035) / 0.36) * 0.45;
  return Math.pow(Math.min(1, rmsSignal + peakSignal), 0.72);
};

const readSpectrum = (analyser: AnalyserNode | null, bins: number) => {
  const values = new Float32Array(bins);
  if (!analyser) return values;
  let source = spectrumBuffers.get(analyser);
  if (!source || source.length !== analyser.frequencyBinCount) {
    source = new Uint8Array(analyser.frequencyBinCount) as Uint8Array<ArrayBuffer>;
    spectrumBuffers.set(analyser, source);
  }
  analyser.getByteFrequencyData(source);
  for (let bin = 0; bin < bins; bin += 1) {
    const start = Math.floor((bin / bins) * source.length);
    const end = Math.max(start + 1, Math.floor(((bin + 1) / bins) * source.length));
    let sum = 0;
    for (let index = start; index < end; index += 1) sum += source[index] / 255;
    const average = sum / (end - start);
    values[bin] = Math.pow(Math.max(0, average - 0.025), 0.72);
  }
  return values;
};

const initOrb = () => {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
  camera.position.set(0, 0, 7.6);
  let orbReadyToRender = false;

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, premultipliedAlpha: false, preserveDrawingBuffer: true });
  renderer.setClearColor(0x000000, 0);
  renderer.setClearAlpha(0);
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
    depthWrite: false,
    vertexShader: `
      uniform float uTime;
      uniform float uUserLevel;
      uniform float uAiLevel;
      varying vec3 vNormal;
      varying vec3 vPosition;
      void main() {
        vNormal = normalize(normalMatrix * normal);
        vPosition = position;
        float energy = max(uUserLevel, uAiLevel);
        float wave = sin(position.y * (8.0 + energy * 4.0) + uTime * (1.4 + energy * 4.4)) * (0.035 + energy * 0.12);
        float ribbon = sin((position.x * 1.8 - position.z * 1.2) * 5.0 + uTime * 2.2) * 0.035;
        float ripple = sin((position.x + position.z) * 10.0 - uTime * (2.0 + energy * 4.8)) * energy * 0.07;
        float pulse = 1.0 + uUserLevel * 0.22 + uAiLevel * 0.18;
        float pressed = smoothstep(0.35, 1.0, energy) * 0.04;
        vec3 displaced = position * (pulse + pressed) + normal * (wave + ribbon + ripple);
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
        vec3 cyan = vec3(0.28, 0.95, 1.0);
        vec3 magenta = vec3(1.0, 0.28, 0.76);
        vec3 blue = vec3(0.30, 0.50, 1.0);
        vec3 amber = vec3(1.0, 0.72, 0.26);
        vec3 white = vec3(1.0);
        float energy = max(uUserLevel, uAiLevel);
        float viewFacing = abs(dot(vNormal, vec3(0.0, 0.0, 1.0)));
        float fresnel = pow(1.0 - viewFacing, 2.15);
        float vertical = vPosition.y * 0.5 + 0.5;
        float swirlA = sin(vPosition.x * 3.6 + vPosition.y * 5.4 + uTime * (0.7 + energy * 2.7)) * 0.5 + 0.5;
        float swirlB = sin((vPosition.x - vPosition.z) * 7.0 - uTime * (1.25 + energy * 3.2)) * 0.5 + 0.5;
        float ribbon = smoothstep(0.64, 1.0, sin(vPosition.y * 9.0 + vPosition.x * 4.0 + uTime * 2.1) * 0.5 + 0.5);
        float caustic = smoothstep(0.72, 1.0, sin((vPosition.x * 12.0 + vPosition.y * 7.0) - uTime * 2.8) * 0.5 + 0.5);
        vec3 color = mix(cyan, blue, swirlA);
        color = mix(color, magenta, swirlB * 0.62);
        color = mix(color, amber, min(1.0, uAiLevel * 0.78));
        color = mix(color, uStateColor, 0.22 + energy * 0.16);
        vec3 innerGlow = mix(color, white, 0.18 + fresnel * 0.42 + ribbon * 0.18 + caustic * 0.10);
        float glassBand = smoothstep(0.18, 0.88, vertical) * smoothstep(1.0, 0.24, vertical);
        float alpha = 0.36 + fresnel * 0.48 + ribbon * 0.08 + caustic * 0.06 + glassBand * 0.12 + energy * 0.16;
        gl_FragColor = vec4(innerGlow * (0.8 + fresnel * 0.95 + energy * 0.65), min(0.94, alpha));
      }
    `,
  });

  const sphere = new THREE.Mesh(new THREE.IcosahedronGeometry(1.8, 64), material);
  scene.add(sphere);

  const glassShell = new THREE.Mesh(
    new THREE.SphereGeometry(1.86, 96, 96),
    new THREE.MeshPhysicalMaterial({
      color: "#ffffff",
      transparent: true,
      opacity: 0.18,
      roughness: 0.04,
      metalness: 0,
      transmission: 0.68,
      thickness: 1.25,
      ior: 1.35,
      clearcoat: 1,
      clearcoatRoughness: 0.05,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );
  scene.add(glassShell);

  const rim = new THREE.Mesh(
    new THREE.TorusGeometry(1.9, 0.018, 12, 160),
    new THREE.MeshBasicMaterial({ color: "#ffffff", transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending }),
  );
  rim.rotation.x = Math.PI * 0.5;
  scene.add(rim);

  const halo = new THREE.Mesh(
    new THREE.SphereGeometry(2.175, 64, 64),
    new THREE.MeshBasicMaterial({ color: "#51ddf2", transparent: true, opacity: 0.06, blending: THREE.AdditiveBlending }),
  );
  scene.add(halo);

  const wavePointCount = 128;
  const createWaveRibbon = (color: string, yOffset: number, phase: number, opacity: number) => {
    const positions = new Float32Array(wavePointCount * 3);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const material = new THREE.LineBasicMaterial({
      color,
      transparent: true,
      opacity,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
    });
    const line = new THREE.Line(geometry, material);
    line.renderOrder = 4;
    scene.add(line);
    return { positions, geometry, material, yOffset, phase };
  };
  const waveRibbons = [
    createWaveRibbon("#72fbff", 0, 0, 0.72),
    createWaveRibbon("#ff69cf", 0.03, 1.7, 0.58),
    createWaveRibbon("#ffffff", -0.045, 3.2, 0.38),
  ];

  const thinkingDots = new THREE.Group();
  const dotMaterials: THREE.MeshBasicMaterial[] = [];
  for (let i = 0; i < 6; i += 1) {
    const dotMaterial = new THREE.MeshBasicMaterial({
      color: i % 2 ? "#ff71c8" : "#84f8ff",
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    dotMaterials.push(dotMaterial);
    const dot = new THREE.Mesh(new THREE.SphereGeometry(0.06, 20, 20), dotMaterial);
    const angle = (i / 6) * Math.PI * 2;
    dot.position.set(Math.cos(angle) * 2.28, Math.sin(angle) * 2.28, 0.45);
    dot.renderOrder = 5;
    thinkingDots.add(dot);
  }
  scene.add(thinkingDots);

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
    if (isOrbOnly) renderOrbPosition();
    const rect = orbMount.getBoundingClientRect();
    const width = Math.floor(rect.width);
    const height = Math.floor(rect.height);
    if (width < 2 || height < 2) {
      orbReadyToRender = false;
      return;
    }
    orbReadyToRender = true;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  };
  resize();
  window.addEventListener("resize", resize);

  const startedAt = performance.now();
  const updateWaveRibbon = (
    ribbon: ReturnType<typeof createWaveRibbon>,
    inputBands: Float32Array,
    outputBands: Float32Array,
    elapsed: number,
    energy: number,
    index: number,
  ) => {
    for (let point = 0; point < wavePointCount; point += 1) {
      const t = point / (wavePointCount - 1);
      const bandIndex = Math.min(inputBands.length - 1, Math.floor(t * inputBands.length));
      const shapedX = (t - 0.5) * 3.45;
      const edgeFade = Math.sin(Math.PI * t);
      const inputBand = inputBands[bandIndex] ?? 0;
      const outputBand = outputBands[bandIndex] ?? 0;
      const idleBand = visualState === "idle"
        ? 0.045 + Math.sin(elapsed * 1.5 + t * 9 + ribbon.phase) * 0.018
        : 0.026 + Math.sin(elapsed * 2.2 + t * 11 + ribbon.phase) * 0.018;
      const band = Math.max(idleBand, inputBand * (index === 1 ? 0.55 : 0.92), outputBand * (index === 0 ? 0.48 : 0.88));
      const carrier = Math.sin(t * Math.PI * (3.5 + index * 0.75) + elapsed * (2.1 + energy * 4.2) + ribbon.phase);
      const shimmer = Math.sin(t * Math.PI * 15 + elapsed * (3.2 + index) - ribbon.phase) * 0.035;
      ribbon.positions[point * 3] = shapedX;
      ribbon.positions[point * 3 + 1] = ribbon.yOffset + edgeFade * (carrier * (0.12 + band * 0.74) + shimmer * (0.5 + energy));
      ribbon.positions[point * 3 + 2] = 1.92 - Math.abs(t - 0.5) * 0.34 + index * 0.018;
    }
    ribbon.geometry.attributes.position.needsUpdate = true;
    ribbon.material.opacity = (0.22 + energy * 0.58) * (index === 2 ? 0.66 : 1);
  };

  const animate = () => {
    requestAnimationFrame(animate);
    if (!orbReadyToRender) {
      resize();
      return;
    }
    const nextUserLevel = readLevel(inputAnalyser);
    const nextAiLevel = readLevel(outputAnalyser);
    const inputBands = readSpectrum(inputAnalyser, 64);
    const outputBands = readSpectrum(outputAnalyser, 64);
    userLevel += (nextUserLevel - userLevel) * (nextUserLevel > userLevel ? 0.42 : 0.12);
    aiLevel += (nextAiLevel - aiLevel) * (nextAiLevel > aiLevel ? 0.38 : 0.1);
    const energy = Math.max(userLevel, aiLevel);
    userMeter.style.transform = `scaleX(${Math.max(0.04, userLevel)})`;
    aiMeter.style.transform = `scaleX(${Math.max(0.04, aiLevel)})`;
    setSiriVoiceLevel(energy);

    const elapsed = (performance.now() - startedAt) / 1000;
    uniforms.uTime.value = elapsed;
    uniforms.uUserLevel.value = userLevel;
    uniforms.uAiLevel.value = aiLevel;
    uniforms.uStateColor.value.lerp(new THREE.Color(stateColors[visualState]), 0.05);
    sphere.rotation.y = elapsed * 0.12;
    sphere.rotation.x = Math.sin(elapsed * 0.28) * 0.08;
    sphere.scale.setScalar(1 + userLevel * 0.12 + aiLevel * 0.1);
    glassShell.rotation.copy(sphere.rotation);
    glassShell.scale.setScalar(1 + userLevel * 0.08 + aiLevel * 0.07);
    (glassShell.material as THREE.MeshPhysicalMaterial).opacity = 0.14 + energy * 0.1;
    rim.rotation.z = elapsed * (0.22 + energy * 0.55);
    rim.scale.setScalar(1 + energy * 0.12);
    (rim.material as THREE.MeshBasicMaterial).opacity = 0.18 + energy * 0.32;
    halo.scale.setScalar(1 + userLevel * 0.42 + aiLevel * 0.34);
    (halo.material as THREE.MeshBasicMaterial).opacity = 0.07 + userLevel * 0.36 + aiLevel * 0.28;
    waveRibbons.forEach((ribbon, index) => updateWaveRibbon(ribbon, inputBands, outputBands, elapsed, energy, index));
    const dotVisibility = visualState === "thinking" || visualState === "tool" || visualState === "confirming" ? 1 : 0;
    thinkingDots.rotation.z = -elapsed * (0.85 + energy * 0.7);
    thinkingDots.scale.setScalar(1 + energy * 0.1);
    dotMaterials.forEach((dotMaterial, index) => {
      const wave = Math.sin(elapsed * 4.4 + index * 0.85) * 0.5 + 0.5;
      dotMaterial.opacity += ((0.16 + wave * 0.54) * dotVisibility - dotMaterial.opacity) * 0.14;
    });
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
manageAppsBtn.addEventListener("click", () => showOnboarding(true));
yoloModeBtn.addEventListener("click", () => void saveYoloMode(!settings?.yoloMode));
orbOnlyBtn.addEventListener("click", () => setOrbOnlyMode(!isOrbOnly));
restorePanelBtn.addEventListener("click", () => setOrbOnlyMode(false));
resultWindowCloseBtn.addEventListener("click", () => resultWindow.classList.add("hidden"));
saveOpenaiKeyBtn.addEventListener("click", () => void saveOpenaiKey());
exportDiagnosticsBtn.addEventListener("click", () => void exportDiagnostics());
exportFeedbackBtn.addEventListener("click", () => void exportBetaFeedback());
saveAppleMusicConfigBtn.addEventListener("click", () => void saveAppleMusicConfig());
authorizeMusicKitBtn.addEventListener("click", () => void authorizeAppleMusic());
miniPlayerPlayBtn.addEventListener("click", () => void resumeMiniPlayer());
miniPlayerPauseBtn.addEventListener("click", () => void pauseMiniPlayer());
refreshCodexLoginBtn.addEventListener("click", () => void loadCodexLoginStatus());
startCodexLoginBtn.addEventListener("click", () => void startCodexLogin());
codexModelSelect.addEventListener("change", () => void saveCodexModel());
refreshTasksBtn.addEventListener("click", () => void loadTaskRuns());
refreshWorkflowsBtn.addEventListener("click", () => void loadWorkflowPacks());
refreshArtifactsBtn.addEventListener("click", () => void loadArtifacts());
refreshAgentRunsBtn.addEventListener("click", () => void loadAgentRuns());
realtimeVoiceSelect.addEventListener("change", () => void saveRealtimeVoice());
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
orbMount.parentElement?.addEventListener("pointerdown", startOrbDrag);
orbMount.parentElement?.addEventListener("pointermove", moveOrbDrag);
orbMount.parentElement?.addEventListener("pointerup", endOrbDrag);
orbMount.parentElement?.addEventListener("pointercancel", endOrbDrag);
orbMount.addEventListener("pointerdown", startOrbMicPreview);
orbMount.addEventListener("pointerup", endOrbMicPreview);
orbMount.addEventListener("pointercancel", endOrbMicPreview);
confirmations.addEventListener("click", (event) => {
  handleConfirmationClick(event);
});
resultWindowBody.addEventListener("click", (event) => {
  handleConfirmationClick(event);
});
taskRuns.addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-task-cancel]");
  if (!button?.dataset.taskCancel) return;
  void cancelTaskRun(button.dataset.taskCancel);
});
workflowPacks.addEventListener("click", (event) => {
  const target = event.target as HTMLElement;
  const previewButton = target.closest<HTMLButtonElement>("button[data-workflow-preview]");
  if (previewButton?.dataset.workflowPreview) {
    void previewWorkflowPack(previewButton.dataset.workflowPreview);
    return;
  }
  const runButton = target.closest<HTMLButtonElement>("button[data-workflow-run]");
  if (runButton?.dataset.workflowRun) {
    void runWorkflowPack(runButton.dataset.workflowRun);
    return;
  }
  const statusButton = target.closest<HTMLButtonElement>("button[data-workflow-status]");
  if (statusButton?.dataset.workflowStatus) {
    void showWorkflowRun(statusButton.dataset.workflowStatus);
    return;
  }
  const cancelButton = target.closest<HTMLButtonElement>("button[data-workflow-cancel]");
  if (cancelButton?.dataset.workflowCancel) {
    void cancelWorkflowRun(cancelButton.dataset.workflowCancel);
  }
});
artifactList.addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-artifact-action]");
  const item = (event.target as HTMLElement).closest<HTMLElement>("[data-artifact-id]");
  if (!button?.dataset.artifactAction || !item?.dataset.artifactId) return;
  if (button.dataset.artifactAction === "show") {
    void showArtifact(item.dataset.artifactId);
    return;
  }
  if (button.dataset.artifactAction === "copy-summary") {
    void copyArtifactSummary(item.dataset.artifactId).catch((error) => addActivity(`Copy artifact summary failed: ${errorMessage(error)}`, "error"));
  }
});
agentRuns.addEventListener("click", (event) => {
  const target = event.target as HTMLElement;
  const cancelButton = target.closest<HTMLButtonElement>("button[data-agent-cancel]");
  if (cancelButton?.dataset.agentCancel) {
    void cancelAgentRun(cancelButton.dataset.agentCancel);
    return;
  }
  const reviewButton = target.closest<HTMLButtonElement>("button[data-agent-review]");
  if (reviewButton?.dataset.agentReview) {
    void showAgentReview(reviewButton.dataset.agentReview);
    return;
  }
  const applyButton = target.closest<HTMLButtonElement>("button[data-agent-apply]");
  if (applyButton?.dataset.agentApply) {
    void applyAgentRun(applyButton.dataset.agentApply);
  }
});

setState("idle", "Idle");
setOrbOnlyMode(isOrbOnly);
void initialize();
