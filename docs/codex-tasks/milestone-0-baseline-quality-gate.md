# Milestone 0: Baseline Quality Gate

## Goal

Create a known-good baseline before implementing the Her Agent Runtime milestones.

This milestone does not change runtime behavior. It verifies that dependencies, typecheck, tests, build, and existing smoke scripts are healthy enough to support the M1-M10 sequence.

## Scope

Implement only:

1. Restore/install dependencies from `package-lock.json`.
2. Verify the current source compiles and tests pass.
3. Document the baseline acceptance commands.
4. Document the manual smoke scenarios that must remain true across later milestones.
5. Keep existing voice, tools, confirmations, tasks, Codex, packaging, and local API behavior unchanged.

## Out of scope

Do not implement:

- Renderer decomposition.
- Tool runtime decomposition.
- Policy Engine 2.0.
- Desktop context snapshot.
- Artifact workspace.
- Codex apply/review workflow.
- Workflow skills.
- Focus modes.
- Production security refactor.
- Beta onboarding changes.

## Automatic Acceptance

Run these commands before ending M0:

```bash
npm ci
npm run typecheck
npm run test
npm run build
npm run check
npm run smoke:m2
npm run smoke:m3
npm run smoke:m4
```

Expected:

- `npm ci` restores `node_modules` from the lockfile.
- `npm run typecheck` passes.
- `npm run test` passes.
- `npm run build` passes.
- `npm run check` passes.
- `npm run smoke:m2` passes.
- `npm run smoke:m3` passes.
- `npm run smoke:m4` passes.
- Build output does not expose `OPENAI_API_KEY`, Realtime secrets, local API tokens, OAuth tokens, cookies, or credentials.

## Manual Scenario Tests

Use `docs/manual-smoke-test.md` as the full checklist. For M0, at minimum verify:

1. Start the app with `npm run dev`.
2. Connect voice.
3. Ask `system_status`.
4. Ask Her to list Desktop files.
5. Ask Her to create a folder on Desktop.
6. Reject the confirmation and verify the folder is not created.
7. Ask again, approve the confirmation, and verify the folder is created.
8. Start a coding-agent plan task and verify it appears as a task without blocking voice.

If a manual scenario is skipped, record why in the milestone completion report.

## Completion Report

After implementation, report:

- Changed files.
- Commands run.
- Results of automatic acceptance.
- Manual scenario result or skipped reason.
- Remaining risks.
- Follow-up tasks for M1.
