export const renderAppShell = () => {
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

        <section class="contextStrip" aria-label="Desktop context">
          <div>
            <span>App</span>
            <strong id="contextApp">Unknown</strong>
          </div>
          <div>
            <span>Window</span>
            <strong id="contextWindow">Unavailable</strong>
          </div>
          <div>
            <span>Clipboard</span>
            <strong id="contextClipboard">Empty</strong>
          </div>
          <div>
            <span>Recent</span>
            <strong id="contextRecentFiles">0 files</strong>
          </div>
        </section>

        <section class="orbPanel" aria-label="Voice state">
          <div id="orbMount" class="orbMount"></div>
          <div id="glassReply" class="glassReply" aria-live="polite" aria-hidden="true">
            <div class="glassReplyBody">
              <span id="glassReplyText"></span>
            </div>
          </div>
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
        <section class="betaSetupPanel">
          <div class="sectionHeader">
            <h2>Beta Setup</h2>
            <span id="betaSetupBadge" class="keyBadge">0/5</span>
          </div>
          <div id="betaSetupList" class="setupChecklist"></div>
          <p class="muted">Diagnostics and feedback exports stay local until you choose to share them. Secrets, tokens, cookies, and local API credentials are redacted.</p>
          <textarea id="betaFeedbackInput" rows="3" placeholder="Optional feedback note"></textarea>
          <div class="diagnosticActions">
            <button id="exportDiagnosticsBtn" type="button">Export Diagnostics</button>
            <button id="exportFeedbackBtn" type="button">Export Feedback</button>
          </div>
          <p id="diagnosticsStatus" class="muted">Use exports when a beta issue needs review.</p>
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
          <div class="musicKitConfigForm">
            <input id="appleMusicKeyNameInput" type="text" placeholder="Key name" autocomplete="off" spellcheck="false" />
            <input id="appleMusicTeamIdInput" type="text" placeholder="Apple Team ID" autocomplete="off" spellcheck="false" />
            <input id="appleMusicKeyIdInput" type="text" placeholder="MusicKit Key ID" autocomplete="off" spellcheck="false" />
            <input id="appleMusicPrivateKeyPathInput" type="text" placeholder="Absolute path to .p8 file" autocomplete="off" spellcheck="false" />
            <button id="saveAppleMusicConfigBtn" type="button">Save MusicKit Key</button>
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
        <section class="agentRunsPanel">
          <div class="sectionHeader">
            <h2>Tasks</h2>
            <button id="refreshTasksBtn" type="button">Refresh</button>
          </div>
          <div id="taskRuns" class="agentRuns empty">No active tasks</div>
        </section>
        <section class="workflowPanel">
          <div class="sectionHeader">
            <h2>Workflow Packs</h2>
            <button id="refreshWorkflowsBtn" type="button">Refresh</button>
          </div>
          <div id="workflowPacks" class="agentRuns empty">No workflow packs loaded</div>
        </section>
        <section class="artifactPanel">
          <div class="sectionHeader">
            <h2>Artifacts</h2>
            <button id="refreshArtifactsBtn" type="button">Refresh</button>
          </div>
          <div id="artifactList" class="artifactList empty">No artifacts yet</div>
        </section>
        <section class="agentRunsPanel">
          <div class="sectionHeader">
            <h2>Codex Runs</h2>
            <button id="refreshAgentRunsBtn" type="button">Refresh</button>
          </div>
          <div id="agentRuns" class="agentRuns empty">No coding agent runs</div>
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
};
