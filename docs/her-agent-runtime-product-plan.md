# Her Agent Runtime Product Plan

## 1. Product Thesis

Her should not be positioned as a better Siri or a voice wrapper around Codex.

Her is a local desktop Agent Runtime with a Realtime voice interface. Its job is to understand the user's current desktop context, turn requests into auditable local actions, enforce policy and confirmations, run long tasks safely, and delegate coding work to Codex as an asynchronous specialist.

```text
Her = Realtime voice interface
    + desktop context layer
    + local tool runtime
    + policy and confirmation engine
    + task runtime
    + artifact/result workspace
    + Codex coding-agent delegate
```

## 2. Differentiation

### Compared With Siri

Siri is primarily a system assistant and service launcher. Her should be a desktop workflow runtime.

Her should win on:

- visible task state
- local workflow continuity
- rich confirmation previews
- file, browser, app, document, and coding context
- long-running work with cancellation and result review
- local audit trail and policy enforcement

### Compared With Voice Codex

Voice Codex would still be centered on code. Her is centered on the user's local desktop.

Her should treat Codex as one worker inside a larger runtime:

- Her owns permission and confirmation.
- Her owns desktop state and task history.
- Her decides when a coding task is appropriate.
- Codex runs asynchronously in isolated worktrees.
- Codex results return as artifacts for user review.

## 3. Product Principles

- Voice is the fastest input, not the whole product.
- The renderer is not a security boundary.
- Every side effect is policy-gated.
- High-risk actions need preview and explicit confirmation.
- Long tasks should never block Realtime conversation.
- Tool definitions should have one source of truth.
- The user should always know what Her is doing, waiting for, and able to undo.
- Codex is not a shell escape hatch.
- Local context and memory must never become a secret store.

## 4. Target Architecture

```text
src/
  main/
    app/
      window.ts
      protocol.ts
      navigation-policy.ts
      permissions.ts

    api/
      server.ts
      auth.ts
      cors.ts
      routes/
        realtime.routes.ts
        tools.routes.ts
        tasks.routes.ts
        confirmations.routes.ts
        settings.routes.ts
        context.routes.ts

    context/
      desktop-snapshot.ts
      active-app.ts
      selected-text.ts
      clipboard.ts
      recent-files.ts

    realtime/
      session-service.ts
      bundle-router.ts
      intent-router.ts
      response-control.ts

    tools/
      runtime.ts
      manifest.ts
      policy-bridge.ts
      domains/
        filesystem.ts
        documents.ts
        desktop.ts
        browser.ts
        comms.ts
        media.ts
        coding.ts

    policy/
      approval-policy.ts
      risk-classifier.ts
      action-plan.ts
      path-policy.ts
      external-send-policy.ts
      audit-log.ts

    tasks/
      task-store.ts
      task-queue.ts
      resource-lock-manager.ts
      timeline.ts
      artifacts.ts

    agents/
      coding-agent/
        runtime.ts
        worktree-manager.ts
        env-sanitizer.ts
        artifact-adapter.ts
        result-review.ts

  renderer/
    app.ts
    state/
      session-store.ts
      task-store.ts
      confirmation-store.ts
      context-store.ts
    components/
      voice-stage.ts
      transcript.ts
      confirmation-panel.ts
      task-panel.ts
      artifact-viewer.ts
      context-strip.ts
      settings-panel.ts
```

## 5. Product Pillars

### 5.1 Desktop Context Layer

Her should maintain a compact, privacy-aware desktop snapshot:

- frontmost app
- active window title
- selected text when available
- clipboard summary
- recent files in allowlisted folders
- current media state
- isolated browser state
- current task and pending confirmation state

This layer lets Her understand requests like "summarize this", "move that file", or "keep these windows and hide the rest" without guessing blindly.

### 5.2 Safe Action Runtime

Her should convert every executable request into an action plan:

- tool name
- arguments
- risk
- capability required
- app/path target
- preview
- reversibility
- expiry
- task binding

The runtime should execute only after validation, policy, and confirmation rules pass.

### 5.3 Long-Running Task Runtime

Her should make tasks first-class:

- queued/running/blocked/awaiting confirmation/completed/failed/cancelled
- resource locks
- cancellation
- events
- artifacts
- retry policy
- voice status summaries
- renderer task panel

Realtime stays responsive while tasks run.

### 5.4 Artifact Workspace

Results should be visual and reviewable when voice is not enough:

- file search results
- document summaries
- browser research cards
- mail drafts
- calendar proposals
- Codex diffs
- command output
- test results

Voice gives the short answer. The workspace shows the details.

### 5.5 Codex Delegation

Her should delegate coding tasks to Codex only when appropriate:

- codebase analysis
- review
- patch
- test-fix
- documentation generation

Codex must run in an isolated worktree with sanitized environment variables. Results should return as artifacts, not just plain text.

## 6. Milestone Roadmap

## Milestone 0: Stabilize Baseline and Quality Gate

### Goal

Make the current app verifiable before deeper product changes.

### Scope

- Ensure dependencies install cleanly.
- Make `npm run check` pass.
- Fix obvious TypeScript/compiler errors in the current renderer.
- Preserve existing voice, tools, confirmation, task, and Codex behavior.
- Document baseline smoke commands.

### Automatic Acceptance

- `npm run typecheck` passes.
- `npm run test` passes.
- `npm run build` passes.
- `npm run check` passes.
- `npm run smoke:m2` passes if available.
- `npm run smoke:m3` passes if available.
- `npm run smoke:m4` passes if available.
- No new secret-like strings appear in build output, test snapshots, audit fixtures, or renderer logs.

### Scenario Tests

- Start app, connect voice, ask "系统状态".
- Ask Her to list Desktop files.
- Ask Her to create a folder, reject confirmation, verify no folder is created.
- Ask again, approve confirmation, verify folder exists.
- Ask Her to start a coding-agent plan task and verify it appears as a task without blocking voice.

### Exit Criteria

The project has a known-good baseline and all future milestones can be measured against it.

## Milestone 1: Renderer Decomposition and Runtime UI Shell

### Goal

Turn the renderer from a large script into a maintainable product UI shell.

### Scope

- Split voice stage, transcript, confirmation panel, task panel, agent runs panel, settings panel, and artifact viewer into modules.
- Keep the current visual design unless a change is required for the split.
- Move local API calls through typed client helpers.
- Remove duplicated renderer logic.
- Keep `src/renderer/main.ts` as bootstrap plus wiring.

### Automatic Acceptance

- `npm run check` passes.
- `src/renderer/main.ts` is under 350 lines.
- No direct `fetch("http://127.0.0.1` usage exists in renderer code.
- All renderer local API calls go through the local API client.
- Existing Realtime connection flow still works.
- Pending confirmations render after a page reload.
- Task polling still renders recent tasks.

### Scenario Tests

- Connect and disconnect a voice session three times.
- Trigger a high-risk file action and confirm the confirmation card appears.
- Reject from the confirmation panel and verify the transcript receives the rejection result.
- Start a coding task and verify the task panel updates while voice remains connected.
- Switch orb-only mode and restore the full panel.

### Exit Criteria

The UI can evolve into a product workspace without edits landing in a 2000-line renderer file.

## Milestone 2: Tool Runtime Decomposition

### Goal

Make the manifest the true single source of tool behavior, not just metadata.

### Scope

- Extract `ToolRuntime` from the current registry.
- Move domain handlers into domain modules.
- Keep legacy behavior through adapters where needed.
- Remove duplicate tool grouping/risk logic outside the manifest.
- Add manifest-level tests for schema, risk, capability, bundle, and handler coverage.

### Automatic Acceptance

- `npm run check` passes.
- Every manifest tool has a schema, risk, bundle, summary, and handler.
- Tool names are unique.
- Unknown tools return `unknown_tool`.
- Malformed arguments return `invalid_arguments`.
- High-risk tools create action plans instead of executing immediately.
- Read-only tools execute without confirmation when capability allows.
- No domain handler imports renderer code.

### Scenario Tests

- Execute `system_status` and verify no confirmation is created.
- Execute `file_create_folder` and verify confirmation is created.
- Execute malformed `file_list` arguments and verify validation error.
- Disable file capability, execute `file_list`, verify denial.
- Add a temporary test-only tool in one manifest and verify generated Realtime definition and schema validation.

### Exit Criteria

Adding a tool means editing one manifest/domain file, not several unrelated lists.

## Milestone 3: Policy Engine 2.0 and Rich Confirmation Plans

### Goal

Upgrade confirmation from "approve tool name" to "approve action plan".

### Scope

- Add typed `ActionPlan` with risk, target, preview, reversibility, expiry, task binding, and policy rationale.
- Add path policy, external-send policy, browser-submit policy, shell policy, and coding-agent policy.
- Add YOLO TTL and risk-specific bypass rules.
- Upgrade confirmation API and UI to show risk badges, target, preview, and expiry.
- Persist confirmation events in task timeline.

### Automatic Acceptance

- `npm run check` passes.
- YOLO cannot bypass shell, browser submit, external send, system change, or coding-agent.
- Confirmation records expose risk, summary, expiry, and preview.
- Expired confirmations cannot be approved.
- Rejected confirmations do not execute handlers.
- Approved confirmations execute the original validated action plan.
- Audit logs redact secret-like action plan fields.

### Scenario Tests

- Ask Her to send an email draft and verify external-send confirmation.
- Ask Her to fill a form and click submit; verify submit requires browser-submit confirmation.
- Ask Her to run `npm run build`; verify shell confirmation appears.
- Enable YOLO with TTL and verify low-risk local write may bypass confirmation.
- Verify shell still requires confirmation under YOLO.
- Wait for confirmation expiry and verify approve fails safely.

### Exit Criteria

Users can understand exactly what they are approving before Her touches files, apps, browser pages, shell, or Codex.

## Milestone 4: Desktop Context Snapshot

### Goal

Give Her a local context layer that lets it understand "this", "that", and "current task" safely.

### Scope

- Add main-process desktop snapshot service.
- Capture frontmost app and window title.
- Capture selected text where safe and platform-supported.
- Capture clipboard summary without storing full sensitive payloads by default.
- Capture recent allowlisted files.
- Expose `/api/context/snapshot`.
- Add context strip to renderer.
- Add context snapshot to Realtime routing metadata without exposing secrets.

### Automatic Acceptance

- `npm run check` passes.
- `/api/context/snapshot` requires local API auth.
- Snapshot redacts secret-like clipboard/selection content.
- Snapshot does not include full document contents by default.
- Renderer shows current app/window when available.
- Realtime intent routing can receive compact context metadata.
- Context collection failures degrade gracefully.

### Scenario Tests

- Focus Finder, ask "这里有什么文件", verify Her uses current folder only if it can resolve it safely.
- Select text in a document, ask "总结这段", verify selected text is used only after clear user intent.
- Copy a fake API key, verify context snapshot redacts it.
- Focus a browser window, ask "这个页面之后帮我处理", verify Her records page/window context but does not submit anything.
- Ask ambiguous "删掉那个", verify Her asks for clarification.

### Exit Criteria

Her becomes context-aware without becoming careless or secret-leaky.

## Milestone 5: Unified Task Timeline and Artifact Workspace

### Goal

Make tasks and results visible, reviewable, and recoverable.

### Scope

- Add task timeline events for tools, confirmations, Codex, browser, files, and errors.
- Add artifact store for structured results.
- Add artifact viewer in renderer.
- Convert file search, document digest, browser research, command output, and Codex result into artifacts.
- Add "show result" and "copy summary" actions.

### Automatic Acceptance

- `npm run check` passes.
- Task events are persisted and redacted.
- Artifacts have type, title, source task, createdAt, and redacted payload.
- Large artifacts are truncated or stored by handle.
- Renderer can display at least table, text, diff, and command-output artifacts.
- Voice response stays concise when a visual artifact is available.

### Scenario Tests

- Search files and verify a result artifact appears.
- Summarize a PDF and verify a document summary artifact appears.
- Run a shell command and verify output appears in a command artifact after confirmation.
- Start a Codex review and verify a coding artifact appears when complete.
- Restart app and verify recent task history and artifacts are still available.

### Exit Criteria

Her feels like a workbench, not just a voice transcript.

## Milestone 6: Codex Delegation Artifacts and Review Flow

### Goal

Turn Codex integration into a safe delegated coding workflow.

### Scope

- Add Codex artifact adapter for diff, changed files, tests, summary, and follow-up suggestions.
- Add UI for reviewing Codex worktree output.
- Add apply/merge workflow gated by confirmation.
- Add continue/cancel controls.
- Add repo resource locking and conflict visibility.
- Keep Codex in isolated worktrees by default.

### Automatic Acceptance

- `npm run check` passes.
- Codex child process receives sanitized env only.
- Plan/review modes use read-only sandbox.
- Patch/test-fix modes use workspace-write inside isolated worktree.
- Applying Codex output to the original repo requires explicit confirmation.
- Two Codex tasks for the same repo cannot write concurrently.
- Cancelling a running Codex task updates both coding-agent status and Her task status.

### Scenario Tests

- Start "review this repo" and verify no files are modified in the original checkout.
- Start "fix failing tests" and verify Codex runs in worktree.
- Cancel a running task and verify status is cancelled.
- Start two patch tasks for the same repo and verify the second waits on repo lock.
- Approve applying a small diff and verify the original repo changes only after confirmation.

### Exit Criteria

Her can safely use Codex as a coding worker without becoming "voice Codex".

## Milestone 7: Workflow Skills and Local Memory

### Goal

Let users teach Her reusable local workflows without storing secrets.

### Scope

- Productize aliases into "Her Skills".
- Support skill templates with parameters.
- Add skill preview before save.
- Add skill permissions and risk metadata.
- Add explicit remember/forget commands.
- Prevent secret-like values in skills and memory.

### Automatic Acceptance

- `npm run check` passes.
- Creating a skill requires confirmation.
- Skills cannot store secret-like keys or values.
- Skill execution goes through the same tool runtime and policy engine.
- Skill list, inspect, run, and delete are covered by tests.
- Memory status clearly shows what Her remembers.

### Scenario Tests

- "以后我说准备开会，就打开日历、打开会议笔记、把窗口平铺" creates a skill preview.
- Approve saving the skill, run it, verify each action is policy-gated.
- Try to save a skill containing an API key and verify it is rejected.
- Forget a skill and verify it can no longer run.
- Ask "你记住了什么" and verify a compact memory status answer.

### Exit Criteria

Her becomes personalized through safe local workflows, not opaque memory.

## Milestone 8: Focus Modes and Desktop Workflow Packs

### Goal

Ship signature workflows that make Her visibly different from Siri and Codex.

### Scope

- Add built-in workflow packs:
  - Focus Writing
  - Meeting Prep
  - Research Desk
  - Coding Session
  - File Cleanup
- Each pack is a task group with previews, locks, and rollback notes.
- Add UI entry points and voice routing.

### Automatic Acceptance

- `npm run check` passes.
- Each workflow pack has a manifest, required capabilities, risks, and scenario tests.
- Workflow packs create grouped tasks, not hidden chains of tool calls.
- High-risk steps still require confirmation.
- Users can cancel the group.
- Partial failure is visible in the timeline.

### Scenario Tests

- "进入写作模式" arranges windows, opens notes, optionally starts music, and shows a grouped task.
- "准备开会" proposes calendar, notes, documents, and app setup before acting.
- "开始 coding session" opens repo context, starts a Codex plan if requested, and keeps voice responsive.
- "清理桌面文件" shows a preview before moving/trashing anything.
- Cancel midway and verify completed and skipped steps are visible.

### Exit Criteria

Her has memorable product behaviors instead of only a large tool catalog.

## Milestone 9: Electron Production Security and Distribution

### Goal

Prepare Her for real local installation and distribution.

### Scope

- Replace long-term `file://` production loading with custom protocol.
- Add strict CSP.
- Restrict navigation and `shell.openExternal`.
- Harden permission requests.
- Complete signing/notarization placeholders.
- Improve auto-update channel skeleton.

### Automatic Acceptance

- `npm run check` passes.
- Renderer has no Node access.
- `window.require`, `process`, and `Buffer` are unavailable.
- Non-Her navigation is blocked.
- External open allows only safe HTTPS URLs.
- `javascript:`, `file:`, and unknown protocols are blocked.
- Packaged app starts and local API auth still works.
- No signing secrets are hardcoded.

### Scenario Tests

- Open a malicious external URL and verify navigation is blocked or opened safely externally.
- Try to open `javascript:` and verify it is blocked.
- Try to call local API from an arbitrary web page and verify 403/401.
- Package app locally and connect voice.
- Verify microphone permission prompts only from trusted Her window.

### Exit Criteria

Her is ready for trusted local distribution without weakening the runtime boundary.

## Milestone 10: Beta Readiness and Product Telemetry

### Goal

Make Her usable by real beta users while preserving local privacy.

### Scope

- Add local-only diagnostics export.
- Add manual smoke checklist.
- Add onboarding for API key, microphone, permissions, Codex login, and first workflow.
- Add failure recovery UI.
- Add privacy statement for what stays local.
- Add beta feedback export that excludes secrets by default.

### Automatic Acceptance

- `npm run check` passes.
- Onboarding can be completed from a fresh userData directory.
- Diagnostics export redacts secrets.
- Manual smoke checklist passes.
- Failed Realtime, failed tool, failed Codex, and failed packaging paths show clear user-facing messages.
- No test requires a real OpenAI key or real Codex by default.

### Scenario Tests

- Fresh install: configure key, choose voice, authorize mic, run system status.
- Missing OpenAI key: user sees clear setup path.
- Missing Codex login: coding tasks fail with clear provider message and no silent fallback.
- Failed tool confirmation: user can retry from task panel.
- Export diagnostics and verify no API keys, tokens, cookies, or full sensitive clipboard values appear.

### Exit Criteria

Her is coherent enough for beta users to try without a developer watching over their shoulder.

## 7. Cross-Milestone Regression Matrix

Every milestone should preserve these scenarios:

- Voice connects and disconnects cleanly.
- Realtime can call `system_status`.
- Dynamic bundle selection does not expose all tools by default.
- Unknown tools are rejected.
- Disabled capabilities deny execution.
- High-risk tools require confirmation.
- Rejected confirmations do not execute side effects.
- YOLO does not bypass dangerous categories.
- Task runtime does not block immediate read/media actions.
- Codex does not receive Her local API token or Realtime secrets.
- Codex does not modify the original repo unless a future apply step is explicitly approved.
- Renderer never receives `OPENAI_API_KEY`.
- Arbitrary webpages cannot call Her local APIs.

## 8. Recommended Near-Term Sequence

1. Stabilize baseline and make `npm run check` pass.
2. Split renderer into product UI modules.
3. Split tool runtime from the current registry.
4. Upgrade policy and confirmation plans.
5. Add desktop context snapshot.
6. Build artifact workspace.
7. Upgrade Codex result review flow.

This order keeps the existing product usable while moving Her toward its actual differentiation: a safe, visible, local desktop agent runtime.
