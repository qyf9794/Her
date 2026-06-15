# Milestone 8: Focus Modes and Desktop Workflow Packs

## Goal

Ship signature workflows that make Her visibly different from Siri and Codex.

## Scope

1. Add built-in workflow pack manifests:
   - Focus Writing
   - Meeting Prep
   - Research Desk
   - Coding Session
   - File Cleanup
2. Each pack must expose:
   - id, title, description
   - trigger phrases
   - required capabilities
   - risks
   - ordered steps
   - rollback notes
3. Add workflow preview/list/inspect/run/cancel/status tools.
4. Workflow runs must create grouped task records with visible events.
5. Workflow steps must execute through the normal tool runtime so high-risk steps still require confirmation.
6. Add scenario coverage for pack metadata, run/cancel behavior, and partial failure visibility.

## Out of Scope

- Do not implement custom visual workflow designer.
- Do not implement remote calendar/email provider setup.
- Do not bypass existing tool confirmation, app permissions, or capability gates.
- Do not implement M9 Electron security work.

## Automatic Acceptance

- `npm run typecheck` passes.
- `npm run test` passes.
- `npm run build` passes.
- `npm run check` passes.
- Each pack has manifest metadata, required capabilities, risks, and rollback notes.
- Workflow packs create grouped task runs with visible step events.
- High-risk steps still require confirmation.
- Users can cancel a workflow run.
- Partial failure is visible in workflow run status.

## Scenario Tests

1. Preview Focus Writing and verify window/note/file setup steps.
2. Preview Meeting Prep and verify calendar/note/app setup steps.
3. Preview Research Desk and verify browser/document setup steps.
4. Preview Coding Session and verify repo/Codex setup steps.
5. Preview File Cleanup and verify it never trashes files without confirmation.
6. Run and cancel a workflow pack and verify cancelled/skipped steps are visible.
7. Run a workflow with a high-risk step and verify it returns `awaiting_confirmation`.

## Exit Criteria

Her has memorable, reviewable desktop workflow packs instead of only a large tool catalog.
