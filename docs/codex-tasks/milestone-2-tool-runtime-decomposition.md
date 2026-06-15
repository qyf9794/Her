# Milestone 2: Tool Runtime Decomposition

## Goal

Make the Tool Manifest the true entrypoint for tool execution by extracting the common execution pipeline out of `ToolRegistry`.

The registry may still host legacy domain implementations in this milestone, but schema validation, capability checks, approval policy, confirmation creation, timeout handling, audit, and result compaction should flow through `ToolRuntime`.

## Scope

Implement only:

1. Add `src/main/tools/runtime.ts`.
2. Move common tool execution responsibilities into `ToolRuntime`.
3. Keep legacy domain tool behavior behind manifest-bound handlers.
4. Keep task runtime, Realtime tools, and confirmation behavior unchanged.
5. Strengthen smoke coverage so the extracted runtime is verified.

## Out of scope

Do not implement:

- Policy Engine 2.0 rich action plans.
- Desktop context snapshot.
- Artifact workspace.
- Codex apply/review workflow.
- UI redesign.
- Broad domain handler rewrites.

## Automatic Acceptance

Run these commands before ending M2:

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

- `ToolRuntime` is exported from `src/main/tools/runtime.ts`.
- `ToolRegistry` delegates approval and timeout execution to `ToolRuntime`.
- All manifest tools still have schema, risk, bundle, summary, and handler.
- Unknown tools return `unknown_tool`.
- Malformed arguments return `invalid_arguments`.
- Read-only tools execute without confirmation when capability allows.
- High-risk tools require confirmation directly or through TaskRuntime awaiting confirmation.
- Disabled capabilities deny execution.
- Unauthorized apps deny execution.
- Existing smoke scripts pass.

## Manual Scenario Tests

Use `docs/manual-smoke-test.md` as the full checklist. For M2, at minimum verify:

1. Ask `system_status` and verify no confirmation appears.
2. Ask to create a Desktop folder and verify confirmation appears.
3. Reject the confirmation and verify no side effect occurs.
4. Disable file management and verify file tools are denied.
5. Ask to run a safe shell command and verify shell confirmation still appears.

If a manual scenario is skipped, record why in the milestone completion report.

## Completion Report

After implementation, report:

- Changed files.
- Commands run.
- Automatic acceptance result.
- Manual scenario result or skipped reason.
- Remaining risks.
- Follow-up tasks for M3.
