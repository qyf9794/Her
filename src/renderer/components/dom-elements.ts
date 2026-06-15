const onboarding = document.querySelector<HTMLDivElement>("#onboarding")!;
const appView = document.querySelector<HTMLDivElement>("#appView")!;
const onboardingStatus = document.querySelector<HTMLParagraphElement>("#onboardingStatus")!;
const appGrid = document.querySelector<HTMLDivElement>("#appGrid")!;
const onboardingCapabilities = document.querySelector<HTMLDivElement>("#onboardingCapabilities")!;
const runtimeCapabilities = document.querySelector<HTMLDivElement>("#runtimeCapabilities")!;
const authorizedApps = document.querySelector<HTMLDivElement>("#authorizedApps")!;
const statusText = document.querySelector<HTMLParagraphElement>("#statusText")!;
const contextApp = document.querySelector<HTMLElement>("#contextApp")!;
const contextWindow = document.querySelector<HTMLElement>("#contextWindow")!;
const contextClipboard = document.querySelector<HTMLElement>("#contextClipboard")!;
const contextRecentFiles = document.querySelector<HTMLElement>("#contextRecentFiles")!;
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
const glassReply = document.querySelector<HTMLDivElement>("#glassReply")!;
const glassReplyText = document.querySelector<HTMLSpanElement>("#glassReplyText")!;
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
const refreshTasksBtn = document.querySelector<HTMLButtonElement>("#refreshTasksBtn")!;
const taskRuns = document.querySelector<HTMLDivElement>("#taskRuns")!;
const refreshAgentRunsBtn = document.querySelector<HTMLButtonElement>("#refreshAgentRunsBtn")!;
const agentRuns = document.querySelector<HTMLDivElement>("#agentRuns")!;
const microphoneSelect = document.querySelector<HTMLSelectElement>("#microphoneSelect")!;
const refreshMicrophonesBtn = document.querySelector<HTMLButtonElement>("#refreshMicrophonesBtn")!;
const microphoneStatus = document.querySelector<HTMLParagraphElement>("#microphoneStatus")!;
const realtimeUsage = document.querySelector<HTMLDivElement>("#realtimeUsage")!;

export const getRendererElements = () => ({
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
  realtimeVoiceSelect,
  realtimeVoiceStatus,
  realtimeVoiceBadge,
  musicKitBadge,
  musicKitStatus,
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
  refreshAgentRunsBtn,
  agentRuns,
  microphoneSelect,
  refreshMicrophonesBtn,
  microphoneStatus,
  realtimeUsage,
});

export type RendererElements = ReturnType<typeof getRendererElements>;
