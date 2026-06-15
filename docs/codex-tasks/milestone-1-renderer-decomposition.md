# Milestone 1: Renderer Decomposition and Runtime UI Shell

## Goal

Turn the renderer entrypoint from a large script into a small bootstrap and begin separating product UI shell concerns from runtime logic.

## Scope

Implement only:

1. Keep `src/renderer/main.ts` as a bootstrap entrypoint under 350 lines.
2. Move runtime wiring into `src/renderer/app.ts`.
3. Extract static product shell markup into a component module.
4. Extract typed DOM element lookup into a component module.
5. Preserve the current visual design and user-facing behavior.
6. Keep local API calls routed through `src/renderer/api/local-client.ts`.

## Out of scope

Do not implement:

- Tool runtime decomposition.
- Policy Engine 2.0.
- Desktop context snapshot.
- Artifact workspace.
- Codex apply/review workflow.
- New UI redesign.
- React migration.

## Automatic Acceptance

Run these commands before ending M1:

```bash
npm run typecheck
npm run test
npm run build
npm run check
npm run smoke:m2
npm run smoke:m3
npm run smoke:m4
```

Expected:

- `src/renderer/main.ts` is under 350 lines.
- Renderer local API calls go through `src/renderer/api/local-client.ts`.
- No renderer feature code directly calls `fetch("http://127.0.0.1...")`.
- Existing Realtime connection code still compiles.
- Pending confirmations and task panels still compile.
- Existing smoke scripts pass.

## Manual Scenario Tests

Use `docs/manual-smoke-test.md` as the full checklist. For M1, at minimum verify:

1. Start the app with `npm run dev`.
2. Complete onboarding or enter the app.
3. Connect and disconnect voice.
4. Trigger a high-risk file action and verify the confirmation panel appears.
5. Reject the confirmation and verify the UI clears the pending item.
6. Start a coding task and verify Tasks/Codex Runs still render.
7. Toggle orb-only mode and restore the full panel.

If a manual scenario is skipped, record why in the milestone completion report.

## Completion Report

After implementation, report:

- Changed files.
- Commands run.
- Automatic acceptance result.
- Manual scenario result or skipped reason.
- Remaining risks.
- Follow-up tasks for M2.
