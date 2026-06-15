# Milestone 3: Policy Engine 2.0 and Rich Confirmation Plans

## Goal

Upgrade confirmation from "approve this tool name" to "approve this auditable action plan".

This milestone is limited to policy metadata, YOLO expiry, confirmation API/UI, and task timeline propagation. It must not implement desktop context snapshots, artifact workspaces, or new Codex worktree flows.

## Scope

1. Add rich `ActionPlan` metadata:
   - risk
   - reader-facing risk label
   - target
   - preview
   - reversibility
   - expiry
   - task binding
   - policy rationale
2. Add risk-specific policy naming for:
   - path policy
   - external-send policy
   - browser-submit policy
   - shell policy
   - coding-agent policy
   - system-change policy
3. Add YOLO TTL support.
4. Keep YOLO unable to bypass shell, browser submit, external send, system change, or coding-agent actions.
5. Expose rich pending confirmation records through the local API.
6. Render risk, target, preview, expiry, and policy rationale in the confirmation UI.
7. Persist confirmation-required task events with risk and target.
8. Preserve existing confirmation approval and rejection behavior.

## Automatic Acceptance

- `npm run typecheck` passes.
- `npm run test` passes.
- `npm run build` passes.
- `npm run check` passes.
- `npm run smoke:m2` passes.
- `npm run smoke:m3` passes.
- `npm run smoke:m4` passes.
- `npm run smoke:m4-5` passes.
- YOLO cannot bypass shell, browser submit, external send, system change, or coding-agent.
- Expired YOLO cannot bypass local-write confirmation.
- Pending confirmation records expose risk, risk label, target, preview, expiry, reversibility, policy rationale, and task binding when available.
- Expired confirmations cannot be approved.
- Rejected confirmations do not execute handlers.
- Approved confirmations execute the original validated action plan.
- Task timeline records confirmation-required events with risk and target for task-managed tools.
- Audit details redact secret-like fields inside action-plan-shaped objects.

## Scenario Tests

1. Ask Her to send an email draft and verify external-send confirmation appears.
2. Ask Her to fill a form and click submit; verify submit requires browser-submit confirmation.
3. Ask Her to run `npm run build`; verify shell confirmation appears.
4. Enable YOLO and verify a low-risk local write may bypass confirmation before TTL expiry.
5. Verify shell still requires confirmation under YOLO.
6. Wait for confirmation expiry and verify approve fails safely.
7. Trigger a task-managed file rename and verify the Task Panel shows awaiting confirmation.

## Changed Areas

- `src/main/policy/approval-policy.ts`
- `src/main/tools/runtime.ts`
- `src/main/tools/confirmation.ts`
- `src/main/tools/registry.ts`
- `src/main/tasks/task-queue.ts`
- `src/main/server.ts`
- `src/shared/tools.ts`
- `src/shared/tasks.ts`
- `src/renderer/app.ts`
- `src/renderer/styles.css`
- `tests/unit/core-runtime.test.ts`
- `tests/integration/local-api.test.ts`
- `scripts/smoke-m2-manifest-policy.mjs`
- `scripts/smoke-m4-5-task-runtime.mjs`

## Exit Criteria

The user can see what exact action Her wants to run, why policy requires approval, what target will be affected, when the request expires, and whether the request belongs to a task before approving or rejecting it.
