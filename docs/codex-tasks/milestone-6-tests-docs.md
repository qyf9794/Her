# Milestone 6: Tests, Docs, and Regression Gates

## Goal

Create a basic product-grade quality gate for Her.

## Scope

Implement:

1. Vitest setup.
2. Typecheck/test/check scripts.
3. Unit tests for policy, tools, auth, bundle routing, Codex parser.
4. Integration tests for local API auth and confirmation flow.
5. Manual smoke test docs.
6. Architecture/security/tool/runtime docs.

## Out of scope

Do not require OpenAI API key in default tests.
Do not run real Codex in default tests.
Do not require platform-specific GUI automation in CI.

## Required scripts

Add when ready:

```json
{
  "typecheck": "tsc --noEmit && tsc -p electron/tsconfig.json --noEmit",
  "test": "vitest run",
  "test:watch": "vitest",
  "check": "npm run typecheck && npm run test && npm run build"
}
```

## Unit test targets

- Path allowlist.
- CapabilityGate.
- ApprovalPolicy.
- Tool manifest uniqueness.
- Tool bundle router.
- Env sanitizer.
- Audit redaction.
- Local API auth middleware.
- Confirmation queue expiration.
- Codex JSONL parser.

## Integration test targets

- `/api/tools/execute` without token → 401.
- Invalid token → 401.
- Disabled capability → denied.
- High-risk tool → confirmation.
- Approve confirmation → executes.
- Reject confirmation → does not execute.
- Malformed tool args → invalid_arguments.

## Docs to add

```text
docs/
  architecture.md
  security.md
  tool-runtime.md
  realtime-runtime.md
  coding-agent.md
  packaging.md
  manual-smoke-test.md
```

## Manual smoke checklist

Include:

1. Start app.
2. Connect voice.
3. Ask system_status.
4. Ask list Desktop.
5. Ask create folder.
6. Reject confirmation.
7. Approve confirmation.
8. Disable fileManagement.
9. Enable YOLO with expiry.
10. Start coding agent plan task.

## Acceptance criteria

- `npm run check` passes.
- Default tests do not require OpenAI key.
- Default tests do not require real Codex CLI.
- Manual smoke test document exists.
- Architecture and security docs exist.
- At least core unit/integration tests cover auth, policy, tool manifest, and bundle router.

## Completion report

Report:

- Tests added.
- Docs added.
- Commands run.
- Any tests skipped and why.
