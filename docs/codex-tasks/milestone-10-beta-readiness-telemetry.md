# Milestone 10: Beta Readiness and Product Telemetry

## Goal

Make Her coherent enough for beta users to try without a developer watching over their shoulder, while preserving local privacy.

## Scope

1. Add local-only diagnostics export.
2. Add manual smoke checklist.
3. Add onboarding/setup status for API key, microphone, permissions, Codex login, and first workflow.
4. Add failure recovery UI for common setup/runtime failures.
5. Add a privacy statement for what stays local.
6. Add beta feedback export that excludes secrets by default.

## Out of Scope

- Do not add remote telemetry or automatic analytics upload.
- Do not require a real OpenAI key or real Codex login in automated tests.
- Do not weaken local API auth, CORS, Electron security, or confirmation policy.

## Automatic Acceptance

- `npm run typecheck` passes.
- `npm run test` passes.
- `npm run build` passes.
- `npm run check` passes.
- Onboarding/setup status can render from a fresh userData directory.
- Diagnostics export redacts secrets.
- Beta feedback export redacts secrets.
- Manual smoke checklist exists and does not require secrets in the document.
- Failed Realtime, failed tool, failed Codex, and failed packaging paths have clear user-facing recovery text.
- No test requires a real OpenAI key or real Codex by default.

## Scenario Tests

1. Fresh install: configure key, choose voice, authorize mic, run `system_status`.
2. Missing OpenAI key: verify the setup panel shows the next step.
3. Missing Codex login: verify coding tasks fail with a provider message and no silent fallback.
4. Failed tool confirmation: verify the task panel keeps retry/review context visible.
5. Export diagnostics and verify no API keys, bearer tokens, cookies, local API tokens, or full sensitive clipboard values appear.
6. Export beta feedback with a fake secret and verify the file contains only redacted values.

## Exit Criteria

Her has a local privacy-preserving beta support loop: setup guidance, recovery hints, diagnostics, and feedback exports that users can inspect before sharing.
