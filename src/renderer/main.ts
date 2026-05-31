import * as THREE from "three";
import type { CapabilityKey, CapabilitySettings, InstalledApp, UserSettings } from "../shared/app-settings";
import type { ConfirmationResult, ToolCallRequest, ToolCallResult, ToolName } from "../shared/tools";
import "./styles.css";

const LOCAL_API = "http://127.0.0.1:3939";
const REALTIME_SDP_URL = "https://api.openai.com/v1/realtime/calls";

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
        <section class="yoloPanel">
          <div class="sectionHeader">
            <h2>YOLO Mode</h2>
            <button id="yoloModeBtn" type="button">Enable</button>
          </div>
          <p id="yoloModeStatus" class="muted"></p>
          <div class="permissionButtons" aria-label="macOS permission shortcuts">
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
          <h2>Pending Confirmation</h2>
          <div id="confirmations" class="stack empty">No pending actions</div>
        </section>
        <section>
          <h2>Tool Activity</h2>
          <div id="activity" class="stack empty">No tool calls yet</div>
        </section>
        <section>
          <h2>Authorized Apps</h2>
          <div id="authorizedApps" class="authorizedApps"></div>
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
let pc: RTCPeerConnection | null = null;
let dc: RTCDataChannel | null = null;
let localStream: MediaStream | null = null;
let audioContext: AudioContext | null = null;
let inputAnalyser: AnalyserNode | null = null;
let outputAnalyser: AnalyserNode | null = null;
let userLevel = 0;
let aiLevel = 0;

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

const initialize = async () => {
  initOrb();
  try {
    settings = await getJson<UserSettings>("/api/settings");
    installedApps = await getJson<InstalledApp[]>("/api/apps");
    appPermissions = Object.fromEntries(installedApps.map((item) => [item.bundleId, item.authorized]));
    renderSettings();
    showOnboarding(!settings.hasCompletedOnboarding);
    addLine("system", "Start voice, then ask me to manage files, documents, drafts, email, calendar, music, apps, browser tasks, or safe shell commands.");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    onboardingStatus.textContent = message;
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
  statusText.textContent = detail ?? next;
  connectBtn.disabled = next === "connecting" || next === "connected";
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

const getRealtimeSecret = async () => {
  const payload = await postJson<Record<string, unknown>>("/api/realtime/client-secret", {});
  const direct = payload.value;
  const nested = (payload.client_secret as { value?: string } | undefined)?.value;
  const secret = typeof direct === "string" ? direct : nested;
  if (!secret) throw new Error("Realtime client secret response did not include a usable value.");
  return secret;
};

const connect = async () => {
  setState("connecting", "Requesting microphone and Realtime session...");
  try {
    const clientSecret = await getRealtimeSecret();
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    setupInputAnalyser(localStream);

    pc = new RTCPeerConnection();
    localStream.getTracks().forEach((track) => pc?.addTrack(track, localStream!));

    const audio = document.createElement("audio");
    audio.autoplay = true;
    pc.ontrack = (event) => {
      audio.srcObject = event.streams[0];
      setupOutputAnalyser(event.streams[0]);
      void audio.play().catch(() => undefined);
    };

    dc = pc.createDataChannel("oai-events");
    dc.onopen = () => {
      setState("connected", "Connected. Speak naturally.");
      addLine("system", "Voice session connected.");
    };
    dc.onmessage = (event) => void handleRealtimeEvent(event.data);
    dc.onerror = () => setState("error", "Realtime data channel error.");
    dc.onclose = () => {
      if (state !== "idle") setState("idle", "Disconnected.");
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    const response = await fetch(REALTIME_SDP_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${clientSecret}`,
        "Content-Type": "application/sdp",
      },
      body: offer.sdp,
    });

    if (!response.ok) {
      throw new Error(`Realtime SDP exchange failed: ${await response.text()}`);
    }

    await pc.setRemoteDescription({ type: "answer", sdp: await response.text() });
  } catch (error) {
    disconnect();
    const message = error instanceof Error ? error.message : String(error);
    setState("error", message);
    addLine("system", message);
  }
};

const disconnect = () => {
  dc?.close();
  pc?.close();
  localStream?.getTracks().forEach((track) => track.stop());
  dc = null;
  pc = null;
  localStream = null;
  inputAnalyser = null;
  outputAnalyser = null;
  setState("idle", "Idle");
};

const handleRealtimeEvent = async (raw: string) => {
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return;
  }

  if (event.type === "conversation.item.input_audio_transcription.completed") {
    addLine("user", String(event.transcript ?? ""));
    setVisualState("thinking");
  }

  if (event.type === "response.audio_transcript.delta") {
    setVisualState("speaking");
    appendAssistantDelta(String(event.delta ?? ""));
  }

  if (event.type === "response.done") {
    setVisualState("listening");
  }

  if (event.type === "response.function_call_arguments.done") {
    const name = event.name;
    const callId = event.call_id;
    const argsText = typeof event.arguments === "string" ? event.arguments : "{}";
    if (typeof name === "string" && typeof callId === "string") {
      await executeTool(name, callId, argsText);
    }
  }

  if (event.type === "error") {
    setVisualState("error");
    addLine("system", JSON.stringify(event));
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

const executeTool = async (name: string, callId: string, argsText: string) => {
  if (!isToolName(name)) {
    sendFunctionOutput(callId, { ok: false, name, error: `Unknown local tool: ${name}` });
    addActivity(`Unknown tool requested: ${name}`, "error");
    return;
  }

  let args: Record<string, unknown>;
  try {
    args = JSON.parse(argsText) as Record<string, unknown>;
  } catch {
    args = {};
  }

  setVisualState("tool");
  addActivity(`${name} requested`, "pending");
  const result = await postJson<ToolCallResult>("/api/tools/execute", {
    name,
    arguments: args,
    callId,
  } satisfies ToolCallRequest);

  sendFunctionOutput(callId, result);

  if (result.ok && result.requiresConfirmation) {
    setVisualState("confirming");
    addActivity(result.summary, "pending");
    renderConfirmation(result);
  } else if (result.ok) {
    setVisualState("listening");
    addActivity(`${name} completed`, "ok");
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
};

const toolNames = new Set<string>([
  "system_status",
  "confirmation_list",
  "confirmation_decide",
  "yolo_mode_set",
  "app_permission_search",
  "app_permission_set",
  "capability_set",
  "file_list",
  "file_search",
  "file_read",
  "file_open",
  "file_create_folder",
  "file_rename",
  "file_move",
  "file_copy",
  "file_trash",
  "document_extract",
  "document_folder_digest",
  "document_prepare_edit",
  "email_search",
  "email_read",
  "email_draft",
  "email_send",
  "calendar_search",
  "calendar_create",
  "copy_search",
  "copy_save_draft",
  "copy_publish",
  "music_open",
  "music_play_song",
  "video_play",
  "app_open",
  "app_focus",
  "app_quit",
  "window_list",
  "window_close_all",
  "window_auto_arrange",
  "window_minimize_unrelated",
  "window_close",
  "window_minimize",
  "window_maximize",
  "window_move_resize",
  "desktop_open_app",
  "system_close_app",
  "system_set_volume",
  "system_set_brightness",
  "system_set_dark_mode",
  "system_open_settings",
  "desktop_clipboard_write",
  "browser_open_url",
  "browser_isolated_open_url",
  "browser_fill_form",
  "browser_click",
  "advanced_shell_command",
]);

const isToolName = (name: string): name is ToolName => toolNames.has(name);

const sendFunctionOutput = (callId: string, output: unknown) => {
  if (!dc || dc.readyState !== "open") return;
  dc.send(
    JSON.stringify({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output: JSON.stringify(output),
      },
    }),
  );
  dc.send(JSON.stringify({ type: "response.create" }));
};

const sendUserText = (text: string) => {
  if (!dc || dc.readyState !== "open" || !text.trim()) return;
  addLine("user", text);
  setVisualState("thinking");
  dc.send(
    JSON.stringify({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text }],
      },
    }),
  );
  dc.send(JSON.stringify({ type: "response.create" }));
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
