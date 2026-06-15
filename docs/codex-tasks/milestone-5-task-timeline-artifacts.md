# Milestone 5: Unified Task Timeline and Artifact Workspace

## Goal

Make task results visible, reviewable, persistent, and recoverable outside the voice transcript.

## Scope

1. Add a persisted artifact store.
2. Add artifact records with:
   - type
   - title
   - summary
   - source tool
   - source task when available
   - createdAt
   - redacted payload
3. Generate artifacts for:
   - file search results
   - document extracts and folder digests
   - document edit previews
   - browser page snapshots
   - shell command output
   - coding-agent results
4. Add task timeline `artifact_created` events for task-managed artifacts.
5. Expose artifact list and read APIs behind local API auth.
6. Add renderer artifact workspace with show and copy-summary actions.
7. Keep voice/tool responses concise when visual artifacts exist.

## Automatic Acceptance

- `npm run typecheck` passes.
- `npm run test` passes.
- `npm run build` passes.
- `npm run check` passes.
- `npm run smoke:m2` passes.
- `npm run smoke:m3` passes.
- `npm run smoke:m4` passes.
- `npm run smoke:m4-5` passes.
- Task events are persisted and redacted.
- Artifacts are persisted and redacted.
- Artifacts expose type, title, source tool, optional source task, createdAt, and payload.
- Large artifacts are marked truncated.
- Renderer can display table, text, diff, and command-output payloads.

## Scenario Tests

1. Search files and verify a table artifact appears.
2. Extract a document and verify a document summary artifact appears.
3. Run a shell command and verify command output appears as a task-linked artifact after confirmation.
4. Start a coding-agent task and verify a coding artifact appears when complete.
5. Restart app and verify recent artifacts are still listed.

## Exit Criteria

Her behaves like a local workbench: voice can stay brief while detailed results remain available in a persistent artifact workspace.
