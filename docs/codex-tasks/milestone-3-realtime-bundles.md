# Milestone 3: Realtime Runtime and Dynamic Tool Bundles

## Goal

Move toward product-grade Realtime orchestration using core tools plus dynamic domain bundles.

## Scope

Implement:

1. RealtimeSessionService.
2. Tool bundle definitions.
3. Local bundle router.
4. Core tools always available.
5. `her_select_bundle` fallback.
6. Manual `response.create` flow after transcript-ready.
7. Optional server-mediated Realtime session if Milestone 1 security foundation is ready.

## Out of scope

Do not implement:

- Codex coding-agent runtime.
- Full UI redesign.
- Electron Forge packaging.
- Complete React migration.

## Required implementation details

### Core tools

Always expose:

- `system_status`
- `confirmation_list`
- `confirmation_decide`
- `app_permission_search`
- `app_permission_set`
- `capability_set`
- `yolo_mode_set`
- `her_select_bundle`

### Bundles

Define:

```ts
type ToolBundleName =
  | "core"
  | "file"
  | "document"
  | "desktop"
  | "browser"
  | "comms"
  | "media"
  | "system"
  | "coding";
```

### Bundle router

Create `src/main/agent/tool-bundle-router.ts`.

MVP deterministic rules:

- file/document terms → file + document
- browser/form/click/web terms → browser
- email/calendar/meeting/draft/publish terms → comms
- music/video/YouTube/movie terms → media
- window/app/arrange/desktop terms → desktop/system
- code/repo/test/PR/Codex terms → coding

Low confidence should use core + `her_select_bundle`.

### Realtime turn control

Move toward:

```ts
turn_detection: {
  type: "server_vad",
  create_response: false,
  interrupt_response: true
}
```

Flow:

```text
input_audio_transcription.completed
↓
select bundle
↓
session.update(tools)
↓
response.create
```

## Suggested implementation path

1. Add bundle definitions without changing Realtime behavior.
2. Add local bundle router and tests.
3. Add `her_select_bundle`.
4. Add `session.update` helper.
5. Change `create_response` to false.
6. Wire transcript-ready → bundle update → response.create.
7. Verify voice latency and tool calls.

## Acceptance criteria

- Realtime voice session still connects.
- Barge-in / interrupt still works.
- Common transcript examples select correct bundles.
- Her does not default to exposing all tools after bundle switching is enabled.
- Low-confidence transcript can fallback to `her_select_bundle`.
- High-risk tools still go through Policy Engine.
- `npm run build` passes.
- Tests cover bundle selection.

## Suggested files to inspect

- `src/main/realtime.ts`
- `src/renderer/main.ts`
- `src/shared/tools.ts`
- `src/main/tools/manifest.ts`
- `src/main/tools/bundles.ts`

## Completion report

Report:

- How tools are selected.
- Whether `create_response=false` is enabled.
- Voice/tool smoke test result.
- Remaining latency or routing risks.
