# Milestone 4: Desktop Context Snapshot

## Goal

Give Her a compact local context layer so it can understand "this", "that", and "current task" without leaking secrets or guessing beyond available evidence.

## Scope

1. Add a main-process desktop snapshot service.
2. Capture frontmost app and window title when the platform supports it.
3. Treat selected text capture as unsupported until Her has a safe reader that does not mutate clipboard state.
4. Capture clipboard as a bounded summary, redacting secret-like content.
5. Capture recent allowlisted file metadata without reading file contents.
6. Expose `/api/context/snapshot` behind existing local API auth.
7. Add a renderer context strip for current app/window, clipboard status, and recent file count.
8. Return compact context metadata from Realtime bundle selection.
9. Keep context collection failure non-fatal.

## Automatic Acceptance

- `npm run typecheck` passes.
- `npm run test` passes.
- `npm run build` passes.
- `npm run check` passes.
- `npm run smoke:m2` passes.
- `npm run smoke:m3` passes.
- `npm run smoke:m4` passes.
- `npm run smoke:m4-5` passes.
- `/api/context/snapshot` requires local API auth.
- Secret-like clipboard or selection content is redacted.
- Recent files include metadata only, not file contents.
- Renderer shows app/window context when available.
- Realtime bundle selection can receive compact context metadata.
- Context collection failures degrade gracefully into `failures`.

## Scenario Tests

1. Focus Finder and verify the context strip shows Finder or an unavailable state without crashing.
2. Copy a fake API key and verify `/api/context/snapshot` returns a redacted clipboard summary.
3. Put a file in an allowlisted directory and verify only metadata appears in recent files.
4. Focus a browser window and verify compact context can bias browser bundle routing.
5. Ask an ambiguous "delete that" style request and verify Her still asks for clarification unless the target is explicit.

## Exit Criteria

Her has a privacy-aware desktop context snapshot that can assist routing and UI awareness, while avoiding full document content, secret-like clipboard text, and unsafe selected-text capture.
