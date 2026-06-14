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
          <div id="miniPlayer" class="miniPlayer hidden" aria-label="Apple Music playback">
            <img id="miniPlayerArtwork" alt="" />
            <div class="miniPlayerMeta">
              <strong id="miniPlayerTitle"></strong>
              <span id="miniPlayerArtist"></span>
            </div>
            <div class="miniPlayerActions">
              <button id="miniPlayerPlayBtn" type="button" aria-label="Play">Play</button>
              <button id="miniPlayerPauseBtn" type="button" aria-label="Pause">Pause</button>
            </div>
          </div>
          <div class="controls">
            <button id="connectBtn" type="button">Start voice</button>
            <button id="disconnectBtn" type="button" disabled>Stop</button>
            <button id="orbOnlyBtn" type="button">Orb only</button>
          </div>
        </header>

        <section class="orbPanel" aria-label="Voice state">
          <div id="orbMount" class="orbMount"></div>
          <button id="restorePanelBtn" class="restorePanelBtn" type="button" hidden>Panel</button>
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
        <section class="voiceSettingsPanel">
          <div class="sectionHeader">
            <h2>Voice</h2>
            <span id="realtimeVoiceBadge" class="keyBadge configured">Marin</span>
          </div>
          <select id="realtimeVoiceSelect" aria-label="Realtime voice">
            <option value="marin">Marin</option>
          </select>
          <p id="realtimeVoiceStatus" class="muted">Voice changes apply to the next session.</p>
        </section>
        <section class="musicKitPanel">
          <div class="sectionHeader">
            <h2>Apple Music</h2>
            <span id="musicKitBadge" class="keyBadge">Checking</span>
          </div>
          <p id="musicKitStatus" class="muted">Authorize Apple Music to stream subscription catalog songs.</p>
          <button id="authorizeMusicKitBtn" type="button">Authorize</button>
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
          <div class="sectionHeader">
            <h2>Authorized Apps</h2>
            <button id="manageAppsBtn" type="button">Manage Apps</button>
          </div>
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
  <div id="resultWindow" class="resultWindow hidden" role="dialog" aria-modal="false" aria-label="Tool result">
    <div class="resultWindowChrome">
      <div>
        <h2 id="resultWindowTitle">Result</h2>
        <p id="resultWindowSubtitle"></p>
      </div>
      <button id="resultWindowCloseBtn" type="button" aria-label="Close result">Close</button>
    </div>
    <div id="resultWindowBody" class="resultWindowBody"></div>
  </div>
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
const orbOnlyBtn = document.querySelector<HTMLButtonElement>("#orbOnlyBtn")!;
const restorePanelBtn = document.querySelector<HTMLButtonElement>("#restorePanelBtn")!;
const sendTextBtn = document.querySelector<HTMLButtonElement>("#sendTextBtn")!;
const textInput = document.querySelector<HTMLInputElement>("#textInput")!;
const transcript = document.querySelector<HTMLDivElement>("#transcript")!;
const miniPlayer = document.querySelector<HTMLDivElement>("#miniPlayer")!;
const miniPlayerArtwork = document.querySelector<HTMLImageElement>("#miniPlayerArtwork")!;
const miniPlayerTitle = document.querySelector<HTMLElement>("#miniPlayerTitle")!;
const miniPlayerArtist = document.querySelector<HTMLSpanElement>("#miniPlayerArtist")!;
const miniPlayerPlayBtn = document.querySelector<HTMLButtonElement>("#miniPlayerPlayBtn")!;
const miniPlayerPauseBtn = document.querySelector<HTMLButtonElement>("#miniPlayerPauseBtn")!;
const confirmations = document.querySelector<HTMLDivElement>("#confirmations")!;
const activity = document.querySelector<HTMLDivElement>("#activity")!;
const resultWindow = document.querySelector<HTMLDivElement>("#resultWindow")!;
const resultWindowTitle = document.querySelector<HTMLHeadingElement>("#resultWindowTitle")!;
const resultWindowSubtitle = document.querySelector<HTMLParagraphElement>("#resultWindowSubtitle")!;
const resultWindowBody = document.querySelector<HTMLDivElement>("#resultWindowBody")!;
const resultWindowCloseBtn = document.querySelector<HTMLButtonElement>("#resultWindowCloseBtn")!;
const orbMount = document.querySelector<HTMLDivElement>("#orbMount")!;
const userMeter = document.querySelector<HTMLSpanElement>("#userMeter")!;
const aiMeter = document.querySelector<HTMLSpanElement>("#aiMeter")!;
const finishOnboardingBtn = document.querySelector<HTMLButtonElement>("#finishOnboardingBtn")!;
const onboardingYoloBtn = document.querySelector<HTMLButtonElement>("#onboardingYoloBtn")!;
const refreshAppsBtn = document.querySelector<HTMLButtonElement>("#refreshAppsBtn")!;
const openPermissionsBtn = document.querySelector<HTMLButtonElement>("#openPermissionsBtn")!;
const manageAppsBtn = document.querySelector<HTMLButtonElement>("#manageAppsBtn")!;
const yoloModeBtn = document.querySelector<HTMLButtonElement>("#yoloModeBtn")!;
const yoloModeStatus = document.querySelector<HTMLParagraphElement>("#yoloModeStatus")!;
const openaiKeyInput = document.querySelector<HTMLInputElement>("#openaiKeyInput")!;
const saveOpenaiKeyBtn = document.querySelector<HTMLButtonElement>("#saveOpenaiKeyBtn")!;
const openaiKeyStatus = document.querySelector<HTMLParagraphElement>("#openaiKeyStatus")!;
const openaiKeyBadge = document.querySelector<HTMLSpanElement>("#openaiKeyBadge")!;
const realtimeVoiceSelect = document.querySelector<HTMLSelectElement>("#realtimeVoiceSelect")!;
const realtimeVoiceStatus = document.querySelector<HTMLParagraphElement>("#realtimeVoiceStatus")!;
const realtimeVoiceBadge = document.querySelector<HTMLSpanElement>("#realtimeVoiceBadge")!;
const musicKitBadge = document.querySelector<HTMLSpanElement>("#musicKitBadge")!;
const musicKitStatus = document.querySelector<HTMLParagraphElement>("#musicKitStatus")!;
const authorizeMusicKitBtn = document.querySelector<HTMLButtonElement>("#authorizeMusicKitBtn")!;
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
let realtimeSessionService: RealtimeSessionService | null = null;
let localStream: MediaStream | null = null;
let audioContext: AudioContext | null = null;
let inputAnalyser: AnalyserNode | null = null;
let outputAnalyser: AnalyserNode | null = null;
let userLevel = 0;
let aiLevel = 0;
let hasOpenaiApiKey = false;
let selectedMicrophoneId = window.localStorage.getItem("her:selectedMicrophoneId") ?? "";
let isOrbOnly = window.localStorage.getItem("her:orbOnly") === "true";
let musicPlaybackPoll: number | undefined;
let currentMiniPlayerTrack: MiniPlayerTrack | undefined;

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
  initOrb();
  renderRealtimeUsage();
  try {
    settings = await getJson<UserSettings>("/api/settings");
    await loadOpenaiKeyStatus();
    await loadRealtimeVoice();
    await loadMusicKitStatus();
    await loadCodexLoginStatus();
    await loadCodexModel();
    await refreshMicrophoneDevices();
    startMusicPlaybackRequestPolling();
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

const loadMusicKitStatus = async () => {
  authorizeMusicKitBtn.disabled = true;
  musicKitBadge.textContent = "Checking";
  musicKitBadge.classList.remove("configured", "error");
  musicKitStatus.textContent = "Checking Apple Music playback support...";
  try {
    const status = await getMusicKitStatus();
    renderMusicKitStatus(status.authorized, status.configured ? undefined : "MusicKit is not configured.");
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
    renderMusicKitStatus(status.authorized, status.authorized ? "Authorized. Catalog songs can stream through MusicKit." : "Authorization did not complete.");
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
    maybeShowToolDisplay(result);
    if (name === "music_play_song") {
      await maybePlayAppleMusicCatalogResult(result.result);
    }
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

const analyserBuffers = new WeakMap<AnalyserNode, Uint8Array<ArrayBuffer>>();

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

const initOrb = () => {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
  camera.position.set(0, 0, 9.5);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, premultipliedAlpha: false });
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
        float wave = sin(position.y * (7.0 + energy * 4.0) + uTime * (1.7 + energy * 4.6)) * (0.045 + energy * 0.16);
        float ripple = sin((position.x + position.z) * 9.0 - uTime * (2.1 + energy * 5.0)) * energy * 0.08;
        float pulse = 1.0 + uUserLevel * 0.42 + uAiLevel * 0.34;
        vec3 displaced = position * pulse + normal * (wave + ripple);
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
        float energy = max(uUserLevel, uAiLevel);
        float flow = sin(vPosition.x * 3.0 + vPosition.y * 4.0 + uTime * (0.7 + energy * 3.8)) * 0.5 + 0.5;
        vec3 color = mix(aqua, violet, flow);
        color = mix(color, coral, min(1.0, uUserLevel * 0.95));
        color = mix(color, gold, min(1.0, uAiLevel * 0.85));
        color = mix(color, uStateColor, 0.35);
        float fresnel = pow(1.0 - abs(dot(vNormal, vec3(0.0, 0.0, 1.0))), 2.4);
        float alpha = 0.66 + fresnel * 0.28 + energy * 0.18;
        gl_FragColor = vec4(color * (0.82 + fresnel + energy * 0.85), min(1.0, alpha));
      }
    `,
  });

  const sphere = new THREE.Mesh(new THREE.IcosahedronGeometry(1.8, 64), material);
  scene.add(sphere);

  const halo = new THREE.Mesh(
    new THREE.SphereGeometry(2.175, 64, 64),
    new THREE.MeshBasicMaterial({ color: "#51ddf2", transparent: true, opacity: 0.06, blending: THREE.AdditiveBlending }),
  );
  scene.add(halo);

  const particleGeometry = new THREE.BufferGeometry();
  const particleCount = 420;
  const positions = new Float32Array(particleCount * 3);
  for (let i = 0; i < particleCount; i += 1) {
    const radius = 2.475 + Math.random() * 1.5;
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
    if (isOrbOnly) renderOrbPosition();
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
    const nextUserLevel = readLevel(inputAnalyser);
    const nextAiLevel = readLevel(outputAnalyser);
    userLevel += (nextUserLevel - userLevel) * (nextUserLevel > userLevel ? 0.42 : 0.12);
    aiLevel += (nextAiLevel - aiLevel) * (nextAiLevel > aiLevel ? 0.38 : 0.1);
    const energy = Math.max(userLevel, aiLevel);
    userMeter.style.transform = `scaleX(${Math.max(0.04, userLevel)})`;
    aiMeter.style.transform = `scaleX(${Math.max(0.04, aiLevel)})`;

    const elapsed = clock.getElapsedTime();
    uniforms.uTime.value = elapsed;
    uniforms.uUserLevel.value = userLevel;
    uniforms.uAiLevel.value = aiLevel;
    uniforms.uStateColor.value.lerp(new THREE.Color(stateColors[visualState]), 0.05);
    sphere.rotation.y = elapsed * 0.12;
    sphere.rotation.x = Math.sin(elapsed * 0.28) * 0.08;
    sphere.scale.setScalar(1 + userLevel * 0.12 + aiLevel * 0.1);
    halo.scale.setScalar(1 + userLevel * 0.42 + aiLevel * 0.34);
    (halo.material as THREE.MeshBasicMaterial).opacity = 0.07 + userLevel * 0.36 + aiLevel * 0.28;
    particles.scale.setScalar(1 + energy * 0.22);
    particles.rotation.y = elapsed * (0.025 + userLevel * 0.16);
    particles.rotation.x = elapsed * (0.015 + aiLevel * 0.13);
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
authorizeMusicKitBtn.addEventListener("click", () => void authorizeAppleMusic());
miniPlayerPlayBtn.addEventListener("click", () => void resumeMiniPlayer());
miniPlayerPauseBtn.addEventListener("click", () => void pauseMiniPlayer());
refreshCodexLoginBtn.addEventListener("click", () => void loadCodexLoginStatus());
startCodexLoginBtn.addEventListener("click", () => void startCodexLogin());
codexModelSelect.addEventListener("change", () => void saveCodexModel());
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
confirmations.addEventListener("click", (event) => {
  const target = event.target as HTMLElement;
  const button = target.closest<HTMLButtonElement>("button[data-decision]");
  const item = target.closest<HTMLElement>(".confirmation");
  if (!button || !item?.dataset.id) return;
  void decideConfirmation(item.dataset.id, button.dataset.decision === "approve");
});

setState("idle", "Idle");
setOrbOnlyMode(isOrbOnly);
void initialize();
